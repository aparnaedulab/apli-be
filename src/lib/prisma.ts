import { PrismaClient } from '@prisma/client';
import { databaseUrl, isProduction } from '../config/env.js';

/**
 * A single Prisma client for the process. Re-using one client keeps the
 * connection pool bounded; creating one per request exhausts MySQL.
 *
 * The URL is handed over explicitly rather than left to `env("DATABASE_URL")`
 * in the schema. The schema's version reads whatever is in the environment at
 * the moment the client is built; this one is the URL this process actually
 * decided on, composed from the MYSQL_* fields when no complete one was
 * given. Passing it removes the ordering question entirely.
 */
export const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
