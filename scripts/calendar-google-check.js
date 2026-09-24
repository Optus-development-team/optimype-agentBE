const { scrypt: scryptCallback, createDecipheriv } = require('node:crypto');
const { promisify } = require('node:util');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const { Pool } = require('pg');

dotenv.config();
const scrypt = promisify(scryptCallback);

async function decrypt(value) {
  const [ivHex, encryptedHex] = value.split(':');
  if (!ivHex || !encryptedHex) throw new Error('Credencial cifrada inválida');
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
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    throw new Error('Falta GOOGLE_OAUTH_CLIENT_ID');
  }
  if (!process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Falta GOOGLE_OAUTH_CLIENT_SECRET');
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
    const integration = await pool.query(`
      SELECT company_id, encrypted_credentials
        FROM company_integrations
       WHERE provider = 'GOOGLE_CALENDAR' AND is_active = TRUE
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1
    `);
    const row = integration.rows[0];
    const encrypted = row?.encrypted_credentials?.token;
    if (!encrypted) throw new Error('La integración no tiene tokens OAuth');

    const tokens = JSON.parse(await decrypt(encrypted));
    const baseUrl = (
      process.env.MAIN_PAGE_URL || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      `${baseUrl}/v1/auth/google/callback`,
    );
    oauth.setCredentials(tokens);

    const api = google.calendar({ version: 'v3', auth: oauth });
    const calendars = await api.calendarList.list({ maxResults: 50 });
    const items = calendars.data.items || [];
    console.log(
      JSON.stringify(
        {
          connected: true,
          companyId: row.company_id,
          calendars: items.length,
          primaryCalendarAccessible: items.some((item) => item.primary),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Google Calendar check failed: ${error.message}`);
  process.exitCode = 1;
});
