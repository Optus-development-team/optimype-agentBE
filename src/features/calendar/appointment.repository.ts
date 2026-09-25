import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import type { SqlExecutor } from '../../common/intraestructure/supabase/supabase.service';
import type {
  AppointmentRecord,
  CalendarRegistryRecord,
  CompanyCalendarIntegration,
  CreateAppointmentInput,
} from './calendar.types';

@Injectable()
export class AppointmentRepository {
  constructor(private readonly db: SupabaseService) {}

  async create(input: CreateAppointmentInput): Promise<AppointmentRecord> {
    return this.db.withTransaction(async (transaction) => {
      if (input.customerPhone) {
        await transaction.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `customer:${input.companyId}:${this.normalizePhone(input.customerPhone)}`,
        ]);
      }
      const customerId = input.customerPhone
        ? await this.findOrCreateCustomer(
            input.companyId,
            input.customerPhone,
            input.customerName,
            transaction,
          )
        : null;
      if (input.staffId) {
        await transaction.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `appointment:${input.companyId}:${input.staffId}`,
        ]);
        const overlaps = await transaction.query<{ id: string }>(
          `SELECT id FROM appointments
            WHERE company_id = $1 AND staff_id = $2
              AND status IN ('pending', 'confirmed')
              AND scheduled_start < ($4::timestamptz + make_interval(mins => $5))
              AND scheduled_end > ($3::timestamptz - make_interval(mins => $5))
            LIMIT 1`,
          [
            input.companyId,
            input.staffId,
            input.start,
            input.end,
            input.bufferMinutes ?? 0,
          ],
        );
        if (overlaps.length) throw new Error('APPOINTMENT_SLOT_UNAVAILABLE');
      }

      const rows = await transaction.query<AppointmentRecord>(
        `INSERT INTO appointments (
           company_id, customer_id, staff_id, appointment_type, context_type,
           title, description, scheduled_start, scheduled_end, location, status,
           source, metadata, sync_status, sync_direction, target_calendar_id,
           catalog_item_id, created_by_user_id
         ) VALUES (
           $1, $2, $3, $4::appointment_type, $5::appointment_context_type,
           $6, $7, $8, $9, $10, 'confirmed'::appointment_status,
           'optus_agent', $11::jsonb, 'pending', 'bidirectional', $12,
           $13, $14
         ) RETURNING *`,
        [
          input.companyId,
          customerId,
          input.staffId ?? null,
          input.appointmentType ?? 'service',
          input.contextType ?? 'service',
          input.title,
          input.description ?? null,
          input.start,
          input.end,
          input.location ?? null,
          input.metadata ?? {},
          input.targetCalendarId ?? null,
          input.serviceId ?? null,
          input.createdByUserId ?? null,
        ],
      );
      if (!rows[0])
        throw new Error('No se pudo crear la cita en la base de datos');
      return rows[0];
    });
  }

  async findById(
    companyId: string,
    appointmentId: string,
  ): Promise<AppointmentRecord | null> {
    const rows = await this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [appointmentId, companyId],
    );
    return rows[0] ?? null;
  }

  listBookableServices(companyId: string): Promise<
    Array<{
      id: string;
      name: string;
      duration_minutes: number | null;
      description: string | null;
      sale_price: number | null;
      currency: string | null;
    }>
  > {
    return this.db.query(
      `SELECT id, name, duration_minutes, description, sale_price, currency
         FROM catalog_items
        WHERE company_id = $1 AND item_type = 'service'
          AND is_active = TRUE AND is_bookable = TRUE
        ORDER BY name`,
      [companyId],
    );
  }

  listActiveStaff(
    companyId: string,
    serviceId?: string,
  ): Promise<Array<{ id: string; name: string; specialty: string | null }>> {
    return this.db.query(
      `SELECT cs.id,
              TRIM(cs.first_name || ' ' || COALESCE(cs.last_name, '')) AS name,
              cs.specialty
         FROM company_staff cs
         LEFT JOIN staff_catalog_services scs
           ON scs.staff_id = cs.id AND scs.catalog_item_id = $2::uuid
          AND scs.is_active = TRUE
        WHERE cs.company_id = $1 AND cs.is_active = TRUE
          AND COALESCE(cs.calendar_sync_enabled, TRUE) = TRUE
          AND (
            $2::uuid IS NULL OR scs.id IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM staff_catalog_services configured
               WHERE configured.company_id = $1
                 AND configured.catalog_item_id = $2
                 AND configured.is_active = TRUE
            )
          )
        ORDER BY (scs.id IS NOT NULL) DESC, cs.first_name, cs.last_name`,
      [companyId, serviceId ?? null],
    );
  }

  async listForCustomer(
    companyId: string,
    phone: string,
    filter: 'all' | 'upcoming' | 'past' | 'cancelled' = 'upcoming',
    limit = 20,
  ): Promise<AppointmentRecord[]> {
    const predicates: Record<typeof filter, string> = {
      all: '',
      upcoming: `AND a.scheduled_end >= NOW() AND a.status <> 'cancelled'`,
      past: `AND a.scheduled_end < NOW() AND a.status <> 'cancelled'`,
      cancelled: `AND a.status = 'cancelled'`,
    };
    return this.db.query<AppointmentRecord>(
      `SELECT a.*
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
        WHERE a.company_id = $1
          AND regexp_replace(c.phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')
        ${predicates[filter]}
        ORDER BY a.scheduled_start ASC
        LIMIT $3`,
      [companyId, phone, Math.min(Math.max(limit, 1), 100)],
    );
  }

  async findOverlapping(
    companyId: string,
    start: string,
    end: string,
    staffId?: string,
    excludeId?: string,
  ): Promise<AppointmentRecord[]> {
    return this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments
        WHERE company_id = $1
          AND status NOT IN ('cancelled', 'no_show')
          AND scheduled_start < $3
          AND scheduled_end > $2
          AND ($4::uuid IS NULL OR staff_id = $4)
          AND ($5::uuid IS NULL OR id <> $5)
        ORDER BY scheduled_start`,
      [companyId, start, end, staffId ?? null, excludeId ?? null],
    );
  }

  async findAvailableStaff(
    companyId: string,
    start: string,
    end: string,
  ): Promise<string | undefined> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT cs.id
         FROM company_staff cs
        WHERE cs.company_id = $1
          AND cs.is_active = TRUE
          AND COALESCE(cs.calendar_sync_enabled, TRUE) = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
             WHERE a.company_id = cs.company_id
               AND a.staff_id = cs.id
               AND a.status NOT IN ('cancelled', 'no_show')
               AND a.scheduled_start < $3
               AND a.scheduled_end > $2
          )
        ORDER BY EXISTS (
                   SELECT 1
                     FROM google_calendar_registry registry
                    WHERE registry.company_id = cs.company_id
                      AND registry.assigned_to_staff_id = cs.id
                      AND registry.is_active = TRUE
                 ) DESC,
                 cs.created_at ASC
        LIMIT 1`,
      [companyId, start, end],
    );
    return rows[0]?.id;
  }

  async updateSchedule(
    companyId: string,
    appointmentId: string,
    start: string,
    end: string,
    bufferMinutes = 0,
  ): Promise<AppointmentRecord | null> {
    return this.db.withTransaction(async (transaction) => {
      const current = await transaction.query<{ staff_id: string | null }>(
        `SELECT staff_id FROM appointments
          WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [appointmentId, companyId],
      );
      if (!current[0]) return null;
      if (current[0].staff_id) {
        await transaction.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `appointment:${companyId}:${current[0].staff_id}`,
        ]);
        const overlaps = await transaction.query<{ id: string }>(
          `SELECT id FROM appointments
            WHERE company_id = $1 AND staff_id = $2 AND id <> $3
              AND status IN ('pending', 'confirmed')
              AND scheduled_start < ($5::timestamptz + make_interval(mins => $6))
              AND scheduled_end > ($4::timestamptz - make_interval(mins => $6))
            LIMIT 1`,
          [
            companyId,
            current[0].staff_id,
            appointmentId,
            start,
            end,
            bufferMinutes,
          ],
        );
        if (overlaps.length) throw new Error('APPOINTMENT_SLOT_UNAVAILABLE');
      }
      const rows = await transaction.query<AppointmentRecord>(
        `UPDATE appointments
          SET scheduled_start = $3, scheduled_end = $4,
              sync_status = 'pending', sync_error_message = NULL,
              booking_version = COALESCE(booking_version, 1) + 1,
              updated_at = NOW()
        WHERE id = $1 AND company_id = $2
          AND status IN ('pending', 'confirmed')
        RETURNING *`,
        [appointmentId, companyId, start, end],
      );
      return rows[0] ?? null;
    });
  }

  async cancel(
    companyId: string,
    appointmentId: string,
    reason?: string,
    cancelledByUserId?: string,
  ): Promise<AppointmentRecord | null> {
    const rows = await this.db.query<AppointmentRecord>(
      `UPDATE appointments
          SET status = 'cancelled'::appointment_status,
              notes = COALESCE($3, notes), cancellation_reason = $3,
              cancelled_at = NOW(), cancelled_by_user_id = $4,
              booking_version = COALESCE(booking_version, 1) + 1,
              sync_status = 'pending',
              sync_error_message = NULL, updated_at = NOW()
        WHERE id = $1 AND company_id = $2
          AND status IN ('pending', 'confirmed')
        RETURNING *`,
      [appointmentId, companyId, reason ?? null, cancelledByUserId ?? null],
    );
    return rows[0] ?? null;
  }

  async updateStatus(
    companyId: string,
    appointmentId: string,
    status: 'confirmed' | 'completed' | 'no_show',
  ): Promise<AppointmentRecord | null> {
    const rows = await this.db.query<AppointmentRecord>(
      `UPDATE appointments SET status = $3::appointment_status,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE completed_at END,
              no_show_at = CASE WHEN $3 = 'no_show' THEN NOW() ELSE no_show_at END,
              sync_status = 'pending', updated_at = NOW()
        WHERE id = $1 AND company_id = $2
          AND (
            (status = 'pending' AND $3 = 'confirmed') OR
            (status = 'confirmed' AND $3 IN ('completed', 'no_show')) OR
            status = $3::appointment_status
          )
        RETURNING *`,
      [appointmentId, companyId, status],
    );
    return rows[0] ?? null;
  }

  listForStaff(
    companyId: string,
    staffId: string,
    filter: 'all' | 'upcoming' | 'past' | 'cancelled' = 'upcoming',
    limit = 20,
  ): Promise<AppointmentRecord[]> {
    return this.listScoped(companyId, filter, limit, staffId);
  }

  listForCompany(
    companyId: string,
    filter: 'all' | 'upcoming' | 'past' | 'cancelled' = 'upcoming',
    limit = 20,
  ): Promise<AppointmentRecord[]> {
    return this.listScoped(companyId, filter, limit);
  }

  async findCustomerAppointment(params: {
    companyId: string;
    phone: string;
    date?: string;
    time?: string;
  }): Promise<AppointmentRecord | null> {
    const rows = await this.db.query<AppointmentRecord>(
      `SELECT a.* FROM appointments a
         JOIN customers c ON c.id = a.customer_id
         JOIN companies company ON company.id = a.company_id
        WHERE a.company_id = $1
          AND regexp_replace(c.phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')
          AND a.status IN ('pending', 'confirmed')
          AND ($3::date IS NULL OR
               (a.scheduled_start AT TIME ZONE COALESCE(company.timezone, 'UTC'))::date = $3::date)
          AND ($4::time IS NULL OR
               (a.scheduled_start AT TIME ZONE COALESCE(company.timezone, 'UTC'))::time BETWEEN
                ($4::time - interval '15 minutes') AND ($4::time + interval '15 minutes'))
        ORDER BY a.scheduled_start ASC LIMIT 1`,
      [
        params.companyId,
        params.phone,
        params.date ?? null,
        params.time ?? null,
      ],
    );
    return rows[0] ?? null;
  }

  async pendingForCompany(
    companyId: string,
    limit = 100,
  ): Promise<AppointmentRecord[]> {
    return this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments
        WHERE company_id = $1
          AND sync_direction IN ('db_to_google', 'bidirectional')
          AND (sync_status IN ('pending', 'error')
               OR db_updated_at > COALESCE(last_synced_at, 'epoch'::timestamptz))
        ORDER BY db_updated_at ASC
        LIMIT $2`,
      [companyId, limit],
    );
  }

  async resolveCalendarId(appointmentId: string): Promise<string> {
    const rows = await this.db.query<{ calendar_id: string }>(
      `SELECT get_target_calendar_id_for_appointment($1) AS calendar_id`,
      [appointmentId],
    );
    return rows[0]?.calendar_id || 'primary';
  }

  async markSynced(
    appointmentId: string,
    params: {
      eventId?: string | null;
      link?: string | null;
      googleUpdatedAt?: string | null;
      calendarId?: string;
    } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE appointments
          SET google_calendar_event_id = COALESCE($2, google_calendar_event_id),
              google_calendar_link = COALESCE($3, google_calendar_link),
              google_updated_at = COALESCE($4, google_updated_at),
              target_calendar_id = COALESCE($5, target_calendar_id),
              sync_status = 'synced', sync_error_message = NULL,
              last_synced_at = NOW()
        WHERE id = $1`,
      [
        appointmentId,
        params.eventId ?? null,
        params.link ?? null,
        params.googleUpdatedAt ?? null,
        params.calendarId ?? null,
      ],
    );
  }

  async markSyncError(appointmentId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE appointments
          SET sync_status = 'error', sync_error_message = LEFT($2, 2000)
        WHERE id = $1`,
      [appointmentId, error],
    );
  }

  async findByGoogleEvent(
    companyId: string,
    calendarId: string,
    eventId: string,
  ): Promise<AppointmentRecord | null> {
    const rows = await this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments
        WHERE company_id = $1 AND target_calendar_id = $2
          AND google_calendar_event_id = $3
        LIMIT 1`,
      [companyId, calendarId, eventId],
    );
    return rows[0] ?? null;
  }

  async upsertFromGoogle(params: {
    companyId: string;
    calendarId: string;
    staffId: string | null;
    eventId: string;
    title: string;
    description: string | null;
    location: string | null;
    start: string;
    end: string;
    status: 'confirmed' | 'cancelled';
    link: string | null;
    googleUpdatedAt: string | null;
    existingId?: string;
  }): Promise<AppointmentRecord> {
    const rows = params.existingId
      ? await this.db.query<AppointmentRecord>(
          `UPDATE appointments
            SET target_calendar_id = $2,
                title = $3, description = $4, location = $5,
                scheduled_start = $6, scheduled_end = $7,
                status = $8::appointment_status,
                google_calendar_link = $9,
                google_updated_at = $10,
                google_calendar_event_id = COALESCE(
                  google_calendar_event_id,
                  $11
                ),
                sync_status = 'synced', sync_error_message = NULL,
                last_synced_at = NOW(), updated_at = NOW()
          WHERE id = $12 AND company_id = $1 RETURNING *`,
          [
            params.companyId,
            params.calendarId,
            params.title,
            params.description,
            params.location,
            params.start,
            params.end,
            params.status,
            params.link,
            params.googleUpdatedAt,
            params.eventId,
            params.existingId,
          ],
        )
      : await this.db.query<AppointmentRecord>(
          `INSERT INTO appointments (
            company_id, staff_id, title, description, location,
            scheduled_start, scheduled_end, status, appointment_type,
            context_type, source, google_calendar_event_id,
            google_calendar_link, google_updated_at, target_calendar_id,
            sync_status, sync_direction, last_synced_at, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::appointment_status,
            'other'::appointment_type, 'general'::appointment_context_type,
            'google_calendar', $9, $10, $11, $12, 'synced',
            'bidirectional', NOW(), '{}'::jsonb
          ) RETURNING *`,
          [
            params.companyId,
            params.staffId,
            params.title,
            params.description,
            params.location,
            params.start,
            params.end,
            params.status,
            params.eventId,
            params.link,
            params.googleUpdatedAt,
            params.calendarId,
          ],
        );
    if (!rows[0]) throw new Error('No se pudo importar el evento de Google');
    return rows[0];
  }

  async listCalendars(companyId: string): Promise<CalendarRegistryRecord[]> {
    const rows = await this.db.query<CalendarRegistryRecord>(
      `SELECT calendar_id, assigned_to_staff_id, is_primary
         FROM google_calendar_registry
        WHERE company_id = $1 AND is_active = TRUE
        ORDER BY is_primary DESC, created_at ASC`,
      [companyId],
    );
    return rows.length
      ? rows
      : [
          {
            calendar_id: 'primary',
            assigned_to_staff_id: null,
            is_primary: true,
          },
        ];
  }

  async activeIntegrations(): Promise<CompanyCalendarIntegration[]> {
    return this.db.query<CompanyCalendarIntegration>(
      `SELECT company_id, sync_direction, sync_settings, last_sync_at,
              webhook_channel_id, webhook_resource_id, webhook_expiration,
              sync_frequency_minutes, last_full_sync_at
         FROM company_integrations
        WHERE provider = 'GOOGLE_CALENDAR' AND is_active = TRUE
          AND sync_enabled = TRUE`,
    );
  }

  private listScoped(
    companyId: string,
    filter: 'all' | 'upcoming' | 'past' | 'cancelled',
    limit: number,
    staffId?: string,
  ): Promise<AppointmentRecord[]> {
    const predicates: Record<typeof filter, string> = {
      all: '',
      upcoming: `AND scheduled_end >= NOW() AND status <> 'cancelled'`,
      past: `AND scheduled_end < NOW() AND status <> 'cancelled'`,
      cancelled: `AND status = 'cancelled'`,
    };
    return this.db.query<AppointmentRecord>(
      `SELECT * FROM appointments WHERE company_id = $1
         AND ($2::uuid IS NULL OR staff_id = $2)
         ${predicates[filter]}
        ORDER BY scheduled_start ASC LIMIT $3`,
      [companyId, staffId ?? null, Math.min(Math.max(limit, 1), 100)],
    );
  }

  private async findOrCreateCustomer(
    companyId: string,
    phone: string,
    name?: string,
    executor: SqlExecutor = this.db,
  ): Promise<string> {
    const found = await executor.query<{ id: string }>(
      `SELECT id FROM customers
        WHERE company_id = $1 AND is_active = TRUE
          AND regexp_replace(phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')
        ORDER BY created_at ASC LIMIT 1`,
      [companyId, phone],
    );
    if (found[0]) return found[0].id;

    const created = await executor.query<{ id: string }>(
      `INSERT INTO customers (company_id, customer_type, first_name, phone)
       VALUES ($1, 'person'::customer_type, $2, $3) RETURNING id`,
      [companyId, name?.trim() || phone, this.normalizePhone(phone)],
    );
    if (!created[0]) throw new Error('No se pudo registrar al cliente');
    return created[0].id;
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/\D/g, '');
  }
}
