import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env.js';

/**
 * A single Prisma client for the process. Re-using one client keeps the
 * connection pool bounded; creating one per request exhausts MySQL.
 */
export const prisma = new PrismaClient({
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
