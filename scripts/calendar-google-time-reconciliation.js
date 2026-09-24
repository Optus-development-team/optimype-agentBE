const { createDecipheriv, scrypt: scryptCallback } = require('node:crypto');
const { promisify } = require('node:util');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const { Pool } = require('pg');

dotenv.config();
const scrypt = promisify(scryptCallback);

async function decrypt(value) {
  const [ivHex, encryptedHex] = value.split(':');
  const password =
    process.env.ENCRYPTION_KEY || 'secret-encryption-key-please-change-in-env';
  const key = await scrypt(password, 'salt', 32);
  const decipher = createDecipheriv(
    'aes-256-ctr',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

async function main() {
  const rawUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!rawUrl) throw new Error('Falta SUPABASE_DB_URL');
  const connectionUrl = new URL(rawUrl);
  connectionUrl.searchParams.delete('sslmode');
  const pool = new Pool({
    connectionString: connectionUrl.toString(),
    max: 1,
    ssl: {
      rejectUnauthorized: process.env.SUPABASE_DB_ALLOW_SELF_SIGNED !== 'true',
    },
  });

  try {
    const appointments = await pool.query(`
      SELECT a.id, a.company_id, a.target_calendar_id,
             a.google_calendar_event_id,
             to_char(a.scheduled_start, 'YYYY-MM-DD HH24:MI:SS') AS legacy_start,
             ci.encrypted_credentials
      FROM appointments a
      JOIN company_integrations ci
        ON ci.company_id = a.company_id
       AND ci.provider = 'GOOGLE_CALENDAR'
      WHERE a.google_calendar_event_id IS NOT NULL
      ORDER BY a.created_at
    `);
    const clients = new Map();
    const comparisons = [];

    for (const row of appointments.rows) {
      try {
        let api = clients.get(row.company_id);
        if (!api) {
          const encrypted = row.encrypted_credentials?.token;
          if (!encrypted) throw new Error('Integración sin token');
          const tokens = JSON.parse(await decrypt(encrypted));
          const oauth = new google.auth.OAuth2(
            process.env.GOOGLE_OAUTH_CLIENT_ID,
            process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            process.env.GOOGLE_CALLBACK_URL,
          );
          oauth.setCredentials(tokens);
          api = google.calendar({ version: 'v3', auth: oauth });
          clients.set(row.company_id, api);
        }
        const response = await api.events.get({
          calendarId: row.target_calendar_id || 'primary',
          eventId: row.google_calendar_event_id,
        });
        const googleStart = response.data.start?.dateTime;
        const legacyAsUtc = `${row.legacy_start.replace(' ', 'T')}Z`;
        comparisons.push({
          appointmentId: row.id,
          legacyAsUtc,
          googleStart: googleStart ?? null,
          differenceMinutes: googleStart
            ? (Date.parse(googleStart) - Date.parse(legacyAsUtc)) / 60_000
            : null,
        });
      } catch (error) {
        comparisons.push({
          appointmentId: row.id,
          error: error.message,
        });
      }
    }

    console.log(JSON.stringify({ comparisons }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Calendar Google time check failed: ${error.message}`);
  process.exitCode = 1;
});
