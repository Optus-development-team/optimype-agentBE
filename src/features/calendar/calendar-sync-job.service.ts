import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/intraestructure/supabase/supabase.service';
import { CalendarSyncService } from './calendar-sync.service';

@Injectable()
export class CalendarSyncJobService {
  private readonly logger = new Logger(CalendarSyncJobService.name);

  constructor(
    private readonly db: SupabaseService,
    private readonly sync: CalendarSyncService,
  ) {}

  async enqueueWebhook(companyId: string, calendarId?: string): Promise<void> {
    const bucket = Math.floor(Date.now() / 30_000);
    await this.db.query(
      `INSERT INTO calendar_sync_jobs (
         company_id, calendar_id, job_type, dedupe_key, payload
       ) VALUES ($1, $2, 'webhook_sync', $3, $4::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        companyId,
        calendarId ?? null,
        `webhook:${companyId}:${calendarId ?? 'all'}:${bucket}`,
        JSON.stringify({ calendarId: calendarId ?? null }),
      ],
    );
  }

  async processDue(limit = 20): Promise<number> {
    const jobs = await this.db.query<{
      id: string;
      company_id: string;
      job_type: string;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH due AS (
         SELECT id FROM calendar_sync_jobs
          WHERE (status = 'pending' AND run_after <= NOW())
             OR (status = 'processing' AND locked_at < NOW() - INTERVAL '15 minutes')
          ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE calendar_sync_jobs j SET status = 'processing',
              attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
         FROM due WHERE j.id = due.id
       RETURNING j.id, j.company_id, j.job_type, j.attempts, j.max_attempts`,
      [limit],
    );
    for (const job of jobs) {
      try {
        if (job.job_type === 'full_sync') {
          await this.sync.performFullSync(job.company_id, 'cron');
        } else {
          await this.sync.syncFromGoogleToDb(job.company_id, {
            trigger: 'webhook',
          });
        }
        await this.db.query(
          `UPDATE calendar_sync_jobs SET status = 'completed', completed_at = NOW(),
                  locked_at = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`,
          [job.id],
        );
      } catch (error) {
        const failed = job.attempts >= job.max_attempts;
        await this.db.query(
          `UPDATE calendar_sync_jobs SET status = $2,
                  run_after = CASE WHEN $2 = 'pending'
                    THEN NOW() + make_interval(mins => LEAST(60, POWER(2, attempts)::int))
                    ELSE run_after END,
                  locked_at = NULL, last_error = LEFT($3, 2000), updated_at = NOW()
            WHERE id = $1`,
          [job.id, failed ? 'failed' : 'pending', (error as Error).message],
        );
        this.logger.error(`Job ${job.id}: ${(error as Error).message}`);
      }
    }
    return jobs.length;
  }
}
