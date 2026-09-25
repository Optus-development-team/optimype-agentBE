import { BadRequestException } from '@nestjs/common';
import { BookingPolicyService } from './booking-policy.service';

describe('BookingPolicyService', () => {
  const db = { query: jest.fn() };
  const service = new BookingPolicyService(db as never);

  beforeEach(() => jest.resetAllMocks());

  it('rechaza zonas horarias inexistentes antes de escribir', async () => {
    await expect(
      service.update('c1', { timezone: 'Mars/Olympus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rechaza intervalos de negocio solapados', async () => {
    await expect(
      service.update('c1', {
        businessHours: {
          1: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '13:00' },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('lee la política de citas desde el config v3 de la empresa', async () => {
    db.query.mockResolvedValueOnce([
      {
        timezone: 'America/La_Paz',
        business_hours: {},
        config: {
          schema_version: 3,
          agent_client_appointment_policy: {
            slot_duration_minutes: 45,
            buffer_between_appointments_minutes: 10,
            min_advance_booking_minutes: 60,
            reminders_minutes: [1440],
          },
        },
      },
    ]);

    const policy = await service.get('c1');

    expect(policy).toEqual(
      expect.objectContaining({
        slotDurationMinutes: 45,
        bufferMinutes: 10,
        minAdvanceMinutes: 60,
        remindersMinutes: [1440],
      }),
    );
  });
});
