import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { RouterMessageContext } from '../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { CompanyVertical } from '../../../features/messaging/features/whatsapp/types/whatsapp.types';
import { UserRole } from '../../../features/messaging/features/whatsapp/types/whatsapp.types';
import type { OrchestrationResult } from './orchestrator.types';
import { GeneralClientOrchestratorService } from './verticals/general/general-client.orchestrator';
import { GeneralAdminOrchestratorService } from './verticals/general/general-admin.orchestrator';
import { AcademyClientOrchestratorService } from './verticals/academy/academy-client.orchestrator';
import { AcademyAdminOrchestratorService } from './verticals/academy/academy-admin.orchestrator';
import { SalonClientOrchestratorService } from './verticals/salon/salon-client.orchestrator';
import { SalonAdminOrchestratorService } from './verticals/salon/salon-admin.orchestrator';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../../common/events/system-events.types';
import { LlmResponseFormatterService } from '../formatters/llm-response-formatter.service';
import {
  CALENDAR_ACTION_PREFIX,
  CALENDAR_FOLLOWUP_PREFIX,
  isCalendarSlotToken,
  PENDING_AVAILABILITY_STATE_KEY,
  PENDING_APPOINTMENT_SELECTION_STATE_KEY,
  PENDING_CALENDAR_ACTION_STATE_KEY,
  PENDING_SERVICE_CATALOG_STATE_KEY,
  LAST_CALENDAR_OUTCOME_STATE_KEY,
  readPendingAvailability,
  readPendingAppointmentSelection,
  readPendingCalendarAction,
  readPendingServiceCatalog,
  readCalendarOutcome,
} from '../../../features/calendar/calendar-slot-selection';
import type { FormattedResponse } from '../formatters/types/llm-response.types';

@Injectable()
export class AdkOrchestratorService {
  private readonly logger = new Logger(AdkOrchestratorService.name);

  constructor(
    private readonly generalClientOrchestrator: GeneralClientOrchestratorService,
    private readonly generalAdminOrchestrator: GeneralAdminOrchestratorService,
    private readonly academyClientOrchestrator: AcademyClientOrchestratorService,
    private readonly academyAdminOrchestrator: AcademyAdminOrchestratorService,
    private readonly salonClientOrchestrator: SalonClientOrchestratorService,
    private readonly salonAdminOrchestrator: SalonAdminOrchestratorService,
    private readonly eventEmitter: EventEmitter2,
    private readonly responseFormatter: LlmResponseFormatterService,
  ) {}

  async route(context: RouterMessageContext): Promise<OrchestrationResult> {
    const role = context.role ?? UserRole.CLIENT;
    this.logger.debug('Role', role, 'for sender', context.senderId);
    const vertical = this.normalizeVertical(context.tenant.vertical);
    const orchestrator = this.resolveOrchestrator(role, vertical);
    const companyId = context.tenant?.companyId;

    if (companyId) {
      this.emitCompanyEvent(companyId, {
        type: SystemEventType.TENANT_RESOLVED,
        payload: {
          senderId: context.senderId,
          phoneNumberId: context.phoneNumberId,
          vertical,
          role,
        },
      });
    }

    this.logger.debug(
      `Derivando mensaje de ${context.senderId} a ${vertical}/${role} orchestrator`,
    );

    const result = await orchestrator.route(context);

    if (companyId) {
      this.emitCompanyEvent(companyId, {
        type: SystemEventType.LLM_RESPONSE_GENERATED,
        payload: {
          intent: result.intent,
          agentUsed: result.agentUsed,
          responseLength: result.responseText?.length ?? 0,
        },
      });
    }

    // Formatear la respuesta final a un objeto estructurado para la capa
    // de mensajería. Esto mantiene a los agentes agnósticos respecto al
    // canal (WhatsApp, SMS, etc.).
    if (result.formattedResponse.type === 'cta_url') {
      return result;
    }

    const calendarConfirmation = this.buildCalendarActionConfirmation(
      result.sessionState,
    );
    if (calendarConfirmation) {
      return { ...result, formattedResponse: calendarConfirmation };
    }

    const appointmentSelection = this.buildAppointmentSelectionResponse(
      result.sessionState,
    );
    if (appointmentSelection) {
      return { ...result, formattedResponse: appointmentSelection };
    }

    const serviceCatalog = this.buildServiceCatalogResponse(
      result.sessionState,
      result.responseText,
    );
    if (serviceCatalog) {
      return { ...result, formattedResponse: serviceCatalog };
    }

    const availabilityResponse = this.buildAvailabilityResponse(
      result.sessionState,
      result.responseText,
    );
    if (availabilityResponse && !isCalendarSlotToken(context.originalText)) {
      return { ...result, formattedResponse: availabilityResponse };
    }

    const outcomeResponse = this.buildCalendarOutcomeResponse(
      result.sessionState,
      result.responseText,
    );
    if (outcomeResponse) {
      return { ...result, formattedResponse: outcomeResponse };
    }

    try {
      return {
        ...result,
        formattedResponse: await this.responseFormatter.formatResponse({
          responseText: result.responseText ?? '',
          intent: result.intent,
          agentUsed: result.agentUsed,
        }),
      };
    } catch (err) {
      this.logger.warn('No se pudo formatear respuesta en orchestrator', err);
      return {
        ...result,
        formattedResponse: {
          type: 'buttons',
          body:
            result.responseText ??
            'No se pudo generar una respuesta estructurada.',
          options: [
            {
              id: 'acknowledge',
              title: 'Entendido',
            },
          ],
        },
      };
    }
  }

  private emitCompanyEvent(
    companyId: string,
    params: {
      type: SystemEventType;
      payload: Record<string, unknown>;
    },
  ): void {
    const event: SystemNotificationEvent = {
      companyId,
      type: params.type,
      timestamp: new Date().toISOString(),
      payload: params.payload,
    };

    this.eventEmitter.emit(SYSTEM_EVENT_CHANNEL, event);
  }

  private resolveOrchestrator(role: UserRole, vertical: CompanyVertical) {
    if (vertical === 'academy') {
      return role === UserRole.ADMIN
        ? this.academyAdminOrchestrator
        : this.academyClientOrchestrator;
    }

    if (vertical === 'salon') {
      return role === UserRole.ADMIN
        ? this.salonAdminOrchestrator
        : this.salonClientOrchestrator;
    }

    return role === UserRole.ADMIN
      ? this.generalAdminOrchestrator
      : this.generalClientOrchestrator;
  }

  private normalizeVertical(value: string | undefined): CompanyVertical {
    if (value === 'academy' || value === 'salon') {
      return value;
    }

    return 'general';
  }

  private buildAvailabilityResponse(
    sessionState: Record<string, unknown> | undefined,
    responseText: string | undefined,
  ): FormattedResponse | null {
    const pending = readPendingAvailability(
      sessionState?.[PENDING_AVAILABILITY_STATE_KEY],
    );
    if (
      !pending?.slots.length ||
      pending.requestTime !== sessionState?.['app:currentDateTime']
    ) {
      return null;
    }

    const formatter = new Intl.DateTimeFormat('es-BO', {
      timeZone: pending.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return {
      type: 'list',
      body:
        responseText?.trim() ||
        `Selecciona un horario disponible para el ${pending.date}.`,
      buttonText: 'Ver horarios',
      sections: [
        {
          title: pending.date,
          items: pending.slots.map((slot) => ({
            id: slot.token,
            title: `${formatter.format(new Date(slot.start))}${
              slot.staffName ? ` · ${slot.staffName}` : ''
            }`.slice(0, 24),
            description: `${slot.durationMinutes} min`,
          })),
        },
      ],
    };
  }

  private buildCalendarActionConfirmation(
    sessionState: Record<string, unknown> | undefined,
  ): FormattedResponse | null {
    const action = readPendingCalendarAction(
      sessionState?.[PENDING_CALENDAR_ACTION_STATE_KEY],
    );
    if (
      !action ||
      action.requestedAt !== sessionState?.['app:currentDateTime']
    ) {
      return null;
    }
    const timezone =
      typeof sessionState?.['app:timezone'] === 'string'
        ? sessionState['app:timezone']
        : 'America/La_Paz';
    const formatter = new Intl.DateTimeFormat('es-BO', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    let body: string;
    if (action.kind === 'create') {
      body = `Confirma tu reserva:\n${action.serviceName || 'Servicio'}\n${formatter.format(new Date(action.slot.start))}${action.slot.staffName ? ` con ${action.slot.staffName}` : ''}\nDuración: ${action.slot.durationMinutes} min${action.servicePrice !== null && action.servicePrice !== undefined ? ` · ${action.servicePrice} ${action.currency || ''}`.trimEnd() : ''}`;
    } else if (action.kind === 'reschedule') {
      body = `¿Confirmas cambiar ${action.title || 'tu cita'} al ${formatter.format(new Date(action.slot.start))}?`;
    } else {
      body = `¿Confirmas cancelar ${action.title || 'tu cita'} del ${formatter.format(new Date(action.scheduledStart))}?`;
    }
    return {
      type: 'buttons',
      body,
      options: [
        {
          id: `${CALENDAR_ACTION_PREFIX}confirm`,
          title: 'Confirmar',
        },
        {
          id: `${CALENDAR_ACTION_PREFIX}discard`,
          title: 'Volver',
        },
      ],
    };
  }

  private buildServiceCatalogResponse(
    sessionState: Record<string, unknown> | undefined,
    responseText: string | undefined,
  ): FormattedResponse | null {
    const catalog = readPendingServiceCatalog(
      sessionState?.[PENDING_SERVICE_CATALOG_STATE_KEY],
    );
    if (
      !catalog?.services.length ||
      catalog.requestedAt !== sessionState?.['app:currentDateTime']
    ) {
      return null;
    }
    return {
      type: 'list',
      body: responseText?.trim() || '¿Qué servicio deseas reservar?',
      buttonText: 'Ver servicios',
      sections: [
        {
          title: 'Servicios',
          items: catalog.services.map((service) => ({
            id: service.token,
            title: service.name.slice(0, 24),
            description: [
              service.durationMinutes ? `${service.durationMinutes} min` : null,
              service.price !== null
                ? `${service.price} ${service.currency || ''}`.trim()
                : null,
            ]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 72),
          })),
        },
      ],
    };
  }

  private buildAppointmentSelectionResponse(
    sessionState: Record<string, unknown> | undefined,
  ): FormattedResponse | null {
    const selection = readPendingAppointmentSelection(
      sessionState?.[PENDING_APPOINTMENT_SELECTION_STATE_KEY],
    );
    if (
      !selection?.appointments.length ||
      selection.requestedAt !== sessionState?.['app:currentDateTime']
    ) {
      return null;
    }
    const timezone =
      typeof sessionState?.['app:timezone'] === 'string'
        ? sessionState['app:timezone']
        : 'America/La_Paz';
    const formatter = new Intl.DateTimeFormat('es-BO', {
      timeZone: timezone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return {
      type: 'list',
      body:
        selection.operation === 'cancel'
          ? '¿Cuál de tus citas deseas cancelar?'
          : '¿Cuál de tus citas deseas reprogramar?',
      buttonText: 'Ver mis citas',
      sections: [
        {
          title: 'Próximas citas',
          items: selection.appointments.map((appointment) => ({
            id: appointment.token,
            title: formatter.format(new Date(appointment.start)).slice(0, 24),
            description: (appointment.title || 'Cita').slice(0, 72),
          })),
        },
      ],
    };
  }

  private buildCalendarOutcomeResponse(
    sessionState: Record<string, unknown> | undefined,
    responseText: string | undefined,
  ): FormattedResponse | null {
    const outcome = readCalendarOutcome(
      sessionState?.[LAST_CALENDAR_OUTCOME_STATE_KEY],
    );
    if (
      !outcome ||
      outcome.requestedAt !== sessionState?.['app:currentDateTime']
    ) {
      return null;
    }
    if (outcome.kind === 'cancelled') {
      return {
        type: 'buttons',
        body: responseText?.trim() || 'Tu cita fue cancelada.',
        options: [
          {
            id: `${CALENDAR_FOLLOWUP_PREFIX}new`,
            title: 'Agendar otra',
          },
        ],
      };
    }
    return {
      type: 'buttons',
      body:
        responseText?.trim() ||
        (outcome.kind === 'created'
          ? 'Tu cita quedó confirmada.'
          : 'Tu cita fue reprogramada.'),
      options: [
        {
          id: `${CALENDAR_FOLLOWUP_PREFIX}reschedule:${outcome.appointmentId}`,
          title: 'Reprogramar',
        },
        {
          id: `${CALENDAR_FOLLOWUP_PREFIX}cancel:${outcome.appointmentId}`,
          title: 'Cancelar cita',
        },
      ],
    };
  }
}
