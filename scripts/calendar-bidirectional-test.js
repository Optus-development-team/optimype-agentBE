const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { google } = require('googleapis');
const { AppModule } = require('../dist/app.module');
const {
  SupabaseService,
} = require('../dist/common/intraestructure/supabase/supabase.service');
const { OAuthService } = require('../dist/features/auth/oauth.service');
const {
  CalendarSyncService,
} = require('../dist/features/calendar/calendar-sync.service');

const EXPECTED_TITLE = '[OPTUS E2E] Actualizada desde Google';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const db = app.get(SupabaseService);
    const oauth = app.get(OAuthService);
    const sync = app.get(CalendarSyncService);
    const rows = await db.query(`
      SELECT id, company_id, google_calendar_event_id, target_calendar_id
        FROM appointments
       WHERE metadata->>'test_key' = 'calendar-e2e-v1'
         AND google_calendar_event_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1
    `);
    const appointment = rows[0];
    if (!appointment) throw new Error('Ejecuta primero npm run calendar:e2e');

    const auth = await oauth.getClient(appointment.company_id);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.patch({
      calendarId: appointment.target_calendar_id || 'primary',
      eventId: appointment.google_calendar_event_id,
      requestBody: { summary: EXPECTED_TITLE },
    });

    await delay(1_500);
    const summary = await sync.syncFromGoogleToDb(appointment.company_id, {
      trigger: 'user',
    });
    const updated = (
      await db.query(
        `SELECT title, sync_status FROM appointments
          WHERE id = $1 AND company_id = $2`,
        [appointment.id, appointment.company_id],
      )
    )[0];

    if (
      updated?.title !== EXPECTED_TITLE ||
      updated?.sync_status !== 'synced'
    ) {
      throw new Error(
        `Google→DB no se reflejó: title=${updated?.title}, sync_status=${updated?.sync_status}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          appointmentId: appointment.id,
          title: updated.title,
          syncStatus: updated.sync_status,
          syncSummary: summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`Bidirectional Calendar test failed: ${error.message}`);
  process.exitCode = 1;
});
