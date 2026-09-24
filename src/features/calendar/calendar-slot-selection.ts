import type { AvailabilitySlot } from './calendar.types';
import { randomBytes } from 'node:crypto';

export const CALENDAR_SLOT_PREFIX = 'calendar_slot:';
export const CALENDAR_ACTION_PREFIX = 'calendar_action:';
export const CALENDAR_SERVICE_PREFIX = 'calendar_service:';
export const CALENDAR_APPOINTMENT_PREFIX = 'calendar_appointment:';
export const CALENDAR_FOLLOWUP_PREFIX = 'calendar_followup:';
export const PENDING_AVAILABILITY_STATE_KEY = 'app:pendingAvailability';
export const PENDING_CALENDAR_ACTION_STATE_KEY = 'app:pendingCalendarAction';
export const PENDING_RESCHEDULE_TARGET_STATE_KEY =
  'app:pendingRescheduleTarget';
export const PENDING_SERVICE_CATALOG_STATE_KEY = 'app:pendingServiceCatalog';
export const SELECTED_CALENDAR_SERVICE_STATE_KEY =
  'app:selectedCalendarService';
export const PENDING_APPOINTMENT_SELECTION_STATE_KEY =
  'app:pendingAppointmentSelection';
export const LAST_CALENDAR_OUTCOME_STATE_KEY = 'app:lastCalendarOutcome';
export const CALENDAR_PENDING_TTL_MS = 10 * 60 * 1000;

export type CalendarSlotOperation = 'create' | 'reschedule';

export interface CalendarServiceSelection {
  id: string;
  token: string;
  name: string;
  description: string | null;
  durationMinutes: number | null;
  price: number | null;
  currency: string | null;
}

export interface PendingServiceCatalog {
  requestedAt: string;
  services: CalendarServiceSelection[];
}

export interface PendingAppointmentSelection {
  requestedAt: string;
  operation: 'cancel' | 'reschedule';
  appointments: Array<{
    id: string;
    token: string;
    title: string | null;
    start: string;
    end: string;
  }>;
}

export interface CalendarOutcome {
  requestedAt: string;
  kind: 'created' | 'rescheduled' | 'cancelled';
  appointmentId: string;
}

export interface PendingCalendarSlot extends AvailabilitySlot {
  token: string;
}

export interface PendingAvailability {
  requestTime: string;
  date: string;
  timezone: string;
  serviceName?: string;
  operation: CalendarSlotOperation;
  appointmentId?: string;
  slots: PendingCalendarSlot[];
}

export interface PendingRescheduleTarget {
  appointmentId: string;
  title: string | null;
  serviceId: string | null;
  staffId: string | null;
  durationMinutes: number;
}

export type PendingCalendarAction =
  | {
      kind: 'create';
      requestedAt: string;
      slot: PendingCalendarSlot;
      serviceName?: string;
      servicePrice?: number | null;
      currency?: string | null;
      notes?: string;
    }
  | {
      kind: 'reschedule';
      requestedAt: string;
      appointmentId: string;
      slot: PendingCalendarSlot;
      title?: string | null;
    }
  | {
      kind: 'cancel';
      requestedAt: string;
      appointmentId: string;
      title?: string | null;
      scheduledStart: string;
      reason?: string;
    };

export function createPendingAvailability(params: {
  requestTime: string;
  date: string;
  timezone: string;
  serviceName?: string;
  operation?: CalendarSlotOperation;
  appointmentId?: string;
  slots: AvailabilitySlot[];
}): PendingAvailability {
  const selectionId = randomBytes(6).toString('base64url');
  return {
    requestTime: params.requestTime,
    date: params.date,
    timezone: params.timezone,
    serviceName: params.serviceName,
    operation: params.operation ?? 'create',
    appointmentId: params.appointmentId,
    slots: params.slots.slice(0, 10).map((slot, index) => ({
      ...slot,
      token: encodeSlotToken(index, params.operation ?? 'create', selectionId),
    })),
  };
}

export function readPendingAvailability(
  value: unknown,
): PendingAvailability | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingAvailability>;
  if (
    typeof candidate.requestTime !== 'string' ||
    typeof candidate.date !== 'string' ||
    typeof candidate.timezone !== 'string' ||
    (candidate.operation !== 'create' &&
      candidate.operation !== 'reschedule') ||
    !Array.isArray(candidate.slots)
  ) {
    return null;
  }
  return candidate as PendingAvailability;
}

export function findPendingCalendarSlot(
  pendingValue: unknown,
  token: string,
): PendingCalendarSlot | null {
  const pending = readPendingAvailability(pendingValue);
  const requestedAt = pending ? Date.parse(pending.requestTime) : Number.NaN;
  if (
    !pending ||
    !Number.isFinite(requestedAt) ||
    Date.now() - requestedAt > CALENDAR_PENDING_TTL_MS
  ) {
    return null;
  }
  return pending?.slots.find((slot) => slot.token === token) ?? null;
}

export function isCalendarSlotToken(value: string): boolean {
  return value.startsWith(CALENDAR_SLOT_PREFIX);
}

export function readPendingCalendarAction(
  value: unknown,
): PendingCalendarAction | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingCalendarAction>;
  if (
    !['create', 'reschedule', 'cancel'].includes(candidate.kind ?? '') ||
    typeof candidate.requestedAt !== 'string'
  ) {
    return null;
  }
  const requestedAt = Date.parse(candidate.requestedAt);
  if (
    !Number.isFinite(requestedAt) ||
    Date.now() - requestedAt > CALENDAR_PENDING_TTL_MS
  ) {
    return null;
  }
  return candidate as PendingCalendarAction;
}

export function readPendingRescheduleTarget(
  value: unknown,
): PendingRescheduleTarget | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingRescheduleTarget>;
  if (
    typeof candidate.appointmentId !== 'string' ||
    typeof candidate.durationMinutes !== 'number'
  ) {
    return null;
  }
  return candidate as PendingRescheduleTarget;
}

export function isCalendarActionToken(value: string): boolean {
  return value.startsWith(CALENDAR_ACTION_PREFIX);
}

export function createPendingServiceCatalog(params: {
  requestedAt: string;
  services: Array<Omit<CalendarServiceSelection, 'token'>>;
}): PendingServiceCatalog {
  return {
    requestedAt: params.requestedAt,
    services: params.services.slice(0, 10).map((service) => ({
      ...service,
      token: `${CALENDAR_SERVICE_PREFIX}${service.id}`,
    })),
  };
}

export function readPendingServiceCatalog(
  value: unknown,
): PendingServiceCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingServiceCatalog>;
  const requestedAt = Date.parse(candidate.requestedAt ?? '');
  if (
    typeof candidate.requestedAt !== 'string' ||
    !Array.isArray(candidate.services) ||
    !Number.isFinite(requestedAt) ||
    Date.now() - requestedAt > CALENDAR_PENDING_TTL_MS
  ) {
    return null;
  }
  return candidate as PendingServiceCatalog;
}

export function findPendingService(
  value: unknown,
  token: string,
): CalendarServiceSelection | null {
  return (
    readPendingServiceCatalog(value)?.services.find(
      (service) => service.token === token,
    ) ?? null
  );
}

export function readSelectedCalendarService(
  value: unknown,
): CalendarServiceSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CalendarServiceSelection>;
  return typeof candidate.id === 'string' && typeof candidate.name === 'string'
    ? (candidate as CalendarServiceSelection)
    : null;
}

export function createPendingAppointmentSelection(params: {
  requestedAt: string;
  operation: 'cancel' | 'reschedule';
  appointments: Array<{
    id: string;
    title: string | null;
    start: string;
    end: string;
  }>;
}): PendingAppointmentSelection {
  return {
    requestedAt: params.requestedAt,
    operation: params.operation,
    appointments: params.appointments.slice(0, 10).map((appointment) => ({
      ...appointment,
      token: `${CALENDAR_APPOINTMENT_PREFIX}${params.operation}:${appointment.id}`,
    })),
  };
}

export function readPendingAppointmentSelection(
  value: unknown,
): PendingAppointmentSelection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PendingAppointmentSelection>;
  const requestedAt = Date.parse(candidate.requestedAt ?? '');
  if (
    typeof candidate.requestedAt !== 'string' ||
    !['cancel', 'reschedule'].includes(candidate.operation ?? '') ||
    !Array.isArray(candidate.appointments) ||
    !Number.isFinite(requestedAt) ||
    Date.now() - requestedAt > CALENDAR_PENDING_TTL_MS
  ) {
    return null;
  }
  return candidate as PendingAppointmentSelection;
}

export function readCalendarOutcome(value: unknown): CalendarOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CalendarOutcome>;
  const requestedAt = Date.parse(candidate.requestedAt ?? '');
  if (
    typeof candidate.requestedAt !== 'string' ||
    typeof candidate.appointmentId !== 'string' ||
    !['created', 'rescheduled', 'cancelled'].includes(candidate.kind ?? '') ||
    !Number.isFinite(requestedAt) ||
    Date.now() - requestedAt > CALENDAR_PENDING_TTL_MS
  ) {
    return null;
  }
  return candidate as CalendarOutcome;
}

export function describeCalendarSlotSelection(token: string): string {
  if (isCalendarSlotToken(token)) {
    const tool = token.startsWith(`${CALENDAR_SLOT_PREFIX}reschedule:`)
      ? 'reschedule_appointment'
      : 'create_appointment';
    return `El cliente seleccionó un horario exacto. Usa ${tool} con slotToken="${token}" y no reconstruyas la fecha ni la hora desde el historial.`;
  }
  if (token === `${CALENDAR_ACTION_PREFIX}confirm`) {
    return 'El cliente confirmó la operación de calendario pendiente. Usa confirm_calendar_action con confirm=true.';
  }
  if (token === `${CALENDAR_ACTION_PREFIX}discard`) {
    return 'El cliente descartó la operación de calendario pendiente. Usa confirm_calendar_action con confirm=false.';
  }
  if (token.startsWith(CALENDAR_SERVICE_PREFIX)) {
    return `El cliente seleccionó un servicio exacto. Usa select_calendar_service con serviceToken="${token}" y conserva esa selección para consultar disponibilidad.`;
  }
  if (token.startsWith(`${CALENDAR_APPOINTMENT_PREFIX}cancel:`)) {
    const appointmentId = token.slice(
      `${CALENDAR_APPOINTMENT_PREFIX}cancel:`.length,
    );
    return `El cliente seleccionó la cita que desea cancelar. Usa cancel_appointment con appointmentId="${appointmentId}".`;
  }
  if (token.startsWith(`${CALENDAR_APPOINTMENT_PREFIX}reschedule:`)) {
    const appointmentId = token.slice(
      `${CALENDAR_APPOINTMENT_PREFIX}reschedule:`.length,
    );
    return `El cliente seleccionó la cita que desea reprogramar. Usa reschedule_appointment con appointmentId="${appointmentId}" y, si aún no indicó el nuevo horario, prepárala para consultar disponibilidad.`;
  }
  if (token.startsWith(`${CALENDAR_FOLLOWUP_PREFIX}cancel:`)) {
    const appointmentId = token.slice(
      `${CALENDAR_FOLLOWUP_PREFIX}cancel:`.length,
    );
    return `El cliente quiere cancelar la cita recién gestionada. Usa cancel_appointment con appointmentId="${appointmentId}".`;
  }
  if (token.startsWith(`${CALENDAR_FOLLOWUP_PREFIX}reschedule:`)) {
    const appointmentId = token.slice(
      `${CALENDAR_FOLLOWUP_PREFIX}reschedule:`.length,
    );
    return `El cliente quiere reprogramar la cita recién gestionada. Usa reschedule_appointment con appointmentId="${appointmentId}" para preparar el cambio.`;
  }
  if (token === `${CALENDAR_FOLLOWUP_PREFIX}new`) {
    return 'El cliente quiere reservar otra cita. Usa list_bookable_services para comenzar sin perder sus datos.';
  }
  return token;
}

function encodeSlotToken(
  index: number,
  operation: CalendarSlotOperation,
  selectionId: string,
): string {
  return `${CALENDAR_SLOT_PREFIX}${operation}:${selectionId}:${index}`;
}
