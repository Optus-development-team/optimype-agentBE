require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const summaryOnly = process.argv.includes('--summary');
  const rawUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!rawUrl) throw new Error('Falta SUPABASE_DB_URL');
  const connectionUrl = new URL(rawUrl);
  connectionUrl.searchParams.delete('sslmode');
  const client = new Client({
    connectionString: connectionUrl.toString(),
    ssl: {
      rejectUnauthorized: process.env.SUPABASE_DB_ALLOW_SELF_SIGNED !== 'true',
    },
  });
  await client.connect();
  const constraints = await client.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'appointments'
    ORDER BY c.conname
  `);
  const functions = await client.query(`
    SELECT p.proname, pg_get_function_result(p.oid) AS result
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')
      AND pg_get_functiondef(p.oid) ILIKE '%scheduled_start%'
    ORDER BY p.proname
  `);
  const columns = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'appointments'
      AND column_name IN ('scheduled_start', 'scheduled_end')
    ORDER BY ordinal_position
  `);
  const views = await client.query(`
    SELECT viewname, definition
    FROM pg_views
    WHERE schemaname = 'public' AND definition ILIKE '%scheduled_start%'
    ORDER BY viewname
  `);
  const appointments = await client.query(`
    SELECT source, COUNT(*)::int AS count,
           COUNT(google_calendar_event_id)::int AS google_linked,
           MIN(scheduled_start)::text AS earliest,
           MAX(scheduled_start)::text AS latest
    FROM appointments
    GROUP BY source
    ORDER BY source
  `);
  const auditTimes = await client.query(`
    SELECT a.id AS appointment_id,
           a.scheduled_start::text AS stored_legacy_start,
           audit.new_state->>'scheduled_start' AS audited_start
    FROM appointments a
    LEFT JOIN LATERAL (
      SELECT log.new_state
      FROM appointment_audit_logs log
      WHERE log.appointment_id = a.id
        AND log.new_state ? 'scheduled_start'
      ORDER BY log.created_at DESC
      LIMIT 1
    ) audit ON true
    ORDER BY a.created_at
  `);
  console.log(
    JSON.stringify(
      {
        columns: columns.rows,
        constraints: constraints.rows,
        functions: functions.rows,
        views: summaryOnly
          ? views.rows.map(({ viewname }) => ({ viewname }))
          : views.rows,
        appointments: appointments.rows,
        auditTimes: auditTimes.rows,
      },
      null,
      2,
    ),
  );
  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
