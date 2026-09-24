import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import type { SyncSummary } from './calendar.types';

@Injectable()
export class CalendarSyncLogService {
  constructor(private readonly db: SupabaseService) {}

  async start(
    companyId: string,
    type: 'full_sync' | 'incremental' | 'webhook' | 'manual' | 'retry',
    direction: 'db_to_google' | 'google_to_db' | 'bidirectional',
    triggeredBy: string,
  ): Promise<string | null> {
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO calendar_sync_logs
         (company_id, sync_type, sync_direction, status, triggered_by)
       VALUES ($1, $2, $3, 'in_progress', $4) RETURNING id`,
      [companyId, type, direction, triggeredBy],
    );
    return rows[0]?.id ?? null;
  }

  async finish(
    logId: string | null,
    summary: SyncSummary,
    startedAt: number,
  ): Promise<void> {
    if (!logId) return;
    const status = summary.errors.length
      ? summary.processed > summary.errors.length
        ? 'partial_success'
        : 'error'
      : 'success';
    await this.db.query(
      `UPDATE calendar_sync_logs
          SET status = $2, events_processed = $3, events_created = $4,
              events_updated = $5, events_deleted = $6, events_skipped = $7,
              errors_count = $8, error_details = $9::jsonb,
              completed_at = NOW(), duration_ms = $10
        WHERE id = $1`,
      [
        logId,
        status,
        summary.processed,
        summary.created,
        summary.updated,
        summary.deleted,
        summary.skipped,
        summary.errors.length,
        JSON.stringify(summary.errors),
        Date.now() - startedAt,
      ],
    );
  }
}
