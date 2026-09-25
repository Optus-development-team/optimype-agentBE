import { BadRequestException, Injectable } from '@nestjs/common';
import dayjs, { type Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import {
  BookingPolicyService,
  type BusinessInterval,
} from './booking-policy.service';
import type { AvailabilitySlot } from './calendar.types';

dayjs.extend(utc);
dayjs.extend(timezone);

interface StaffCandidate {
  id: string;
  name: string;
  custom_duration_minutes: number | null;
}

interface BusyRange {
  staff_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: SupabaseService,
    private readonly policies: BookingPolicyService,
  ) {}

  async list(params: {
    companyId: string;
    date: string;
    serviceId?: string;
    staffId?: string;
    durationMinutes?: number;
    excludeAppointmentId?: string;
  }): Promise<AvailabilitySlot[]> {
    const policy = await this.policies.get(params.companyId);
    const localDate = dayjs.tz(params.date, 'YYYY-MM-DD', policy.timezone);
    if (
      !localDate.isValid() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(params.date) ||
      localDate.format('YYYY-MM-DD') !== params.date
    ) {
      throw new BadRequestException('Fecha inválida; usa YYYY-MM-DD');
    }
    this.assertDatePolicy(
      localDate,
      policy.timezone,
      policy.minAdvanceMinutes,
      policy.maxAdvanceDays,
    );

    const service = params.serviceId
      ? await this.getService(params.companyId, params.serviceId)
      : null;
    const defaultDuration =
      params.durationMinutes ??
      service?.duration_minutes ??
      policy.slotDurationMinutes;
    if (defaultDuration <= 0) {
      throw new BadRequestException('La duración debe ser mayor a cero');
    }

    const staff = await this.getStaff(
      params.companyId,
      params.serviceId,
      params.staffId,
    );
    if (!staff.length) return [];

    const dayStart = localDate.startOf('day');
    const dayEnd = localDate.endOf('day');
    const [workingHours, appointments, timeOff] = await Promise.all([
      this.getWorkingHours(
        params.companyId,
        staff.map((item) => item.id),
        localDate.day(),
        localDate.format('YYYY-MM-DD'),
      ),
      this.getAppointments(
        params.companyId,
        staff.map((item) => item.id),
        dayStart.subtract(policy.bufferMinutes, 'minute').toISOString(),
        dayEnd.add(policy.bufferMinutes, 'minute').toISOString(),
        params.excludeAppointmentId,
      ),
      this.getTimeOff(
        params.companyId,
        staff.map((item) => item.id),
        dayStart.toISOString(),
        dayEnd.toISOString(),
      ),
    ]);

    const slots: AvailabilitySlot[] = [];
    for (const candidate of staff) {
      const intervals =
        workingHours.intervals.get(candidate.id) ??
        (workingHours.configured.has(candidate.id)
          ? []
          : (policy.businessHours[localDate.day()] ?? []));
      const duration = candidate.custom_duration_minutes ?? defaultDuration;
      for (const interval of intervals) {
        slots.push(
          ...this.generateSlots({
            date: localDate,
            interval,
            timezone: policy.timezone,
            stepMinutes: policy.slotDurationMinutes,
            durationMinutes: duration,
            bufferMinutes: policy.bufferMinutes,
            candidate,
            serviceId: params.serviceId ?? null,
            appointments,
            timeOff,
            minAdvanceMinutes: policy.minAdvanceMinutes,
          }),
        );
      }
    }
    return slots.sort(
      (left, right) =>
        dayjs(left.start).valueOf() - dayjs(right.start).valueOf() ||
        (left.staffName ?? '').localeCompare(right.staffName ?? ''),
    );
  }

  async selectStaffForRange(params: {
    companyId: string;
    start: string;
    end: string;
    serviceId?: string;
    staffId?: string;
    excludeAppointmentId?: string;
  }): Promise<{ staffId: string | undefined; bufferMinutes: number }> {
    const policy = await this.policies.get(params.companyId);
    const start = dayjs(params.start);
    const end = dayjs(params.end);
    if (!start.isValid() || !end.isAfter(start)) {
      throw new BadRequestException('El rango de la cita no es válido');
    }
    const duration = end.diff(start, 'minute');
    const slots = await this.list({
      companyId: params.companyId,
      date: start.tz(policy.timezone).format('YYYY-MM-DD'),
      serviceId: params.serviceId,
      staffId: params.staffId,
      durationMinutes: duration,
      excludeAppointmentId: params.excludeAppointmentId,
    });
    const match = slots.find(
      (slot) =>
        dayjs(slot.start).valueOf() === start.valueOf() &&
        dayjs(slot.end).valueOf() === end.valueOf(),
    );
    if (!match) {
      throw new BadRequestException(
        'El horario no está disponible o no cumple las reglas del negocio',
      );
    }
    return {
      staffId: match.staffId ?? undefined,
      bufferMinutes: policy.bufferMinutes,
    };
  }

  private generateSlots(params: {
    date: Dayjs;
    interval: BusinessInterval;
    timezone: string;
    stepMinutes: number;
    durationMinutes: number;
    bufferMinutes: number;
    candidate: StaffCandidate;
    serviceId: string | null;
    appointments: BusyRange[];
    timeOff: BusyRange[];
    minAdvanceMinutes: number;
  }): AvailabilitySlot[] {
    const date = params.date.format('YYYY-MM-DD');
    let cursor = dayjs.tz(
      `${date} ${params.interval.start}`,
      'YYYY-MM-DD HH:mm',
      params.timezone,
    );
    const intervalEnd = dayjs.tz(
      `${date} ${params.interval.end}`,
      'YYYY-MM-DD HH:mm',
      params.timezone,
    );
    const earliest = dayjs().add(params.minAdvanceMinutes, 'minute');
    const result: AvailabilitySlot[] = [];

    while (!cursor.add(params.durationMinutes, 'minute').isAfter(intervalEnd)) {
      const end = cursor.add(params.durationMinutes, 'minute');
      const blocked = [...params.appointments, ...params.timeOff]
        .filter((range) => range.staff_id === params.candidate.id)
        .some((range) => {
          const rangeStart = dayjs(range.starts_at).subtract(
            params.bufferMinutes,
            'minute',
          );
          const rangeEnd = dayjs(range.ends_at).add(
            params.bufferMinutes,
            'minute',
          );
          return cursor.isBefore(rangeEnd) && end.isAfter(rangeStart);
        });
      if (!blocked && !cursor.isBefore(earliest)) {
        result.push({
          start: cursor.toISOString(),
          end: end.toISOString(),
          staffId: params.candidate.id,
          staffName: params.candidate.name,
          serviceId: params.serviceId,
          durationMinutes: params.durationMinutes,
        });
      }
      cursor = cursor.add(params.stepMinutes, 'minute');
    }
    return result;
  }

  private async getService(companyId: string, serviceId: string) {
    const rows = await this.db.query<{
      id: string;
      duration_minutes: number | null;
    }>(
      `SELECT id, duration_minutes FROM catalog_items
        WHERE id = $1 AND company_id = $2 AND is_active = TRUE
          AND item_type = 'service' AND is_bookable = TRUE LIMIT 1`,
      [serviceId, companyId],
    );
    if (!rows[0]) throw new BadRequestException('Servicio no disponible');
    return rows[0];
  }

  private async getStaff(
    companyId: string,
    serviceId?: string,
    staffId?: string,
  ): Promise<StaffCandidate[]> {
    return this.db.query<StaffCandidate>(
      `SELECT cs.id,
              TRIM(cs.first_name || ' ' || COALESCE(cs.last_name, '')) AS name,
              scs.custom_duration_minutes
         FROM company_staff cs
         LEFT JOIN staff_catalog_services scs
           ON scs.staff_id = cs.id AND scs.catalog_item_id = $2::uuid
          AND scs.is_active = TRUE
        WHERE cs.company_id = $1 AND cs.is_active = TRUE
          AND COALESCE(cs.calendar_sync_enabled, TRUE) = TRUE
          AND ($3::uuid IS NULL OR cs.id = $3)
          AND (
            $2::uuid IS NULL OR scs.id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM staff_catalog_services configured
               WHERE configured.company_id = $1
                 AND configured.catalog_item_id = $2
                 AND configured.is_active = TRUE
            )
          )
        ORDER BY (scs.id IS NOT NULL) DESC,
                 EXISTS (
                   SELECT 1
                     FROM google_calendar_registry registry
                    WHERE registry.company_id = cs.company_id
                      AND registry.assigned_to_staff_id = cs.id
                      AND registry.is_active = TRUE
                 ) DESC,
                 cs.created_at ASC`,
      [companyId, serviceId ?? null, staffId ?? null],
    );
  }

  private async getWorkingHours(
    companyId: string,
    staffIds: string[],
    day: number,
    date: string,
  ): Promise<{
    intervals: Map<string, BusinessInterval[]>;
    configured: Set<string>;
  }> {
    const [rows, configuredRows] = await Promise.all([
      this.db.query<{
        staff_id: string;
        start_time: string;
        end_time: string;
      }>(
        `SELECT staff_id, start_time::text, end_time::text
         FROM staff_working_hours
        WHERE company_id = $1 AND staff_id = ANY($2::uuid[])
          AND day_of_week = $3 AND is_active = TRUE
          AND (effective_from IS NULL OR effective_from <= $4::date)
          AND (effective_to IS NULL OR effective_to >= $4::date)
        ORDER BY start_time`,
        [companyId, staffIds, day, date],
      ),
      this.db.query<{ staff_id: string }>(
        `SELECT DISTINCT staff_id FROM staff_working_hours
        WHERE company_id = $1 AND staff_id = ANY($2::uuid[])
          AND is_active = TRUE
          AND (effective_from IS NULL OR effective_from <= $3::date)
          AND (effective_to IS NULL OR effective_to >= $3::date)`,
        [companyId, staffIds, date],
      ),
    ]);
    const result = new Map<string, BusinessInterval[]>();
    for (const row of rows) {
      const items = result.get(row.staff_id) ?? [];
      items.push({
        start: row.start_time.slice(0, 5),
        end: row.end_time.slice(0, 5),
      });
      result.set(row.staff_id, items);
    }
    return {
      intervals: result,
      configured: new Set(configuredRows.map((row) => row.staff_id)),
    };
  }

  private getAppointments(
    companyId: string,
    staffIds: string[],
    start: string,
    end: string,
    excludeAppointmentId?: string,
  ): Promise<BusyRange[]> {
    return this.db.query<BusyRange>(
      `SELECT staff_id, scheduled_start AS starts_at, scheduled_end AS ends_at
         FROM appointments
        WHERE company_id = $1 AND staff_id = ANY($2::uuid[])
          AND status IN ('pending', 'confirmed')
          AND ($5::uuid IS NULL OR id <> $5)
          AND scheduled_start < $4 AND scheduled_end > $3`,
      [companyId, staffIds, start, end, excludeAppointmentId ?? null],
    );
  }

  private getTimeOff(
    companyId: string,
    staffIds: string[],
    start: string,
    end: string,
  ): Promise<BusyRange[]> {
    return this.db.query<BusyRange>(
      `SELECT staff_id, starts_at, ends_at FROM staff_time_off
        WHERE company_id = $1 AND staff_id = ANY($2::uuid[])
          AND status = 'approved' AND starts_at < $4 AND ends_at > $3`,
      [companyId, staffIds, start, end],
    );
  }

  private assertDatePolicy(
    localDate: Dayjs,
    timezoneName: string,
    minAdvanceMinutes: number,
    maxAdvanceDays: number,
  ): void {
    const now = dayjs().tz(timezoneName);
    if (localDate.endOf('day').isBefore(now.add(minAdvanceMinutes, 'minute'))) {
      throw new BadRequestException('La fecha ya no admite reservas');
    }
    if (
      localDate
        .startOf('day')
        .isAfter(now.add(maxAdvanceDays, 'day').endOf('day'))
    ) {
      throw new BadRequestException(
        'La fecha supera la anticipación máxima permitida',
      );
    }
  }
}
