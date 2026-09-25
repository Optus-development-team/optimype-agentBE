import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import { AppointmentRepository } from './appointment.repository';
import { CalendarService } from './calendar.service';
import { CalendarSyncLogService } from './calendar-sync-log.service';
import type {
  AppointmentRecord,
  CalendarRegistryRecord,
  GoogleEvent,
  SyncSummary,
} from './calendar.types';

type SyncTrigger = 'cron' | 'webhook' | 'user' | 'agent' | 'system';

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly appointments: AppointmentRepository,
    private readonly calendar: CalendarService,
    private readonly logs: CalendarSyncLogService,
    private readonly db: SupabaseService,
  ) {}

  async syncAppointmentToGoogle(
    companyId: string,
    appointmentId: string,
  ): Promise<AppointmentRecord> {
    const appointment = await this.appointments.findById(
      companyId,
      appointmentId,
    );
    if (!appointment) throw new Error('Cita no encontrada');
    if (
      appointment.sync_direction === 'google_to_db' ||
      appointment.sync_direction === 'none'
    ) {
      return appointment;
    }

    const calendarId = await this.appointments.resolveCalendarId(
      appointment.id,
    );
    try {
      if (appointment.status === 'cancelled') {
        if (appointment.google_calendar_event_id) {
          await this.calendar.deleteAppointment(
            companyId,
            calendarId,
            appointment.google_calendar_event_id,
          );
        }
        await this.appointments.markSynced(appointment.id, { calendarId });
      } else if (appointment.google_calendar_event_id) {
        const event = await this.calendar.updateAppointment(
          companyId,
          calendarId,
          appointment.google_calendar_event_id,
          {
            summary: appointment.title || 'Cita',
            description: appointment.description,
            location: appointment.location,
            start: this.iso(appointment.scheduled_start),
            end: this.iso(appointment.scheduled_end),
          },
        );
        await this.appointments.markSynced(appointment.id, {
          link: event.htmlLink,
          googleUpdatedAt: event.updated,
          calendarId,
        });
      } else {
        const event = await this.calendar.createAppointment(companyId, {
          summary: appointment.title || 'Cita',
          description: appointment.description ?? undefined,
          location: appointment.location ?? undefined,
          start: this.iso(appointment.scheduled_start),
          end: this.iso(appointment.scheduled_end),
          calendarId,
          appointmentId: appointment.id,
        });
        if (!event.id) throw new Error('Google no devolvió el ID del evento');
        await this.appointments.markSynced(appointment.id, {
          eventId: event.id,
          link: event.htmlLink,
          googleUpdatedAt: event.updated,
          calendarId,
        });
      }
    } catch (error) {
      const message = (error as Error).message;
      await this.appointments.markSyncError(appointment.id, message);
      throw error;
    }

    return (await this.appointments.findById(companyId, appointmentId))!;
  }

  async syncPendingToGoogle(
    companyId: string,
    trigger: SyncTrigger = 'cron',
  ): Promise<SyncSummary> {
    const startedAt = Date.now();
    const logId = await this.logs.start(
      companyId,
      trigger === 'user' ? 'manual' : 'incremental',
      'db_to_google',
      trigger,
    );
    const summary = this.emptySummary();
    const pending = await this.appointments.pendingForCompany(companyId);
    for (const appointment of pending) {
      summary.processed++;
      try {
        const wasNew = !appointment.google_calendar_event_id;
        await this.syncAppointmentToGoogle(companyId, appointment.id);
        if (appointment.status === 'cancelled') summary.deleted++;
        else if (wasNew) summary.created++;
        else summary.updated++;
      } catch (error) {
        const message = `${appointment.id}: ${(error as Error).message}`;
        summary.errors.push(message);
        this.logger.error(message);
      }
    }
    await this.logs.finish(logId, summary, startedAt);
    await this.db.query(
      `UPDATE company_integrations SET last_sync_at = NOW(), updated_at = NOW()
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'`,
      [companyId],
    );
    return summary;
  }

  async syncFromGoogleToDb(
    companyId: string,
    options: { full?: boolean; trigger?: SyncTrigger } = {},
  ): Promise<SyncSummary> {
    const trigger = options.trigger ?? 'cron';
    const startedAt = Date.now();
    const logId = await this.logs.start(
      companyId,
      options.full
        ? 'full_sync'
        : trigger === 'webhook'
          ? 'webhook'
          : 'incremental',
      'google_to_db',
      trigger,
    );
    const summary = this.emptySummary();
    const calendars = await this.appointments.listCalendars(companyId);
    const integration = await this.getIntegration(companyId);
    const tokens = this.readSyncTokens(integration?.sync_settings);

    for (const registry of calendars) {
      try {
        const nextToken = await this.pullCalendar(
          companyId,
          registry,
          options.full ? undefined : tokens[registry.calendar_id],
          integration?.last_sync_at,
          options.full ?? false,
          summary,
        );
        if (nextToken) tokens[registry.calendar_id] = nextToken;
      } catch (error) {
        const message = `${registry.calendar_id}: ${(error as Error).message}`;
        summary.errors.push(message);
        this.logger.error(message);
      }
    }

    await this.db.query(
      `UPDATE company_integrations
          SET last_sync_at = NOW(),
              last_full_sync_at = CASE WHEN $3 THEN NOW() ELSE last_full_sync_at END,
              sync_settings = COALESCE(sync_settings, '{}'::jsonb)
                || jsonb_build_object('sync_tokens', $2::jsonb),
              updated_at = NOW()
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'`,
      [companyId, tokens, options.full ?? false],
    );
    await this.logs.finish(logId, summary, startedAt);
    return summary;
  }

  async performFullSync(
    companyId: string,
    trigger: SyncTrigger = 'user',
  ): Promise<{ fromGoogle: SyncSummary; toGoogle: SyncSummary }> {
    const integration = await this.getIntegration(companyId);
    const direction = integration?.sync_direction ?? 'bidirectional';
    const fromGoogle =
      direction === 'to_google' || direction === 'none'
        ? this.emptySummary()
        : await this.syncFromGoogleToDb(companyId, { full: true, trigger });
    const toGoogle =
      direction === 'from_google' || direction === 'none'
        ? this.emptySummary()
        : await this.syncPendingToGoogle(companyId, trigger);
    return { fromGoogle, toGoogle };
  }

  async resolveConflictById(
    companyId: string,
    conflictId: string,
    strategy: 'google_wins' | 'db_wins' | 'ignore',
    resolvedBy: string,
    notes?: string,
  ): Promise<AppointmentRecord> {
    const rows = await this.db.query<{
      appointment_id: string;
      google_state: GoogleEvent;
    }>(
      `SELECT appointment_id, google_state
         FROM calendar_sync_conflicts
        WHERE id = $1 AND company_id = $2 AND resolution_status = 'pending'
        LIMIT 1`,
      [conflictId, companyId],
    );
    const conflict = rows[0];
    if (!conflict) throw new Error('Conflicto pendiente no encontrado');
    const appointment = await this.appointments.findById(
      companyId,
      conflict.appointment_id,
    );
    if (!appointment) throw new Error('La cita del conflicto no existe');

    if (strategy === 'google_wins') {
      const event = conflict.google_state;
      const start = event.start?.dateTime ?? event.start?.date;
      const end = event.end?.dateTime ?? event.end?.date;
      await this.appointments.upsertFromGoogle({
        companyId,
        calendarId: appointment.target_calendar_id || 'primary',
        staffId: appointment.staff_id,
        eventId: event.id || appointment.google_calendar_event_id || '',
        title: event.summary || appointment.title || 'Cita',
        description: event.description ?? null,
        location: event.location ?? null,
        start: start || this.iso(appointment.scheduled_start),
        end: end || this.iso(appointment.scheduled_end),
        status: event.status === 'cancelled' ? 'cancelled' : 'confirmed',
        link: event.htmlLink ?? appointment.google_calendar_link,
        googleUpdatedAt: event.updated ?? null,
        existingId: appointment.id,
      });
    } else if (strategy === 'db_wins') {
      await this.db.query(
        `UPDATE appointments SET sync_status = 'pending' WHERE id = $1`,
        [appointment.id],
      );
      await this.syncAppointmentToGoogle(companyId, appointment.id);
    } else {
      await this.appointments.markSynced(appointment.id);
    }

    await this.db.query(
      `UPDATE calendar_sync_conflicts
          SET resolution_strategy = $3,
              resolution_status = $4,
              resolved_at = NOW(), resolved_by = $5,
              resolution_notes = $6, updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [
        conflictId,
        companyId,
        strategy === 'google_wins'
          ? 'auto_google_wins'
          : strategy === 'db_wins'
            ? 'auto_db_wins'
            : 'ignore',
        strategy === 'ignore' ? 'ignored' : 'resolved',
        resolvedBy,
        notes ?? null,
      ],
    );
    return (await this.appointments.findById(companyId, appointment.id))!;
  }

  private async pullCalendar(
    companyId: string,
    registry: CalendarRegistryRecord,
    syncToken: string | undefined,
    lastSync: Date | string | null | undefined,
    full: boolean,
    summary: SyncSummary,
  ): Promise<string | undefined> {
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let currentSyncToken = syncToken;

    do {
      let response: Awaited<ReturnType<CalendarService['listEvents']>>;
      try {
        response = await this.calendar.listEvents(
          companyId,
          registry.calendar_id,
          {
            pageToken,
            syncToken: currentSyncToken,
            updatedMin: !full && lastSync ? this.iso(lastSync) : undefined,
            timeMin: full
              ? dayjs().subtract(30, 'day').toISOString()
              : undefined,
          },
        );
      } catch (error) {
        const candidate = error as {
          code?: number;
          response?: { status?: number };
        };
        const status = candidate.response?.status ?? candidate.code;
        if (currentSyncToken && status === 410) {
          currentSyncToken = undefined;
          pageToken = undefined;
          continue;
        }
        throw error;
      }

      for (const event of response.items ?? []) {
        await this.importEvent(companyId, registry, event, summary);
      }
      pageToken = response.nextPageToken ?? undefined;
      nextSyncToken = response.nextSyncToken ?? nextSyncToken;
    } while (pageToken);

    return nextSyncToken;
  }

  private async importEvent(
    companyId: string,
    registry: CalendarRegistryRecord,
    event: GoogleEvent,
    summary: SyncSummary,
  ): Promise<void> {
    if (!event.id) {
      summary.skipped++;
      return;
    }
    summary.processed++;

    let existing = await this.appointments.findByGoogleEvent(
      companyId,
      registry.calendar_id,
      event.id,
    );
    const linkedId = event.extendedProperties?.private?.optusAppointmentId;
    if (!existing && linkedId) {
      existing = await this.appointments.findById(companyId, linkedId);
    }

    const cancelled = event.status === 'cancelled';
    const start = event.start?.dateTime ?? event.start?.date;
    const end = event.end?.dateTime ?? event.end?.date;
    if ((!start || !end) && !existing) {
      summary.skipped++;
      return;
    }

    if (existing && this.hasConcurrentChanges(existing, event)) {
      const resolution = await this.resolveConflict(companyId, existing, event);
      if (resolution === 'db_wins') {
        summary.skipped++;
        return;
      }
      if (resolution === 'manual') {
        summary.errors.push(`${event.id}: conflicto pendiente de resolución`);
        return;
      }
    }

    await this.appointments.upsertFromGoogle({
      companyId,
      calendarId: registry.calendar_id,
      staffId: registry.assigned_to_staff_id,
      eventId: event.id,
      title: event.summary || existing?.title || 'Evento de Google Calendar',
      description: event.description ?? null,
      location: event.location ?? null,
      start: start || this.iso(existing!.scheduled_start),
      end: end || this.iso(existing!.scheduled_end),
      status: cancelled ? 'cancelled' : 'confirmed',
      link: event.htmlLink ?? null,
      googleUpdatedAt: event.updated ?? null,
      existingId: existing?.id,
    });
    if (cancelled) summary.deleted++;
    else if (existing) summary.updated++;
    else summary.created++;
  }

  private hasConcurrentChanges(
    appointment: AppointmentRecord,
    event: GoogleEvent,
  ): boolean {
    if (!appointment.last_synced_at || !event.updated) return false;
    const lastSync = dayjs(appointment.last_synced_at);
    return (
      dayjs(appointment.db_updated_at).isAfter(lastSync) &&
      dayjs(event.updated).isAfter(lastSync)
    );
  }

  private async resolveConflict(
    companyId: string,
    appointment: AppointmentRecord,
    event: GoogleEvent,
  ): Promise<'google_wins' | 'db_wins' | 'manual'> {
    const googleTime = dayjs(event.updated).valueOf();
    const dbTime = dayjs(appointment.db_updated_at).valueOf();
    const threshold = 5 * 60 * 1000;
    if (googleTime > dbTime + threshold) return 'google_wins';
    if (dbTime > googleTime + threshold) return 'db_wins';

    await this.db.query(
      `INSERT INTO calendar_sync_conflicts (
         company_id, appointment_id, google_calendar_event_id,
         conflict_type, db_state, google_state, resolution_strategy
       ) VALUES ($1, $2, $3, 'data_mismatch', $4::jsonb, $5::jsonb,
                 'pending_manual')`,
      [companyId, appointment.id, event.id, appointment, event],
    );
    await this.db.query(
      `UPDATE appointments SET sync_status = 'conflict' WHERE id = $1`,
      [appointment.id],
    );
    return 'manual';
  }

  private async getIntegration(companyId: string): Promise<{
    sync_settings: Record<string, unknown>;
    last_sync_at: Date | string | null;
    sync_direction: string;
  } | null> {
    const rows = await this.db.query<{
      sync_settings: Record<string, unknown>;
      last_sync_at: Date | string | null;
      sync_direction: string;
    }>(
      `SELECT sync_settings, last_sync_at, sync_direction FROM company_integrations
        WHERE company_id = $1 AND provider = 'GOOGLE_CALENDAR'
          AND is_active = TRUE LIMIT 1`,
      [companyId],
    );
    return rows[0] ?? null;
  }

  private readSyncTokens(
    settings?: Record<string, unknown>,
  ): Record<string, string> {
    const candidate = settings?.sync_tokens;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(candidate).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private emptySummary(): SyncSummary {
    return {
      processed: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
    };
  }

  private iso(value: Date | string): string {
    return dayjs(value).toISOString();
  }
}
