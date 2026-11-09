import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const SEED_FILE = new URL('../seed/seed.sql', import.meta.url);

/** Serialises concurrent runners. The value only has to be unique within this database. */
const ADVISORY_LOCK_KEY = 727001;
const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 2000;

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', service: 'migrate', message, ...fields }));
}

/**
 * The postgres image passes its socket healthcheck while initdb's temporary server
 * runs, then restarts. A first boot can therefore refuse TCP for a few seconds after
 * "healthy", so connecting has to retry.
 */
async function connect(connectionString: string): Promise<pg.Client> {
  for (let attempt = 1; ; attempt += 1) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= CONNECT_ATTEMPTS) throw error;
      log('database not ready, retrying', { attempt, error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, CONNECT_DELAY_MS));
    }
  }
}

/** Line endings are normalised so a Windows checkout has the same checksum as Linux. */
async function readSql(url: URL): Promise<string> {
  return (await readFile(url, 'utf8')).replaceAll('\r\n', '\n');
}

async function inTransaction(client: pg.Client, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runMigrations(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of files) {
    const sql = await readSql(new URL(filename, MIGRATIONS_DIR));
    const checksum = createHash('sha256').update(sql).digest('hex');
    const known = applied.get(filename);
    if (known === checksum) continue;
    if (known !== undefined) {
      throw new Error(`${filename} changed after it was applied; add a new migration instead`);
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    log('migration applied', { filename });
  }
}

/** Runs on every start, so changing APP_DB_PASSWORD only needs a new `migrate` run. */
async function setAppRolePassword(client: pg.Client): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) throw new Error('APP_DB_PASSWORD is required');
  // ALTER ROLE cannot take a bound parameter, but a function call can, and %L quotes it there.
  await client.query(`
    CREATE FUNCTION pg_temp.set_app_role_password(p_password text) RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
      EXECUTE format('ALTER ROLE inblack_app PASSWORD %L', p_password);
    END;
    $$`);
  await client.query('SELECT pg_temp.set_app_role_password($1)', [password]);
}

/**
 * Everything except the two tables seeding cannot restore. The list is read at run time, so a
 * new table cannot be forgotten. The owner is the only role that can get past the append-only
 * triggers, which is why this runs as SECURITY DEFINER. search_path is fixed so that no caller
 * can make it resolve a name to objects of their own. CREATE on public is revoked in 0004.
 */
function testResetFunctionSql(seedSql: string): string {
  return `
    CREATE OR REPLACE FUNCTION public.test_reset_database() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $test_reset$
    DECLARE
      v_tables text;
    BEGIN
      SELECT string_agg(format('%I', tablename), ', ') INTO v_tables
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('schema_migrations', 'order_status_transitions');
      PERFORM set_config('session_replication_role', 'replica', true);
      EXECUTE 'TRUNCATE ' || v_tables || ' RESTART IDENTITY CASCADE';
      PERFORM set_config('session_replication_role', 'origin', true);
      ${seedSql}
    END;
    $test_reset$;
    REVOKE ALL ON FUNCTION public.test_reset_database() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.test_reset_database() TO inblack_app;`;
}

/**
 * The database decides this, not only the API: outside APP_ENV=test the function does not
 * exist, so a mistake in the API's own check still cannot wipe anything.
 */
async function syncTestReset(client: pg.Client, seedSql: string): Promise<void> {
  const appEnv = process.env.APP_ENV;
  if (appEnv === 'test') {
    await inTransaction(client, testResetFunctionSql(seedSql));
  } else {
    await client.query('DROP FUNCTION IF EXISTS public.test_reset_database()');
  }
  log('test reset function synced', { installed: appEnv === 'test' });
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const client = await connect(connectionString);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await runMigrations(client);
    await setAppRolePassword(client);
    // Seed inserts missing rows only, so live stock and voucher usage survive a restart.
    const seedSql = await readSql(SEED_FILE);
    await inTransaction(client, seedSql);
    await syncTestReset(client, seedSql);
    log('migrate and seed finished');
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({ level: 'error', service: 'migrate', message: String(error) }),
  );
  process.exitCode = 1;
}
