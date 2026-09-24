import { BadRequestException } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import type { AppointmentRecord } from './calendar.types';

const appointment = (
  overrides: Partial<AppointmentRecord> = {},
): AppointmentRecord => ({
  id: 'a1',
  company_id: 'c1',
  customer_id: 'u1',
  staff_id: null,
  appointment_type: 'service',
  context_type: 'service',
  title: 'Cita',
  description: null,
  scheduled_start: '2026-08-21T14:00:00.000Z',
  scheduled_end: '2026-08-21T14:30:00.000Z',
  location: null,
  status: 'confirmed',
  metadata: {},
  google_calendar_event_id: null,
  google_calendar_link: null,
  sync_status: 'pending',
  sync_error_message: null,
  last_synced_at: null,
  google_updated_at: null,
  db_updated_at: '2026-08-20T10:00:00.000Z',
  sync_direction: 'bidirectional',
  conflict_resolution: null,
  target_calendar_id: null,
  ...overrides,
});

describe('AppointmentsService', () => {
  const repository = {
    findOverlapping: jest.fn(),
    findAvailableStaff: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    cancel: jest.fn(),
    updateSchedule: jest.fn(),
    updateStatus: jest.fn(),
    listForCustomer: jest.fn(),
    listBookableServices: jest.fn(),
    listActiveStaff: jest.fn(),
  };
  const sync = { syncAppointmentToGoogle: jest.fn() };
  const availability = { selectStaffForRange: jest.fn() };
  const policies = { get: jest.fn() };
  const access = {
    assertCustomerPhone: jest.fn(),
    assertCanModifyAppointment: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const notifications = {
    scheduleCreated: jest.fn(),
    scheduleCancelled: jest.fn(),
    scheduleRescheduled: jest.fn(),
  };
  let service: AppointmentsService;

  beforeEach(() => {
    jest.resetAllMocks();
    availability.selectStaffForRange.mockResolvedValue({
      staffId: 's1',
      bufferMinutes: 0,
    });
    audit.record.mockResolvedValue(undefined);
    notifications.scheduleCreated.mockResolvedValue(undefined);
    notifications.scheduleCancelled.mockResolvedValue(undefined);
    notifications.scheduleRescheduled.mockResolvedValue(undefined);
    service = new AppointmentsService(
      repository as never,
      sync as never,
      availability as never,
      policies as never,
      access as never,
      audit as never,
      notifications as never,
    );
  });

  it('persiste primero y devuelve la cita sincronizada', async () => {
    repository.findOverlapping.mockResolvedValue([]);
    repository.findAvailableStaff.mockResolvedValue('s1');
    repository.create.mockResolvedValue(appointment());
    sync.syncAppointmentToGoogle.mockResolvedValue(
      appointment({ sync_status: 'synced', google_calendar_event_id: 'g1' }),
    );

    const result = await service.create({
      companyId: 'c1',
      title: 'Cita',
      start: '2026-08-21T14:00:00.000Z',
      end: '2026-08-21T14:30:00.000Z',
    });

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 's1' }),
    );
    expect(sync.syncAppointmentToGoogle).toHaveBeenCalledWith('c1', 'a1');
    expect(result.sync_status).toBe('synced');
  });

  it('conserva la cita en DB cuando Google falla', async () => {
    repository.findOverlapping.mockResolvedValue([]);
    repository.create.mockResolvedValue(appointment());
    sync.syncAppointmentToGoogle.mockRejectedValue(new Error('Google offline'));
    repository.findById.mockResolvedValue(
      appointment({
        sync_status: 'error',
        sync_error_message: 'Google offline',
      }),
    );

    const result = await service.create({
      companyId: 'c1',
      title: 'Cita',
      start: '2026-08-21T14:00:00.000Z',
      end: '2026-08-21T14:30:00.000Z',
    });

    expect(result.sync_status).toBe('error');
    expect(result.id).toBe('a1');
  });

  it('rechaza horarios solapados', async () => {
    availability.selectStaffForRange.mockRejectedValue(
      new BadRequestException('Horario ocupado'),
    );
    await expect(
      service.create({
        companyId: 'c1',
        title: 'Otra cita',
        start: '2026-08-21T14:10:00.000Z',
        end: '2026-08-21T14:40:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('mantiene la duración al reprogramar', async () => {
    repository.findById.mockResolvedValue(appointment());
    repository.findOverlapping.mockResolvedValue([]);
    repository.updateSchedule.mockResolvedValue(
      appointment({
        scheduled_start: '2026-08-22T15:00:00.000Z',
        scheduled_end: '2026-08-22T15:30:00.000Z',
      }),
    );
    sync.syncAppointmentToGoogle.mockResolvedValue(
      appointment({ sync_status: 'synced' }),
    );

    await service.rescheduleKeepingDuration(
      'c1',
      'a1',
      '2026-08-22T15:00:00.000Z',
    );

    expect(repository.updateSchedule).toHaveBeenCalledWith(
      'c1',
      'a1',
      '2026-08-22T15:00:00.000Z',
      '2026-08-22T15:30:00.000Z',
      0,
    );
    expect(availability.selectStaffForRange).toHaveBeenCalledWith(
      expect.objectContaining({ excludeAppointmentId: 'a1' }),
    );
  });

  it('no pierde la respuesta si falla una tarea secundaria', async () => {
    repository.create.mockResolvedValue(appointment());
    audit.record.mockRejectedValue(new Error('audit offline'));
    notifications.scheduleCreated.mockRejectedValue(new Error('queue offline'));
    sync.syncAppointmentToGoogle.mockResolvedValue(
      appointment({ sync_status: 'synced' }),
    );

    await expect(
      service.create({
        companyId: 'c1',
        title: 'Cita',
        start: '2026-08-21T14:00:00.000Z',
        end: '2026-08-21T14:30:00.000Z',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'a1', sync_status: 'synced' }),
    );
  });

  it('rechaza transiciones de estado que reabren una cita terminada', async () => {
    repository.findById.mockResolvedValue(appointment({ status: 'completed' }));
    access.assertCanModifyAppointment.mockResolvedValue(undefined);

    await expect(
      service.updateStatus('c1', 'a1', 'confirmed', {
        kind: 'admin',
        companyId: 'c1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('resuelve un servicio por nombre ignorando mayúsculas y acentos', async () => {
    repository.listBookableServices.mockResolvedValue([
      { id: 'service-1', name: 'Corte clásico', duration_minutes: 30 },
    ]);

    await expect(
      service.resolveBookableService('c1', 'CORTE CLASICO'),
    ).resolves.toEqual({
      id: 'service-1',
      name: 'Corte clásico',
      durationMinutes: 30,
    });
  });

  it('no elige al azar cuando el servicio es ambiguo', async () => {
    repository.listBookableServices.mockResolvedValue([
      { id: 'service-1', name: 'Corte clásico', duration_minutes: 30 },
      { id: 'service-2', name: 'Corte infantil', duration_minutes: 30 },
    ]);

    await expect(
      service.resolveBookableService('c1', 'corte'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resuelve un profesional por nombre parcial sin confundir empresas', async () => {
    repository.listActiveStaff.mockResolvedValue([
      { id: 'staff-1', name: 'Fernando Silva', specialty: 'Barbería' },
    ]);

    await expect(service.resolveActiveStaff('c1', 'Fernando')).resolves.toEqual(
      { id: 'staff-1', name: 'Fernando Silva', specialty: 'Barbería' },
    );
    expect(repository.listActiveStaff).toHaveBeenCalledWith('c1', undefined);
  });

  it('pide aclaración cuando el nombre del profesional es ambiguo', async () => {
    repository.listActiveStaff.mockResolvedValue([
      { id: 'staff-1', name: 'Fernando Silva', specialty: null },
      { id: 'staff-2', name: 'Fernando Pérez', specialty: null },
    ]);

    await expect(
      service.resolveActiveStaff('c1', 'Fernando'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
