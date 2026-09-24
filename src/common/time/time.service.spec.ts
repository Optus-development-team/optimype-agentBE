import { ConfigService } from '@nestjs/config';
import { TimeService } from './time.service';

describe('TimeService', () => {
  let service: TimeService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T02:00:00.000Z'));
    service = new TimeService(new ConfigService({ TIMEZONE_FALLBACK: 'UTC' }));
  });

  afterEach(() => jest.useRealTimers());

  it('calcula hoy y mañana en la zona horaria de la empresa', () => {
    expect(service.getTodayDate('America/La_Paz')).toBe('2026-08-28');
    expect(service.resolveDateBounds('mañana', 'America/La_Paz').date).toBe(
      '2026-08-29',
    );
  });

  it('resuelve el próximo día de semana', () => {
    expect(
      service.resolveDateBounds('próximo lunes', 'America/La_Paz').date,
    ).toBe('2026-08-31');
  });

  it('convierte una hora local a un instante UTC', () => {
    expect(
      service.buildAppointmentStart('2026-08-31', '16:00', 'America/La_Paz'),
    ).toEqual({
      timezone: 'America/La_Paz',
      date: '2026-08-31',
      startIso: '2026-08-31T20:00:00.000Z',
    });
  });

  it('rechaza fechas inexistentes y horas ambiguas', () => {
    expect(() =>
      service.resolveDateBounds('2026-02-31', 'America/La_Paz'),
    ).toThrow('No pude interpretar la fecha');
    expect(() =>
      service.buildAppointmentStart('2026-08-31', '4 PM', 'America/La_Paz'),
    ).toThrow('formato de 24 horas');
  });

  it('usa el fallback cuando la zona horaria no es válida', () => {
    expect(service.getTimezone('zona/inexistente')).toBe('UTC');
  });
});
