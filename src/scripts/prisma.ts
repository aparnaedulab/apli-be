/**
 * Runs the Prisma CLI with DATABASE_URL already worked out.
 *
 *   npm run db:migrate            -> prisma migrate deploy
 *   npm run prisma -- <anything>  -> prisma <anything>
 *
 * The schema says `url = env("DATABASE_URL")`, and the CLI reads that from
 * the environment - it does not import this project's config, so it cannot
 * know that the connection is really five MYSQL_* fields. Importing the
 * config here composes the URL and puts it on process.env before the CLI is
 * spawned, so `migrate deploy` and the running server always agree about
 * which database they mean.
 *
 * Without this, a .env holding only the MYSQL_* fields would start the
 * server perfectly and fail every migration with "DATABASE_URL required",
 * which is a confusing way to find out the two read different things.
 */
import { spawnSync } from 'node:child_process';
import { databaseUrl } from '../config/env.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: tsx src/scripts/prisma.ts <prisma args>   e.g. migrate deploy');
  process.exit(1);
}

// Never print it: it carries the password.
const shown = databaseUrl.replace(/:[^:@]*@/, ':***@');
console.log(`prisma ${args.join(' ')}\n  database: ${shown}\n`);

const result = spawnSync('npx', ['prisma', ...args], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
