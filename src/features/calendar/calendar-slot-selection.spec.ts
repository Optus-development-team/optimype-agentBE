import {
  createPendingAppointmentSelection,
  createPendingAvailability,
  createPendingServiceCatalog,
  describeCalendarSlotSelection,
  findPendingCalendarSlot,
  PENDING_CALENDAR_ACTION_STATE_KEY,
  readPendingCalendarAction,
  readPendingAppointmentSelection,
  isCalendarSlotToken,
} from './calendar-slot-selection';

describe('calendar slot selection', () => {
  const pending = createPendingAvailability({
    requestTime: new Date().toISOString(),
    date: '2026-08-31',
    timezone: 'America/La_Paz',
    slots: [
      {
        start: '2026-08-31T20:00:00.000Z',
        end: '2026-08-31T20:30:00.000Z',
        staffId: 'd16b0000-0000-4000-8000-000000000201',
        staffName: 'Erick',
        serviceId: 'd16b0000-0000-4000-8000-000000000401',
        durationMinutes: 30,
      },
    ],
  });

  it('crea un identificador compatible con WhatsApp y conserva el slot', () => {
    const token = pending.slots[0].token;
    expect(isCalendarSlotToken(token)).toBe(true);
    expect(token.length).toBeLessThanOrEqual(200);
    expect(findPendingCalendarSlot(pending, token)).toMatchObject({
      start: '2026-08-31T20:00:00.000Z',
      end: '2026-08-31T20:30:00.000Z',
      staffName: 'Erick',
    });
  });

  it('rechaza un token que no pertenece a la disponibilidad de la sesión', () => {
    expect(
      findPendingCalendarSlot(pending, 'calendar_slot:alterado'),
    ).toBeNull();
  });

  it('rechaza un horario perteneciente a una consulta anterior', () => {
    const newerPending = createPendingAvailability({
      requestTime: new Date().toISOString(),
      date: pending.date,
      timezone: pending.timezone,
      slots: pending.slots,
    });

    expect(newerPending.slots[0].token).not.toBe(pending.slots[0].token);
    expect(
      findPendingCalendarSlot(newerPending, pending.slots[0].token),
    ).toBeNull();
  });

  it('convierte la selección en una instrucción inequívoca para el agente', () => {
    const text = describeCalendarSlotSelection(pending.slots[0].token);
    expect(text).toContain('create_appointment');
    expect(text).toContain('slotToken=');
    expect(text).toContain(pending.slots[0].token);
  });

  it('dirige los slots de reprogramación a la herramienta correcta', () => {
    const reschedule = createPendingAvailability({
      requestTime: new Date().toISOString(),
      date: '2026-08-31',
      timezone: 'America/La_Paz',
      operation: 'reschedule',
      appointmentId: '50ca3931-3b9f-47bb-a120-88f0bf844507',
      slots: pending.slots,
    });
    expect(describeCalendarSlotSelection(reschedule.slots[0].token)).toContain(
      'reschedule_appointment',
    );
  });

  it('rechaza confirmaciones pendientes vencidas', () => {
    expect(PENDING_CALENDAR_ACTION_STATE_KEY).toBe('app:pendingCalendarAction');
    expect(
      readPendingCalendarAction({
        kind: 'cancel',
        requestedAt: '2020-01-01T00:00:00.000Z',
        appointmentId: 'a1',
        scheduledStart: '2026-08-31T20:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('genera tokens seguros para elegir qué cita reprogramar', () => {
    const selection = createPendingAppointmentSelection({
      requestedAt: new Date().toISOString(),
      operation: 'reschedule',
      appointments: [
        {
          id: '50ca3931-3b9f-47bb-a120-88f0bf844507',
          title: 'Corte clásico',
          start: '2026-08-31T20:00:00.000Z',
          end: '2026-08-31T20:30:00.000Z',
        },
      ],
    });
    expect(readPendingAppointmentSelection(selection)).not.toBeNull();
    expect(
      describeCalendarSlotSelection(selection.appointments[0].token),
    ).toContain('reschedule_appointment');
  });

  it('mantiene el servicio exacto seleccionado desde la lista', () => {
    const catalog = createPendingServiceCatalog({
      requestedAt: new Date().toISOString(),
      services: [
        {
          id: 'service-1',
          name: 'Corte y barba',
          description: null,
          durationMinutes: 60,
          price: 80,
          currency: 'BOB',
        },
      ],
    });
    expect(catalog.services[0]).toMatchObject({
      name: 'Corte y barba',
      durationMinutes: 60,
      price: 80,
    });
    expect(describeCalendarSlotSelection(catalog.services[0].token)).toContain(
      'select_calendar_service',
    );
  });
});
