import { beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './testDb.js';

const url = testDatabaseUrl();
process.env.DATABASE_URL = url;

export const db = new PrismaClient({ datasources: { db: { url } } });

/**
 * Every test starts from an empty database. Truncating is faster than dropping
 * and re-migrating; foreign key checks come off for the duration rather than
 * the tables being ordered by hand.
 */
beforeEach(async () => {
  const tables = await db.$queryRaw<{ TABLE_NAME: string }[]>`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE '_prisma%'
  `;
  if (tables.length === 0) return;

  /*
   * DELETE rather than TRUNCATE, which is slower and worth it.
   *
   * TRUNCATE takes an exclusive metadata lock on the table. A connection left
   * open by the previous test file - the pool does not always close instantly
   * between files - is enough to block it, and the wait shows up as a test
   * that takes fifty seconds and then fails for reasons that have nothing to
   * do with what it was testing. DELETE takes ordinary row locks, and these
   * tables hold tens of rows.
   *
   * The foreign key switch is session-scoped, so it and the deletes have to
   * run on one connection. The test URL pins the pool to a single connection
   * for exactly that reason - see testDb.ts.
   */
  await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const { TABLE_NAME } of tables) {
    await db.$executeRawUnsafe(`DELETE FROM \`${TABLE_NAME}\``);
  }
  await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
});

afterAll(async () => {
  await db.$disconnect();
});
