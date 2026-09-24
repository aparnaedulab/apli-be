import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

// The same expansion the app does, so DATABASE_URL composed from the MYSQL_*
// values resolves here too. Without this the tests would try to connect to a
// host literally called "${MYSQL_HOST}".
dotenvExpand.expand(dotenv.config());

/**
 * The test database is derived from DATABASE_URL rather than hard-coded, so it
 * follows whatever the project's database is actually called - `apli` becomes
 * `apli_test`. Both the global setup and each test file read it from here, so
 * they cannot disagree about which database is being wiped.
 */
function parts() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) throw new Error(`DATABASE_URL has no database name: ${url}`);

  return { parsed, name };
}

const SUFFIX = '_test';

/**
 * Idempotent on purpose. Vitest workers inherit the parent process env, so this
 * can be called against a DATABASE_URL that already points at the test
 * database - appending the suffix twice would silently target `apli_test_test`,
 * which does not exist.
 */
export function testDatabaseName(): string {
  const { name } = parts();
  return name.endsWith(SUFFIX) ? name : `${name}${SUFFIX}`;
}

export function testDatabaseUrl(): string {
  const { parsed } = parts();
  parsed.pathname = `/${testDatabaseName()}`;

  /*
   * One connection, for the whole test run.
   *
   * The reset between tests turns foreign key checks off and then truncates
   * every table - and `SET FOREIGN_KEY_CHECKS = 0` lasts only for the session
   * it was run on. With a pool, the truncate can land on a different
   * connection where the checks are still on, and the reset fails with
   * "cannot truncate a table referenced in a foreign key constraint".
   *
   * It is intermittent, and it gets likelier as the schema grows, because
   * every new table is another chance to reach for a second connection. A
   * pool of one removes the race rather than making it rarer. Tests run
   * sequentially anyway - `fileParallelism` is off for the same reason.
   */
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
}
