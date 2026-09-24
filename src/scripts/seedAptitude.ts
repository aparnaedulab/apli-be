/**
 * Loads the shared aptitude bank.
 *
 *   npx tsx src/scripts/seedAptitude.ts
 *
 * Safe to run any number of times: a question is matched on its section and
 * its exact wording, so a re-run updates the options and explanation in place
 * and never adds a second copy. Also called at the end of `npm run db:seed`.
 */
import 'dotenv/config';
import type { PrismaClient } from '@prisma/client';
import { QUESTION_BANK } from '../modules/practice/bank.js';

export async function seedAptitude(prisma: PrismaClient): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const q of QUESTION_BANK) {
    const existing = await prisma.aptitudeQuestion.findFirst({
      where: { tenantId: null, section: q.section, stem: q.stem },
      select: { id: true },
    });
    const data = {
      section: q.section,
      topic: q.topic,
      difficulty: q.difficulty,
      stem: q.stem,
      options: q.options,
      answerIndex: q.answerIndex,
      explanation: q.explanation,
      isActive: true,
    };
    if (existing) {
      await prisma.aptitudeQuestion.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.aptitudeQuestion.create({ data: { ...data, tenantId: null } });
      added++;
    }
  }
  return { added, updated };
}

// Run directly: `tsx src/scripts/seedAptitude.ts`.
if (process.argv[1] && /seedAptitude\.(ts|js)$/.test(process.argv[1])) {
  const { prisma, disconnectPrisma } = await import('../lib/prisma.js');
  seedAptitude(prisma)
    .then(({ added, updated }) => console.log(`Aptitude bank: ${added} added, ${updated} updated.`))
    .catch((err) => {
      console.error('Aptitude seed failed:', err);
      process.exitCode = 1;
    })
    .finally(disconnectPrisma);
}
