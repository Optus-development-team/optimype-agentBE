import { Injectable, Logger } from '@nestjs/common';
import type { FunctionTool, LlmAgent } from '@google/adk';
import { ConfigService } from '@nestjs/config';
import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestratorInput } from '../types/orchestrator-io.types';
import { UserRole } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestrationResult } from '../orchestrator.types';
import type { OrchestratorConfig } from './orchestrator.config';
import { OrchestratorToolsService } from '../orchestrator.tools';
import { ReportingAgent } from '../../agents/general/reporting/reporting.agent';
import { AppointmentAdminAgent } from '../../agents/general/appointment/admin/appointment.agent';
import { ReestockAgent } from '../../agents/general/reestock/reestock.agent';
import { OAuthService } from '../../../../features/auth/oauth.service';
import { TimeService } from '../../../../common/time/time.service';
import { buildPrompt } from '../builders/prompt.builder';
import { buildInput } from '../builders/input.builder';
import { buildInitialState } from '../builders/initial-state.builder';
import { buildAgentIdentityInstruction } from '../builders/agent-identity-instruction.builder';
import { handleGoogleAccountConnectionRequirement } from '../helpers/google-account-connection.helper';

@Injectable()
export class GeneralAdminOrchestratorConfig implements OrchestratorConfig {
  private readonly logger = new Logger(GeneralAdminOrchestratorConfig.name);

  constructor(
    private readonly config: ConfigService,
    private readonly orchestratorTools: OrchestratorToolsService,
    private readonly reportingAgent: ReportingAgent,
    private readonly appointmentAdminAgent: AppointmentAdminAgent,
    private readonly reestockAgent: ReestockAgent,
    private readonly oauthService: OAuthService,
    private readonly timeService: TimeService,
  ) {}

  getName(): string {
    return 'general_admin_orchestrator';
  }

  getDescription(): string {
    return 'Orquestador para equipo interno de la empresa';
  }

  buildInstruction(): string {
    return `${buildAgentIdentityInstruction()}

Eres el orquestador interno de {app:companyName}. Atiendes al personal administrativo y operativo.

AGENTES DISPONIBLES:
1. reporting_agent: métricas, reportes y KPIs.
2. appointment_agent: gestión de citas internas.
3. reestock_agent: reabastecimiento e inventario.
4. knowledge_agent: información pública de la empresa para soporte.

COMPORTAMIENTO:
- Deriva al agente correcto según la intención.
- Sé preciso y orientado a datos.
- Si falta información, aclara antes de actuar.
- Toma {app:todayDate} como fecha base para las operaciones.
`;
  }

  async preRoute(
    context: RouterMessageContext,
  ): Promise<OrchestrationResult | null> {
    const userId = this.normalizePhone(context.senderId);

    if (context.role === UserRole.ADMIN && context.tenant?.companyId) {
      const companyId = context.tenant.companyId;
      const hasCreds = await this.oauthService.checkCredentials(companyId);

      if (!hasCreds) {
        return handleGoogleAccountConnectionRequirement({
          logger: this.logger,
          oauthService: this.oauthService,
          context,
          userId,
          companyId,
          responseText:
            'Necesitas completar la conexión con tu cuenta de Google para continuar.',
          agentUsed: this.getName(),
        });
      }
    }

    return null;
  }

  

  buildInput(context: RouterMessageContext): OrchestratorInput {
    return buildInput(context);
  }

  buildInitialState(context: RouterMessageContext): Record<string, unknown> {
    return buildInitialState(context, this.config, this.timeService, {
      defaultRole: UserRole.ADMIN,
    });
  }

  detectIntent(message: string): OrchestrationResult['intent'] {
    const lower = message.toLowerCase();
    if (/otp|c[oó]digo|pin/.test(lower)) {
      return 'VERIFY_PHONE';
    }
    return 'UNKNOWN';
  }

  getSubAgents(): LlmAgent[] {
    return [
      this.reportingAgent.agent,
      this.appointmentAdminAgent.agent,
      this.reestockAgent.agent,
    ];
  }

  getTools(): FunctionTool[] {
    return [this.orchestratorTools.verifyPhoneCodeTool];
  }

  getErrorLogPrefix(): string {
    return 'Error en orquestación interna';
  }

  getErrorResponseText(): string {
    return 'Hubo un problema procesando tu solicitud interna. Intenta de nuevo en unos momentos.';
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }
}
