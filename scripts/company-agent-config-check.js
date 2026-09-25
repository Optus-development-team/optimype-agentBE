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
    const health = await pool.query(`
      SELECT
        COUNT(*)::int AS companies,
        COUNT(*) FILTER (WHERE schema_version = 2)::int AS standardized,
        COUNT(*) FILTER (WHERE configuration_status = 'complete')::int AS complete,
        COUNT(*) FILTER (WHERE configuration_status = 'draft')::int AS draft,
        COUNT(*) FILTER (WHERE NOT has_agent_name)::int AS missing_agent_name,
        COUNT(*) FILTER (WHERE NOT has_language)::int AS missing_language,
        COUNT(*) FILTER (WHERE NOT has_tone)::int AS missing_tone,
        COUNT(*) FILTER (WHERE NOT has_persona_description)::int AS missing_persona
      FROM (
        SELECT
          (config->>'schema_version')::int AS schema_version,
          NULLIF(BTRIM(config->'profile'->>'agent_name'), '') IS NOT NULL AS has_agent_name,
          NULLIF(BTRIM(config->'profile'->>'language'), '') IS NOT NULL AS has_language,
          NULLIF(BTRIM(config->'profile'->>'tone'), '') IS NOT NULL AS has_tone,
          NULLIF(BTRIM(config->'profile'->>'persona_description'), '') IS NOT NULL AS has_persona_description,
          config->'configuration'->>'status' AS configuration_status
        FROM companies
      ) AS company_config
    `);

    const safeguards = await pool.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'normalize_company_agent_config_before_write'
            AND NOT tgisinternal
        ) AS normalization_trigger,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_companies_agent_config_v2'
            AND convalidated
        ) AS validated_constraint,
        (SELECT COUNT(*)::int FROM company_config_migration_snapshots
          WHERE schema_version = 2) AS snapshots
    `);

    const result = { ...health.rows[0], ...safeguards.rows[0] };
    console.log(JSON.stringify(result, null, 2));

    const isHealthy =
      result.companies === result.standardized &&
      result.missing_agent_name === 0 &&
      result.missing_language === 0 &&
      result.missing_tone === 0 &&
      result.missing_persona === 0 &&
      result.normalization_trigger === true &&
      result.validated_constraint === true &&
      result.snapshots >= result.companies;

    if (!isHealthy) {
      throw new Error(
        'La configuración de agentes no está completamente estandarizada',
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Company agent config check failed: ${error.message}`);
  process.exitCode = 1;
});
