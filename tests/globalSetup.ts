import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { testDatabaseName, testDatabaseUrl } from './testDb.js';

/**
 * Tests run against their own database, created here and migrated with the real
 * migration history - so a migration that is broken fails the test run rather
 * than being discovered on someone else's machine. The development database is
 * never touched.
 */
export default async function setup() {
  const name = testDatabaseName();

  const admin = new PrismaClient();
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
  } catch {
    // Already there from a previous run, or the user lacks CREATE DATABASE and
    // made it by hand. Either is fine; migrate deploy below is the real check.
  } finally {
    await admin.$disconnect();
  }

  // Passed only to the migrate command. The parent env is deliberately left
  // alone: each test file derives the test URL itself, so nothing depends on
  // whether workers inherited a mutated value.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}
