const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

async function main() {
  const rawUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!rawUrl) {
    throw new Error('Falta SUPABASE_DB_URL');
  }

  const connectionUrl = new URL(rawUrl);
  connectionUrl.searchParams.delete('sslmode');

  const pool = new Pool({
    connectionString: connectionUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 8_000,
    ssl: {
      rejectUnauthorized: process.env.SUPABASE_DB_ALLOW_SELF_SIGNED !== 'true',
    },
  });

  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        (SELECT COUNT(*)::int FROM companies) AS companies,
        (SELECT COUNT(*)::int FROM company_users) AS company_users,
        (SELECT COUNT(*)::int FROM company_staff WHERE is_active = TRUE) AS active_staff,
        (SELECT COUNT(*)::int FROM customers WHERE is_active = TRUE) AS active_customers,
        (SELECT COUNT(*)::int FROM catalog_items
          WHERE is_active = TRUE AND is_bookable = TRUE) AS bookable_services,
        (SELECT COUNT(*)::int FROM staff_working_hours
          WHERE is_active = TRUE) AS working_hours,
        (SELECT COUNT(*)::int FROM google_calendar_registry
          WHERE is_active = TRUE) AS active_calendars,
        (SELECT COUNT(*)::int FROM appointments) AS appointments,
        (SELECT COUNT(*)::int FROM company_integrations
          WHERE provider = 'GOOGLE_CALENDAR' AND is_active = TRUE) AS google_integrations,
        (SELECT COUNT(*)::int FROM google_calendar_webhook_channels
          WHERE is_active = TRUE AND expiration > NOW()) AS active_webhooks,
        (SELECT COUNT(*)::int FROM calendar_sync_jobs
          WHERE status IN ('pending', 'processing')) AS pending_sync_jobs,
        (SELECT COUNT(*)::int FROM appointment_notifications n
          JOIN appointments a ON a.id = n.appointment_id
          WHERE a.metadata->>'test_key' = 'calendar-e2e-v1'
            AND n.status IN ('pending', 'processing')) AS e2e_pending_notifications
    `);

    console.log(JSON.stringify(result.rows[0], null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Calendar DB check failed: ${error.message}`);
  process.exitCode = 1;
});
