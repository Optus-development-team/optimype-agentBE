import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Gemini,
  LlmAgent,
  Runner,
  isFinalResponse,
  stringifyContent,
} from '@google/adk';
import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestrationResult } from '../orchestrator.types';
import { SupabaseSessionService } from '../../session/supabase-session.service';
import type { OrchestratorConfig } from '../config/orchestrator.config';
import type { FormattedResponse } from '../../formatters/types/llm-response.types';
import { ORCHESTRATOR_INPUT_SCHEMA } from '../types/orchestrator-io.types';
import { resolveGeminiModelName } from '../../config/gemini-model.config';
import {
  buildTenantSessionId,
  normalizeAgentTreeRoots,
} from '../helpers/agent-tree.helper';

type AdkErrorEvent = {
  errorCode?: string;
  errorMessage?: string;
};

export abstract class BaseOrchestratorService implements OnModuleInit {
  protected readonly logger: Logger;
  protected readonly appName = 'optus';
  protected runner?: Runner;
  protected orchestratorAgent?: LlmAgent;

  protected constructor(
    loggerName: string,
    private readonly configService: ConfigService,
    private readonly sessionService: SupabaseSessionService,
    private readonly orchestratorConfig: OrchestratorConfig,
  ) {
    this.logger = new Logger(loggerName);
  }

  onModuleInit(): void {
    this.initialize();
  }

  async route(context: RouterMessageContext): Promise<OrchestrationResult> {
    this.ensureInitialized();

    if (this.orchestratorConfig.preRoute) {
      const preRouteResult = await this.orchestratorConfig.preRoute(context);
      if (preRouteResult) {
        return preRouteResult;
      }
    }

    const userId = this.normalizePhone(context.senderId);
    const sessionId = buildTenantSessionId(context.tenant.companyId, userId);

    await this.ensureSession(context, userId, sessionId);

    try {
      const userMessage = {
        role: 'user' as const,
        parts: [
          { text: JSON.stringify(this.orchestratorConfig.buildInput(context)) },
        ],
      };

      let responseText = '';
      let agentUsed = this.orchestratorConfig.getName();

      for await (const event of this.runner!.runAsync({
        userId,
        sessionId,
        newMessage: userMessage,
      })) {
        const adkError = event as AdkErrorEvent;
        if (adkError.errorCode || adkError.errorMessage) {
          throw new Error(
            `ADK event error ${adkError.errorCode ?? 'unknown'}: ${
              adkError.errorMessage ?? 'sin detalle'
            }`,
          );
        }

        if (event.author && event.author !== 'user') {
          agentUsed = event.author;
        }

        if (isFinalResponse(event)) {
          responseText = stringifyContent(event);
        }
      }

      if (!responseText.trim()) {
        this.logger.warn(
          `${this.orchestratorConfig.getName()} no devolvió texto final. Usando respuesta fallback.`,
        );
        responseText = this.orchestratorConfig.getErrorResponseText();
      }

      return {
        intent: this.orchestratorConfig.detectIntent(context.originalText),
        responseText,
        agentUsed,
        formattedResponse: this.buildFallbackFormattedResponse(responseText),
        sessionState: (
          await this.sessionService.getSession({
            appName: this.appName,
            userId,
            sessionId,
          })
        )?.state as Record<string, unknown>,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `${this.orchestratorConfig.getErrorLogPrefix()}: ${err.message}`,
      );
      return {
        intent: 'UNKNOWN',
        responseText: this.orchestratorConfig.getErrorResponseText(),
        agentUsed: this.orchestratorConfig.getName(),
        formattedResponse: this.buildFallbackFormattedResponse(
          this.orchestratorConfig.getErrorResponseText(),
        ),
      };
    }
  }

  protected initialize(): void {
    const apiKey = this.configService.get<string>('GOOGLE_GENAI_API_KEY', '');
    const modelName = resolveGeminiModelName(this.configService);

    if (!apiKey) {
      throw new Error(
        `Google AI no configurado para ${this.orchestratorConfig.getName()}`,
      );
    }

    const model = new Gemini({ apiKey, model: modelName });

    this.orchestratorAgent = new LlmAgent({
      name: this.orchestratorConfig.getName(),
      model,
      instruction: this.orchestratorConfig.buildInstruction(),
      description: this.orchestratorConfig.getDescription(),
      inputSchema: ORCHESTRATOR_INPUT_SCHEMA,
      subAgents: this.orchestratorConfig.getSubAgents(),
      tools: this.orchestratorConfig.getTools(),
    });

    normalizeAgentTreeRoots(this.orchestratorAgent);

    this.runner = new Runner({
      agent: this.orchestratorAgent,
      appName: this.appName,
      sessionService: this.sessionService,
    });
  }

  private ensureInitialized(): void {
    if (!this.runner || !this.orchestratorAgent) {
      this.initialize();
    }
  }

  private async ensureSession(
    context: RouterMessageContext,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.sessionService.getSession({
      appName: this.appName,
      userId,
      sessionId,
    });

    const freshState = this.orchestratorConfig.buildInitialState(context);
    if (!session) {
      await this.sessionService.createSession({
        appName: this.appName,
        userId,
        sessionId,
        state: freshState,
      });
      return;
    }

    await this.sessionService.refreshSessionState(session, freshState);
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }

  private buildFallbackFormattedResponse(message: string): FormattedResponse {
    return {
      type: 'buttons',
      body: message,
      options: [
        {
          id: 'acknowledge',
          title: 'Entendido',
        },
      ],
    };
  }
}
