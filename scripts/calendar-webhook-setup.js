const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const {
  SupabaseService,
} = require('../dist/common/intraestructure/supabase/supabase.service');
const {
  GoogleCalendarWebhookService,
} = require('../dist/features/calendar/google-calendar-webhook.service');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const db = app.get(SupabaseService);
    const webhooks = app.get(GoogleCalendarWebhookService);
    const integrations = await db.query(`
      SELECT company_id
        FROM company_integrations
       WHERE provider = 'GOOGLE_CALENDAR' AND is_active = TRUE
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1
    `);
    const companyId = integrations[0]?.company_id;
    if (!companyId) throw new Error('Google Calendar no está conectado');

    const result = await webhooks.setup(companyId);
    const channels = await db.query(
      `SELECT calendar_id, webhook_url, expiration
         FROM google_calendar_webhook_channels
        WHERE company_id = $1 AND is_active = TRUE
        ORDER BY calendar_id`,
      [companyId],
    );
    console.log(
      JSON.stringify(
        { companyId, configured: result.configured, channels },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`Google webhook setup failed: ${error.message}`);
  process.exitCode = 1;
});
