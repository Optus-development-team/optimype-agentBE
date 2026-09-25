import { Injectable, Logger } from '@nestjs/common';
import { AppointmentsService } from '../../../../../features/calendar/appointments.service';
import { FunctionTool } from '@google/adk';
import type { Context } from '@google/adk';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { z } from 'zod';
import { TimeService } from '../../../../../common/time/time.service';
import {
  SYSTEM_EVENT_CHANNEL,
  SystemEventType,
  type SystemNotificationEvent,
} from '../../../../../common/events/system-events.types';
import {
  createPendingAppointmentSelection,
  createPendingServiceCatalog,
  createPendingAvailability,
  findPendingService,
  findPendingCalendarSlot,
  LAST_CALENDAR_OUTCOME_STATE_KEY,
  PENDING_AVAILABILITY_STATE_KEY,
  PENDING_APPOINTMENT_SELECTION_STATE_KEY,
  PENDING_CALENDAR_ACTION_STATE_KEY,
  PENDING_RESCHEDULE_TARGET_STATE_KEY,
  PENDING_SERVICE_CATALOG_STATE_KEY,
  readPendingAvailability,
  readPendingCalendarAction,
  readPendingRescheduleTarget,
  readSelectedCalendarService,
  SELECTED_CALENDAR_SERVICE_STATE_KEY,
  type PendingCalendarAction,
  type PendingCalendarSlot,
} from '../../../../../features/calendar/calendar-slot-selection';
import type { AppointmentRecord } from '../../../../../features/calendar/calendar.types';

@Injectable()
export class AppointmentToolsService {
  private readonly logger = new Logger('AppointmentTools');

  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly timeService: TimeService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  get listBookableServicesTool(): FunctionTool {
    return new FunctionTool({
      name: 'list_bookable_services',
      description:
        'Lista los servicios reales que la empresa permite reservar, con duración y precio. Úsala cuando el cliente no haya elegido servicio o pregunte qué puede reservar.',
      parameters: z.object({}),
      execute: async (_args, context?: Context) => {
        const companyId = this.stateString(
          context?.state?.get('app:companyId'),
        );
        if (!companyId) {
          return { success: false, message: 'Empresa no identificada.' };
        }
        const services =
          await this.appointmentsService.listBookableServices(companyId);
        const pending = createPendingServiceCatalog({
          requestedAt:
            this.stateString(context?.state?.get('app:currentDateTime')) ??
            new Date().toISOString(),
          services: services.map((service) => ({
            id: service.id,
            name: service.name,
            description: service.description,
            durationMinutes: service.duration_minutes,
            price: service.sale_price,
            currency: service.currency,
          })),
        });
        context?.state?.set(PENDING_SERVICE_CATALOG_STATE_KEY, pending);
        return {
          success: true,
          services: pending.services,
          message: services.length
            ? 'Estos son los servicios disponibles para reservar.'
            : 'Por el momento no hay servicios habilitados para reservar.',
        };
      },
    });
  }

  get selectCalendarServiceTool(): FunctionTool {
    return new FunctionTool({
      name: 'select_calendar_service',
      description:
        'Guarda el servicio exacto elegido desde la lista interactiva y solicita la fecha que falta.',
      parameters: z.object({
        serviceToken: z
          .string()
          .describe('Token exacto de la lista de servicios'),
      }),
      execute: (args, context?: Context) => {
        const selected = findPendingService(
          context?.state?.get(PENDING_SERVICE_CATALOG_STATE_KEY),
          args.serviceToken,
        );
        if (!selected) {
          return {
            success: false,
            message: 'La lista de servicios expiró. Muéstrala nuevamente.',
          };
        }
        context?.state?.set(SELECTED_CALENDAR_SERVICE_STATE_KEY, selected);
        context?.state?.set(PENDING_SERVICE_CATALOG_STATE_KEY, null);
        return {
          success: true,
          selectedService: selected,
          message: `Perfecto, elegiste ${selected.name}. ¿Para qué día prefieres tu cita?`,
        };
      },
    });
  }

  get listAvailableStaffTool(): FunctionTool {
    return new FunctionTool({
      name: 'list_available_staff',
      description:
        'Lista los profesionales activos que pueden atender un servicio. Úsala cuando el cliente quiera elegir quién lo atenderá.',
      parameters: z.object({
        serviceType: z.string().optional().describe('Servicio solicitado'),
      }),
      execute: async (args, context?: Context) => {
        const companyId = this.stateString(
          context?.state?.get('app:companyId'),
        );
        if (!companyId) {
          return { success: false, message: 'Empresa no identificada.' };
        }
        const service = args.serviceType
          ? await this.appointmentsService.resolveBookableService(
              companyId,
              args.serviceType,
            )
          : null;
        const staff = await this.appointmentsService.listActiveStaff(
          companyId,
          service?.id,
        );
        return {
          success: true,
          staff,
          message: staff.length
            ? 'Estos son los profesionales disponibles.'
            : 'No hay profesionales habilitados para ese servicio.',
        };
      },
    });
  }

  get checkAvailabilityTool(): FunctionTool {
    return new FunctionTool({
      name: 'check_availability',
      description:
        'Consulta los horarios disponibles para agendar una cita. ' +
        'Acepta fechas en lenguaje natural (mañana, próximo lunes, etc.).',
      parameters: z.object({
        date: z
          .string()
          .describe(
            'Fecha para consultar (puede ser natural: "mañana", "próximo lunes")',
          ),
        serviceType: z
          .string()
          .optional()
          .describe('Tipo de servicio a agendar'),
        duration: z
          .number()
          .optional()
          .describe('Duración estimada en minutos'),
        staffName: z
          .string()
          .optional()
          .describe('Nombre del profesional solicitado'),
        operation: z
          .enum(['create', 'reschedule'])
          .optional()
          .describe('Indica si se busca crear o reprogramar una cita'),
        timePreference: z
          .enum(['morning', 'afternoon', 'evening'])
          .optional()
          .describe('Franja preferida: mañana, tarde o noche'),
      }),
      execute: async (args, context?: Context) => {
        this.logger.debug(`Consultando disponibilidad para: ${args.date}`);

        const state = context?.state;
        const companyId = this.stateString(state?.get('app:companyId'));
        const timezone = this.stateString(state?.get('app:timezone'));

        this.emitToolTriggered(companyId, 'check_availability');

        try {
          if (!companyId) throw new Error('Empresa no identificada');
          const resolvedDate = this.timeService.resolveDateBounds(
            args.date,
            timezone,
          );
          const selectedService = readSelectedCalendarService(
            state?.get(SELECTED_CALENDAR_SERVICE_STATE_KEY),
          );
          const service = args.serviceType
            ? await this.appointmentsService.resolveBookableService(
                companyId,
                args.serviceType,
              )
            : selectedService
              ? {
                  id: selectedService.id,
                  name: selectedService.name,
                  durationMinutes: selectedService.durationMinutes,
                }
              : null;
          const rescheduleTarget = readPendingRescheduleTarget(
            state?.get(PENDING_RESCHEDULE_TARGET_STATE_KEY),
          );
          const operation =
            args.operation ?? (rescheduleTarget ? 'reschedule' : 'create');
          const vertical = this.stateString(state?.get('app:vertical'));
          if (vertical === 'salon' && !service && !rescheduleTarget) {
            const services =
              await this.appointmentsService.listBookableServices(companyId);
            const catalog = createPendingServiceCatalog({
              requestedAt:
                this.stateString(state?.get('app:currentDateTime')) ??
                new Date().toISOString(),
              services: services.map((item) => ({
                id: item.id,
                name: item.name,
                description: item.description,
                durationMinutes: item.duration_minutes,
                price: item.sale_price,
                currency: item.currency,
              })),
            });
            state?.set(PENDING_SERVICE_CATALOG_STATE_KEY, catalog);
            return {
              success: false,
              requiresService: true,
              services: catalog.services,
              message:
                'Antes de buscar horarios necesito saber qué servicio deseas.',
            };
          }
          const staff = args.staffName
            ? await this.appointmentsService.resolveActiveStaff(
                companyId,
                args.staffName,
                service?.id ?? rescheduleTarget?.serviceId ?? undefined,
              )
            : null;
          const available = await this.appointmentsService.availability({
            companyId,
            date: resolvedDate.date,
            serviceId: service?.id ?? rescheduleTarget?.serviceId ?? undefined,
            staffId:
              staff?.id ??
              (operation === 'reschedule'
                ? (rescheduleTarget?.staffId ?? undefined)
                : undefined),
            durationMinutes:
              args.duration ??
              service?.durationMinutes ??
              rescheduleTarget?.durationMinutes ??
              undefined,
            excludeAppointmentId:
              operation === 'reschedule'
                ? rescheduleTarget?.appointmentId
                : undefined,
          });
          const preferred = args.timePreference
            ? available.filter((slot) =>
                this.matchesTimePreference(
                  slot.start,
                  resolvedDate.timezone,
                  args.timePreference!,
                ),
              )
            : available;
          const displayed =
            args.timePreference && preferred.length === 0 && available.length
              ? available
              : preferred;
          const pending = createPendingAvailability({
            requestTime:
              this.stateString(state?.get('app:currentDateTime')) ??
              new Date().toISOString(),
            date: resolvedDate.date,
            timezone: resolvedDate.timezone,
            serviceName: service?.name ?? rescheduleTarget?.title ?? undefined,
            operation,
            appointmentId:
              operation === 'reschedule'
                ? rescheduleTarget?.appointmentId
                : undefined,
            slots: displayed,
          });
          state?.set(PENDING_AVAILABILITY_STATE_KEY, pending);
          return {
            success: true,
            date: resolvedDate.date,
            timezone: resolvedDate.timezone,
            available: pending.slots.map((slot) => ({
              slotToken: slot.token,
              start: slot.start,
              end: slot.end,
              staffId: slot.staffId,
              staffName: slot.staffName,
            })),
            message:
              args.timePreference && preferred.length === 0 && available.length
                ? `No encontré horarios en esa franja; te muestro las alternativas más cercanas del ${resolvedDate.date}.`
                : displayed.length
                  ? `Hay ${displayed.length} horario(s) disponible(s) el ${resolvedDate.date}.`
                  : `No hay horarios disponibles el ${resolvedDate.date}.`,
          };
        } catch (error) {
          const err = error as Error;
          this.logger.error(`Error checking availability: ${err.message}`);
          return {
            success: false,
            message:
              'No pude consultar la disponibilidad. Verifica que el calendario esté conectado.',
            error: err.message,
          };
        }
      },
    });
  }

  get createAppointmentTool(): FunctionTool {
    return new FunctionTool({
      name: 'create_appointment',
      description:
        'Agenda una nueva cita en el horario especificado. ' +
        'Requiere fecha, hora y duración; opcionalmente el tipo de servicio.',
      parameters: z.object({
        slotToken: z
          .string()
          .optional()
          .describe('Token exacto devuelto por check_availability'),
        date: z.string().optional().describe('Fecha de la cita'),
        time: z
          .string()
          .optional()
          .describe('Hora de la cita (formato 24h, ej: "14:00")'),
        duration: z
          .string()
          .optional()
          .describe(
            'Duración obligatoria de la cita (ej: "1 hora", "15 minutos")',
          ),
        serviceType: z.string().optional().describe('Tipo de servicio'),
        notes: z.string().optional().describe('Notas adicionales'),
      }),
      execute: async (args, context?: Context) => {
        this.logger.debug(
          `Creando cita: ${args.date} ${args.time} (${args.duration})`,
        );

        const state = context?.state;
        const companyId = this.stateString(state?.get('app:companyId'));
        const timezone = this.stateString(state?.get('app:timezone'));

        this.emitToolTriggered(companyId, 'create_appointment');

        try {
          if (!companyId) throw new Error('Empresa no identificada');
          const pending = readPendingAvailability(
            state?.get(PENDING_AVAILABILITY_STATE_KEY),
          );
          const selectedSlot = args.slotToken
            ? findPendingCalendarSlot(pending, args.slotToken)
            : null;
          if (args.slotToken && !selectedSlot) {
            throw new Error(
              'El horario seleccionado expiró. Consulta nuevamente la disponibilidad.',
            );
          }
          if (!selectedSlot && (!args.date || !args.time || !args.duration)) {
            throw new Error(
              'Faltan fecha, hora o duración para crear la cita.',
            );
          }
          const appointmentStart = selectedSlot
            ? {
                startIso: selectedSlot.start,
                date: pending!.date,
                timezone: pending!.timezone,
              }
            : this.timeService.buildAppointmentStart(
                args.date!,
                args.time!,
                timezone,
              );
          const durationMinutes = selectedSlot
            ? Math.max(
                1,
                Math.round(
                  (Date.parse(selectedSlot.end) -
                    Date.parse(selectedSlot.start)) /
                    60_000,
                ),
              )
            : this.timeService.parseDurationToMinutes(args.duration!);
          const appointmentEnd = selectedSlot
            ? selectedSlot.end
            : new Date(
                Date.parse(appointmentStart.startIso) +
                  durationMinutes * 60_000,
              ).toISOString();
          const action: PendingCalendarAction = {
            kind: 'create',
            requestedAt:
              this.stateString(state?.get('app:currentDateTime')) ??
              new Date().toISOString(),
            slot:
              selectedSlot ??
              ({
                token: 'manual',
                start: appointmentStart.startIso,
                end: appointmentEnd,
                staffId: null,
                staffName: null,
                serviceId: null,
                durationMinutes,
              } satisfies PendingCalendarSlot),
            serviceName: args.serviceType ?? pending?.serviceName ?? 'Servicio',
            servicePrice: readSelectedCalendarService(
              state?.get(SELECTED_CALENDAR_SERVICE_STATE_KEY),
            )?.price,
            currency: readSelectedCalendarService(
              state?.get(SELECTED_CALENDAR_SERVICE_STATE_KEY),
            )?.currency,
            notes: args.notes,
          };
          if (this.requiresConfirmation(state)) {
            state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, action);
            return {
              success: true,
              confirmationRequired: true,
              message: 'Confirma los datos antes de reservar la cita.',
            };
          }
          return this.executePendingAction(action, context);
        } catch (error) {
          const err = error as Error;
          this.logger.error(`Error creating appointment: ${err.message}`);
          return {
            success: false,
            message: 'No pude agendar la cita. Inténtalo más tarde.',
            error: err.message,
          };
        }
      },
    });
  }

  get cancelAppointmentTool(): FunctionTool {
    return new FunctionTool({
      name: 'cancel_appointment',
      description:
        'Cancela una cita por su ID o identificándola por fecha y hora.',
      parameters: z.object({
        appointmentId: z
          .string()
          .optional()
          .describe('ID de la cita a cancelar'),
        date: z
          .string()
          .optional()
          .describe('Fecha de la cita si no se conoce su ID'),
        time: z
          .string()
          .optional()
          .describe('Hora de la cita si no se conoce su ID'),
        reason: z.string().optional().describe('Motivo de la cancelación'),
      }),
      execute: async (args, _context?: Context) => {
        const companyId = this.stateString(
          _context?.state?.get('app:companyId'),
        );
        this.emitToolTriggered(companyId, 'cancel_appointment');

        try {
          if (!companyId) throw new Error('Empresa no identificada');
          const phone = this.stateString(_context?.state?.get('user:phone'));
          if (!phone) throw new Error('Cliente no identificado');
          const target = await this.resolveCustomerTarget({
            companyId,
            phone,
            appointmentId: args.appointmentId,
            date: args.date,
            time: args.time,
            state: _context?.state,
            operation: 'cancel',
          });
          const action: PendingCalendarAction = {
            kind: 'cancel',
            requestedAt:
              this.stateString(_context?.state?.get('app:currentDateTime')) ??
              new Date().toISOString(),
            appointmentId: target.id,
            title: target.title,
            scheduledStart: new Date(target.scheduled_start).toISOString(),
            reason: args.reason,
          };
          if (this.requiresConfirmation(_context?.state)) {
            _context?.state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, action);
            return {
              success: true,
              confirmationRequired: true,
              message: 'Confirma si deseas cancelar esta cita.',
            };
          }
          return this.executePendingAction(action, _context);
        } catch (error) {
          return { success: false, message: (error as Error).message };
        }
      },
    });
  }

  get rescheduleAppointmentTool(): FunctionTool {
    return new FunctionTool({
      name: 'reschedule_appointment',
      description:
        'Cambia la fecha y/o hora de una cita existente por ID o fecha/hora actual.',
      parameters: z.object({
        appointmentId: z
          .string()
          .optional()
          .describe('ID de la cita a reprogramar'),
        currentDate: z
          .string()
          .optional()
          .describe('Fecha actual si no se conoce el ID'),
        currentTime: z
          .string()
          .optional()
          .describe('Hora actual si no se conoce el ID'),
        newDate: z.string().optional().describe('Nueva fecha'),
        newTime: z.string().optional().describe('Nueva hora'),
        slotToken: z
          .string()
          .optional()
          .describe('Token exacto de un horario para reprogramación'),
      }),
      execute: async (args, _context?: Context) => {
        const companyId = this.stateString(
          _context?.state?.get('app:companyId'),
        );
        const timezone = this.stateString(_context?.state?.get('app:timezone'));
        this.emitToolTriggered(companyId, 'reschedule_appointment');

        try {
          if (!companyId) throw new Error('Empresa no identificada');
          const phone = this.stateString(_context?.state?.get('user:phone'));
          if (!phone) throw new Error('Cliente no identificado');
          const pendingAvailability = readPendingAvailability(
            _context?.state?.get(PENDING_AVAILABILITY_STATE_KEY),
          );
          const selectedSlot = args.slotToken
            ? findPendingCalendarSlot(pendingAvailability, args.slotToken)
            : null;
          if (args.slotToken && !selectedSlot) {
            throw new Error(
              'El horario seleccionado expiró. Consulta nuevamente la disponibilidad.',
            );
          }

          const preparedTarget = readPendingRescheduleTarget(
            _context?.state?.get(PENDING_RESCHEDULE_TARGET_STATE_KEY),
          );
          const target = preparedTarget
            ? await this.resolveCustomerTarget({
                companyId,
                phone,
                appointmentId: preparedTarget.appointmentId,
              })
            : await this.resolveCustomerTarget({
                companyId,
                phone,
                appointmentId: args.appointmentId,
                date: args.currentDate,
                time: args.currentTime,
                state: _context?.state,
                operation: 'reschedule',
              });
          const durationMinutes = Math.max(
            1,
            Math.round(
              (Date.parse(String(target.scheduled_end)) -
                Date.parse(String(target.scheduled_start))) /
                60_000,
            ),
          );

          if (!selectedSlot && (!args.newDate || !args.newTime)) {
            _context?.state?.set(PENDING_RESCHEDULE_TARGET_STATE_KEY, {
              appointmentId: target.id,
              title: target.title,
              serviceId: target.catalog_item_id ?? null,
              staffId: target.staff_id ?? null,
              durationMinutes,
            });
            return {
              success: true,
              needsNewSlot: true,
              message:
                '¿Para qué fecha prefieres reprogramarla? También puedes indicar mañana o un día de la semana.',
            };
          }

          const slot =
            selectedSlot ??
            this.manualSlot({
              date: args.newDate!,
              time: args.newTime!,
              timezone,
              durationMinutes,
              staffId: target.staff_id,
              serviceId: target.catalog_item_id ?? null,
            });
          const action: PendingCalendarAction = {
            kind: 'reschedule',
            requestedAt:
              this.stateString(_context?.state?.get('app:currentDateTime')) ??
              new Date().toISOString(),
            appointmentId: target.id,
            slot,
            title: target.title,
          };
          if (this.requiresConfirmation(_context?.state)) {
            _context?.state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, action);
            return {
              success: true,
              confirmationRequired: true,
              message: 'Confirma el nuevo horario antes de reprogramar.',
            };
          }
          return this.executePendingAction(action, _context);
        } catch (error) {
          return { success: false, message: (error as Error).message };
        }
      },
    });
  }

  get listUserAppointmentsTool(): FunctionTool {
    return new FunctionTool({
      name: 'list_user_appointments',
      description: 'Lista todas las citas programadas del usuario actual.',
      parameters: z.object({
        status: z
          .enum(['all', 'upcoming', 'past', 'cancelled'])
          .optional()
          .describe('Filtrar por estado'),
        limit: z
          .number()
          .optional()
          .describe('Número máximo de citas a mostrar'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userPhone = this.stateString(state?.get('user:phone'));
        const companyId = this.stateString(state?.get('app:companyId'));

        this.emitToolTriggered(companyId, 'list_user_appointments');

        this.logger.debug(`Listando citas para usuario: ${userPhone}`);

        if (!companyId || !userPhone) {
          return { success: false, message: 'No pude identificar al usuario.' };
        }
        const appointments = await this.appointmentsService.listForCustomer(
          companyId,
          userPhone,
          args.status,
          args.limit,
        );
        return {
          success: true,
          appointments: appointments.map((appointment) => ({
            id: appointment.id,
            start: appointment.scheduled_start,
            end: appointment.scheduled_end,
            status: appointment.status,
            title: appointment.title,
          })),
          filter: args.status || 'upcoming',
          message: `Tienes ${appointments.length} cita(s).`,
        };
      },
    });
  }

  get confirmCalendarActionTool(): FunctionTool {
    return new FunctionTool({
      name: 'confirm_calendar_action',
      description:
        'Confirma o descarta la acción de calendario pendiente mostrada al cliente. Nunca inventa datos: usa exclusivamente el estado guardado.',
      parameters: z.object({
        confirm: z
          .boolean()
          .describe('true para confirmar, false para descartar'),
      }),
      execute: async (args, context?: Context) => {
        const action = readPendingCalendarAction(
          context?.state?.get(PENDING_CALENDAR_ACTION_STATE_KEY),
        );
        if (!action) {
          return {
            success: false,
            message:
              'Ya no hay una operación pendiente. Indícame qué deseas hacer.',
          };
        }
        if (!args.confirm) {
          context?.state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, null);
          return {
            success: true,
            discarded: true,
            message: 'Entendido, no realicé ningún cambio.',
          };
        }
        try {
          return await this.executePendingAction(action, context);
        } catch (error) {
          return { success: false, message: (error as Error).message };
        }
      },
    });
  }

  get adminTools(): FunctionTool[] {
    return [
      this.listBookableServicesTool,
      this.selectCalendarServiceTool,
      this.listAvailableStaffTool,
      this.checkAvailabilityTool,
      this.createAppointmentTool,
      this.cancelAppointmentTool,
      this.rescheduleAppointmentTool,
      this.listUserAppointmentsTool,
      this.confirmCalendarActionTool,
    ];
  }

  get clientTools(): FunctionTool[] {
    return [
      this.listBookableServicesTool,
      this.selectCalendarServiceTool,
      this.listAvailableStaffTool,
      this.checkAvailabilityTool,
      this.createAppointmentTool,
      this.cancelAppointmentTool,
      this.rescheduleAppointmentTool,
      this.listUserAppointmentsTool,
      this.confirmCalendarActionTool,
    ];
  }

  get allTools(): FunctionTool[] {
    return this.adminTools;
  }

  private emitToolTriggered(
    companyId: string | undefined,
    toolName: string,
  ): void {
    if (!companyId) {
      return;
    }

    this.emitCompanyEvent(companyId, {
      type: SystemEventType.TOOL_ACTION_TRIGGERED,
      payload: { toolName },
    });
  }

  private stateString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private stateBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  private requiresConfirmation(state: Context['state'] | undefined): boolean {
    return this.stateBoolean(state?.get('app:agentConfirmBeforeActions'), true);
  }

  private async resolveCustomerTarget(params: {
    companyId: string;
    phone: string;
    appointmentId?: string;
    date?: string;
    time?: string;
    state?: Context['state'];
    operation?: 'cancel' | 'reschedule';
  }): Promise<AppointmentRecord> {
    if (params.appointmentId) {
      const appointments = await this.appointmentsService.listForCustomer(
        params.companyId,
        params.phone,
        'upcoming',
        20,
      );
      const selected = appointments.find(
        (appointment) => appointment.id === params.appointmentId,
      );
      if (!selected)
        throw new Error('No encontré esa cita entre tus reservas.');
      params.state?.set(PENDING_APPOINTMENT_SELECTION_STATE_KEY, null);
      return selected;
    }
    if (params.date || params.time) {
      const selected = await this.appointmentsService.findForCustomer(params);
      params.state?.set(PENDING_APPOINTMENT_SELECTION_STATE_KEY, null);
      return selected;
    }
    const appointments = await this.appointmentsService.listForCustomer(
      params.companyId,
      params.phone,
      'upcoming',
      10,
    );
    if (!appointments.length) throw new Error('No tienes citas próximas.');
    if (appointments.length > 1) {
      if (params.state && params.operation) {
        params.state.set(
          PENDING_APPOINTMENT_SELECTION_STATE_KEY,
          createPendingAppointmentSelection({
            requestedAt:
              this.stateString(params.state.get('app:currentDateTime')) ??
              new Date().toISOString(),
            operation: params.operation,
            appointments: appointments.map((appointment) => ({
              id: appointment.id,
              title: appointment.title,
              start: new Date(appointment.scheduled_start).toISOString(),
              end: new Date(appointment.scheduled_end).toISOString(),
            })),
          }),
        );
      }
      throw new Error(
        'Encontré varias citas. Pide al cliente que seleccione cuál desea gestionar.',
      );
    }
    return appointments[0];
  }

  private manualSlot(params: {
    date: string;
    time: string;
    timezone?: string;
    durationMinutes: number;
    staffId: string | null;
    serviceId: string | null;
  }): PendingCalendarSlot {
    const start = this.timeService.buildAppointmentStart(
      params.date,
      params.time,
      params.timezone,
    );
    const end = new Date(
      Date.parse(start.startIso) + params.durationMinutes * 60_000,
    ).toISOString();
    return {
      token: 'manual',
      start: start.startIso,
      end,
      staffId: params.staffId,
      staffName: null,
      serviceId: params.serviceId,
      durationMinutes: params.durationMinutes,
    };
  }

  private async executePendingAction(
    action: PendingCalendarAction,
    context?: Context,
  ) {
    const state = context?.state;
    const companyId = this.stateString(state?.get('app:companyId'));
    const phone = this.stateString(state?.get('user:phone'));
    const userName = this.stateString(state?.get('user:name'));
    const timezone = this.stateString(state?.get('app:timezone'));
    if (!companyId) throw new Error('Empresa no identificada');
    if (!phone) throw new Error('Cliente no identificado');

    if (action.kind === 'create') {
      const appointment = await this.appointmentsService.create(
        {
          companyId,
          customerPhone: phone,
          customerName: userName,
          title: `Cita con ${userName || 'cliente'} - ${action.serviceName || 'Servicio'}`,
          description: action.notes || '',
          start: action.slot.start,
          end: action.slot.end,
          staffId: action.slot.staffId ?? undefined,
          serviceId: action.slot.serviceId ?? undefined,
          appointmentType: 'service',
          contextType: 'service',
        },
        { kind: 'customer', companyId, phone },
      );
      state?.set(PENDING_AVAILABILITY_STATE_KEY, null);
      state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, null);
      state?.set(SELECTED_CALENDAR_SERVICE_STATE_KEY, null);
      this.emitCompanyEvent(companyId, {
        type: SystemEventType.APPOINTMENT_CREATED,
        payload: { appointmentId: appointment.id },
      });
      state?.set(LAST_CALENDAR_OUTCOME_STATE_KEY, {
        requestedAt:
          this.stateString(state.get('app:currentDateTime')) ??
          new Date().toISOString(),
        kind: 'created',
        appointmentId: appointment.id,
      });
      return {
        success: true,
        appointmentId: appointment.id,
        link: appointment.google_calendar_link,
        syncStatus: appointment.sync_status,
        message: `¡Listo${userName ? `, ${userName}` : ''}! Tu ${action.serviceName || 'cita'} quedó reservada para ${this.formatDateTime(action.slot.start, timezone)}${action.slot.staffName ? ` con ${action.slot.staffName}` : ''}.`,
      };
    }

    if (action.kind === 'reschedule') {
      const appointment = await this.appointmentsService.reschedule(
        companyId,
        action.appointmentId,
        action.slot.start,
        action.slot.end,
        { kind: 'customer', companyId, phone },
      );
      state?.set(PENDING_AVAILABILITY_STATE_KEY, null);
      state?.set(PENDING_RESCHEDULE_TARGET_STATE_KEY, null);
      state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, null);
      state?.set(LAST_CALENDAR_OUTCOME_STATE_KEY, {
        requestedAt:
          this.stateString(state.get('app:currentDateTime')) ??
          new Date().toISOString(),
        kind: 'rescheduled',
        appointmentId: appointment.id,
      });
      return {
        success: true,
        appointmentId: appointment.id,
        syncStatus: appointment.sync_status,
        message: `¡Listo! Tu cita fue reprogramada para ${this.formatDateTime(action.slot.start, timezone)}.`,
      };
    }

    const appointment = await this.appointmentsService.cancel(
      companyId,
      action.appointmentId,
      action.reason,
      { kind: 'customer', companyId, phone },
    );
    state?.set(PENDING_CALENDAR_ACTION_STATE_KEY, null);
    state?.set(LAST_CALENDAR_OUTCOME_STATE_KEY, {
      requestedAt:
        this.stateString(state.get('app:currentDateTime')) ??
        new Date().toISOString(),
      kind: 'cancelled',
      appointmentId: appointment.id,
    });
    return {
      success: true,
      appointmentId: appointment.id,
      status: appointment.status,
      syncStatus: appointment.sync_status,
      message: `Tu cita del ${this.formatDateTime(action.scheduledStart, timezone)} fue cancelada. Si quieres, puedo ayudarte a encontrar otro horario.`,
    };
  }

  private formatDateTime(value: string, timezone?: string): string {
    return new Intl.DateTimeFormat('es-BO', {
      timeZone: timezone || 'America/La_Paz',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  }

  private matchesTimePreference(
    value: string,
    timezone: string,
    preference: 'morning' | 'afternoon' | 'evening',
  ): boolean {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        hour12: false,
      }).format(new Date(value)),
    );
    if (preference === 'morning') return hour < 12;
    if (preference === 'afternoon') return hour >= 12 && hour < 18;
    return hour >= 18;
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
}
