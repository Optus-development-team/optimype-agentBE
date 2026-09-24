import { Injectable } from '@nestjs/common';
import type { FunctionTool, LlmAgent } from '@google/adk';
import { ConfigService } from '@nestjs/config';
import type { RouterMessageContext } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestratorInput } from '../types/orchestrator-io.types';
import { UserRole } from '../../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestrationResult } from '../orchestrator.types';
import type { OrchestratorConfig } from './orchestrator.config';
import { OrchestratorToolsService } from '../orchestrator.tools';
import { SalesAgent } from '../../agents/general/sales/sales.agent';
import { AppointmentClientAgent } from '../../agents/general/appointment/client/appointment.agent';
import { KnowledgeAgent } from '../../agents/general/knowledge/knowledge.agent';
import { TimeService } from '../../../../common/time/time.service';
import { buildInput } from '../builders/input.builder';
import { buildInitialState } from '../builders/initial-state.builder';
import { buildAgentIdentityInstruction } from '../builders/agent-identity-instruction.builder';

@Injectable()
export class AcademyClientOrchestratorConfig implements OrchestratorConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly orchestratorTools: OrchestratorToolsService,
    private readonly salesAgent: SalesAgent,
    private readonly appointmentClientAgent: AppointmentClientAgent,
    private readonly knowledgeAgent: KnowledgeAgent,
    private readonly timeService: TimeService,
  ) {}

  getName(): string {
    return 'academy_client_orchestrator';
  }

  getDescription(): string {
    return 'Orquestador de atención al cliente para vertical academia';
  }

  buildInstruction(): string {
    return `${buildAgentIdentityInstruction()}

Eres el orquestador de clientes para una academia ({app:companyName}) pero de cara al cliente eres un empleado mas, nunca menciones que eres un asistente virtual a no ser que te pregunten explicitamente..

AGENTES DISPONIBLES:
1. knowledge_agent: información institucional, horarios, políticas y cursos.
2. appointment_client_agent: reservas de tutorías o citas académicas.
3. sales_agent: pagos de matrículas, mensualidades y servicios.

COMPORTAMIENTO:
- Prioriza claridad y acompañamiento para estudiantes y representantes.
- Si la intención es informativa, usa knowledge_agent.
- Si el cliente menciona pagos o cobros, deriva a sales_agent.
- Toma {app:todayDate} como fecha base para las operaciones.`;
  }

  

  buildInput(context: RouterMessageContext): OrchestratorInput {
    return buildInput(context);
  }

  buildInitialState(context: RouterMessageContext): Record<string, unknown> {
    return buildInitialState(context, this.config, this.timeService, {
      defaultRole: UserRole.CLIENT,
      extraState: {
        'app:inventoryContext': '',
      },
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
      this.knowledgeAgent.agent,
      this.appointmentClientAgent.agent,
      this.salesAgent.agent,
    ];
  }

  getTools(): FunctionTool[] {
    return [this.orchestratorTools.verifyPhoneCodeTool];
  }

  getErrorLogPrefix(): string {
    return 'Error en orquestación de cliente academia';
  }

  getErrorResponseText(): string {
    return 'Ocurrió un error procesando tu mensaje. Intenta nuevamente en unos momentos.';
  }
}
