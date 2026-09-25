import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';

export interface BusinessInterval {
  start: string;
  end: string;
}

export interface BookingPolicy {
  timezone: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  maxAdvanceDays: number;
  minAdvanceMinutes: number;
  cancellationNoticeMinutes: number;
  remindersMinutes: number[];
  businessHours: Record<number, BusinessInterval[]>;
}

@Injectable()
export class BookingPolicyService {
  constructor(private readonly db: SupabaseService) {}

  async get(companyId: string): Promise<BookingPolicy> {
    const rows = await this.db.query<{
      timezone: string | null;
      business_hours: unknown;
      config: unknown;
    }>(
      `SELECT timezone, business_hours, config
         FROM companies WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Empresa no encontrada');
    const config = this.object(row.config);
    // companies.config v3; `appointment_policy` es la clave v2 equivalente.
    const appointment = this.object(
      config.agent_client_appointment_policy ?? config.appointment_policy,
    );
    const operational = this.object(config.operational_rules);
    const configuredHours = this.object(row.business_hours);
    const legacyHours = this.object(operational.opening_hours);

    return {
      timezone: row.timezone || 'America/La_Paz',
      slotDurationMinutes: this.positiveInt(
        appointment.slot_duration_minutes,
        30,
      ),
      bufferMinutes: this.nonNegativeInt(
        appointment.buffer_between_appointments_minutes,
        0,
      ),
      maxAdvanceDays: this.positiveInt(
        appointment.max_advance_booking_days,
        30,
      ),
      minAdvanceMinutes: this.nonNegativeInt(
        appointment.min_advance_booking_minutes,
        60,
      ),
      cancellationNoticeMinutes: this.nonNegativeInt(
        appointment.cancellation_notice_minutes,
        120,
      ),
      remindersMinutes: this.numberArray(
        appointment.reminders_minutes,
        [1440, 120],
      ),
      businessHours: this.parseHours(configuredHours, legacyHours),
    };
  }

  async update(
    companyId: string,
    input: Partial<Omit<BookingPolicy, 'businessHours'>> & {
      businessHours?: Record<number, BusinessInterval[]>;
    },
  ): Promise<BookingPolicy> {
    this.validate(input);
    const appointmentPolicy = {
      slot_duration_minutes: input.slotDurationMinutes,
      buffer_between_appointments_minutes: input.bufferMinutes,
      max_advance_booking_days: input.maxAdvanceDays,
      min_advance_booking_minutes: input.minAdvanceMinutes,
      cancellation_notice_minutes: input.cancellationNoticeMinutes,
      reminders_minutes: input.remindersMinutes,
    };
    const clean = Object.fromEntries(
      Object.entries(appointmentPolicy).filter(
        ([, value]) => value !== undefined,
      ),
    );
    await this.db.query(
      `UPDATE companies
          SET timezone = COALESCE($2, timezone),
              business_hours = CASE WHEN $3::jsonb IS NULL
                THEN business_hours ELSE $3::jsonb END,
              config = jsonb_set(
                COALESCE(config, '{}'::jsonb),
                '{agent_client_appointment_policy}',
                COALESCE(config->'agent_client_appointment_policy', '{}'::jsonb) || $4::jsonb,
                TRUE
              ),
              updated_at = NOW()
        WHERE id = $1`,
      [companyId, input.timezone ?? null, input.businessHours ?? null, clean],
    );
    return this.get(companyId);
  }

  private parseHours(
    configured: Record<string, unknown>,
    legacy: Record<string, unknown>,
  ): Record<number, BusinessInterval[]> {
    const result: Record<number, BusinessInterval[]> = {};
    const names = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ];
    names.forEach((name, day) => {
      const raw = configured[name] ?? configured[String(day)];
      if (raw !== undefined) result[day] = this.intervals(raw);
    });
    if (Object.keys(result).length) return result;

    const mondayFriday = this.intervals(legacy.monday_friday);
    for (let day = 1; day <= 5; day++) result[day] = mondayFriday;
    result[6] = this.intervals(legacy.saturday);
    result[0] = this.intervals(legacy.sunday);
    if (!Object.values(result).some((items) => items.length)) {
      for (let day = 1; day <= 5; day++) {
        result[day] = [{ start: '09:00', end: '18:00' }];
      }
    }
    return result;
  }

  private intervals(value: unknown): BusinessInterval[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => {
        const object = this.object(item);
        return typeof object.start === 'string' &&
          typeof object.end === 'string'
          ? [{ start: object.start, end: object.end }]
          : [];
      });
    }
    if (typeof value !== 'string' || /cerrado|closed/i.test(value)) return [];
    const match = value.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    return match ? [{ start: match[1], end: match[2] }] : [];
  }

  private object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private positiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private nonNegativeInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private numberArray(value: unknown, fallback: number[]): number[] {
    if (!Array.isArray(value)) return fallback;
    const parsed = value
      .map(Number)
      .filter((item) => item > 0 && Number.isInteger(item));
    return parsed.length ? parsed : fallback;
  }

  private validate(
    input: Partial<Omit<BookingPolicy, 'businessHours'>> & {
      businessHours?: Record<number, BusinessInterval[]>;
    },
  ): void {
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat('es', { timeZone: input.timezone }).format();
      } catch {
        throw new BadRequestException('Zona horaria inválida');
      }
    }
    if (input.remindersMinutes) {
      const invalid = input.remindersMinutes.some(
        (minutes) => !Number.isInteger(minutes) || minutes <= 0,
      );
      if (invalid) {
        throw new BadRequestException(
          'Los recordatorios deben expresarse en minutos positivos',
        );
      }
    }
    for (const [day, intervals] of Object.entries(input.businessHours ?? {})) {
      const dayNumber = Number(day);
      if (!Number.isInteger(dayNumber) || dayNumber < 0 || dayNumber > 6) {
        throw new BadRequestException(`Día de semana inválido: ${day}`);
      }
      for (const [index, interval] of intervals.entries()) {
        if (
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(interval.start) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(interval.end) ||
          interval.start >= interval.end
        ) {
          throw new BadRequestException(`Horario inválido para el día ${day}`);
        }
        if (
          intervals.some(
            (candidate, candidateIndex) =>
              candidateIndex !== index &&
              interval.start < candidate.end &&
              interval.end > candidate.start,
          )
        ) {
          throw new BadRequestException(
            `Existen horarios solapados para el día ${day}`,
          );
        }
      }
    }
  }
}
