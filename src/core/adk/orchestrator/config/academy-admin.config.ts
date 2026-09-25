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
import { KnowledgeAgent } from '../../agents/general/knowledge/knowledge.agent';
import { AcademyAgent } from '../../agents/verticals/academy/academy.agent';
import { OAuthService } from '../../../../features/auth/oauth.service';
import { TimeService } from '../../../../common/time/time.service';
import { buildInput } from '../builders/input.builder';
import { buildInitialState } from '../builders/initial-state.builder';
import { buildAgentIdentityInstruction } from '../builders/agent-identity-instruction.builder';
import { handleGoogleAccountConnectionRequirement } from '../helpers/google-account-connection.helper';

@Injectable()
export class AcademyAdminOrchestratorConfig implements OrchestratorConfig {
  private readonly logger = new Logger(AcademyAdminOrchestratorConfig.name);

  constructor(
    private readonly config: ConfigService,
    private readonly orchestratorTools: OrchestratorToolsService,
    private readonly reportingAgent: ReportingAgent,
    private readonly appointmentAdminAgent: AppointmentAdminAgent,
    private readonly reestockAgent: ReestockAgent,
    private readonly knowledgeAgent: KnowledgeAgent,
    private readonly academyAgent: AcademyAgent,
    private readonly oauthService: OAuthService,
    private readonly timeService: TimeService,
  ) {}

  getName(): string {
    return 'academy_admin_orchestrator';
  }

  getDescription(): string {
    return 'Orquestador interno para vertical academia';
  }

  buildInstruction(): string {
    return `${buildAgentIdentityInstruction()}

Eres el orquestador administrativo de una academia ({app:companyName}).

AGENTES DISPONIBLES:
1. reporting_agent: métricas, reportes y KPI académicos.
2. appointment_admin_agent: coordinación de citas/tutorías internas.
3. reestock_agent: gestión operativa de inventario interno.
4. knowledge_agent: información institucional pública.
5. academy_agent: operaciones académicas especializadas (notas e inscripciones).

COMPORTAMIENTO:
- Prioriza trazabilidad y exactitud en procesos académicos.
- Usa academy_agent para consultas de notas e inscripciones.
- Si faltan datos, solicita precisión antes de actuar.
- Toma {app:todayDate} como fecha base para las operaciones.`;
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
      this.knowledgeAgent.agent,
      this.academyAgent.agent,
    ];
  }

  getTools(): FunctionTool[] {
    return [this.orchestratorTools.verifyPhoneCodeTool];
  }

  getErrorLogPrefix(): string {
    return 'Error en orquestación interna academia';
  }

  getErrorResponseText(): string {
    return 'Hubo un problema procesando tu solicitud interna. Intenta de nuevo en unos momentos.';
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }
}
