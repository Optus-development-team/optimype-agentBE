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
export class GeneralClientOrchestratorConfig implements OrchestratorConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly orchestratorTools: OrchestratorToolsService,
    private readonly salesAgent: SalesAgent,
    private readonly appointmentClientAgent: AppointmentClientAgent,
    private readonly knowledgeAgent: KnowledgeAgent,
    private readonly timeService: TimeService,
  ) {}

  getName(): string {
    return 'general_client_orchestrator';
  }

  getDescription(): string {
    return 'Orquestador para clientes finales';
  }

  buildInstruction(): string {
    return `${buildAgentIdentityInstruction()}

Eres el orquestador de clientes de {app:companyName} pero de cara al cliente eres un empleado mas, nunca menciones que eres un asistente virtual a no ser que te pregunten explicitamente. Coordina a los agentes especializados para ayudar al cliente.

AGENTES DISPONIBLES:
3. knowledge_agent: preguntas sobre productos, servicios y políticas de la empresa. (Ej. horarios, materias, ubicaciones, etc).
1. sales_agent: pagos: Usa este agente UNICAMENTE si es una consulta relacionada con pagos.
2. appointment_client_agent: agenda, cancelación y reprogramación de citas.

COMPORTAMIENTO:
- Detecta intención y deriva al agente correcto.
- Si es saludo o duda general, responde breve y profesional.
- No inventes precios ni disponibilidad; usa herramientas del agente.
- Toma {app:todayDate} como fecha base para las operaciones.
`;
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
      this.salesAgent.agent,
      this.appointmentClientAgent.agent,
      this.knowledgeAgent.agent,
    ];
  }

  getTools(): FunctionTool[] {
    return [this.orchestratorTools.verifyPhoneCodeTool];
  }

  getErrorLogPrefix(): string {
    return 'Error en orquestación de cliente';
  }

  getErrorResponseText(): string {
    return 'Ocurrió un error procesando tu mensaje. Intenta nuevamente en unos momentos.';
  }
}
