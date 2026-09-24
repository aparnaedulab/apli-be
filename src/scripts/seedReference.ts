import { RefKind } from '@prisma/client';
import { prisma, disconnectPrisma } from '../lib/prisma.js';

/**
 * Fills the shared vocabularies from what is already in use, plus the few
 * that have a fixed answer nobody invents.
 *
 * Cities and states come from the colleges and companies already on the
 * portal, because those are the real ones - starting from a list of every
 * city in India would bury the six that matter. NAAC grades and genders are
 * fixed vocabularies and are seeded outright.
 *
 * Idempotent: run it again after an import that brought in a new city.
 */

/** Where a list has an order that is not alphabetical. */
const GRADES = ['A++', 'A+', 'A', 'B++', 'B+', 'B', 'C', 'D'];
const GENDERS = ['Female', 'Male', 'Other', 'Prefer not to say'];

async function add(kind: RefKind, value: string, position = 0): Promise<boolean> {
  const clean = value.trim();
  if (!clean) return false;

  const existing = await prisma.refValue.findFirst({ where: { kind, value: clean } });
  if (existing) return false;

  await prisma.refValue.create({ data: { kind, value: clean, position } });
  return true;
}

async function main(): Promise<void> {
  const [colleges, companies] = await Promise.all([
    prisma.college.findMany({ select: { city: true, state: true } }),
    prisma.company.findMany({ select: { city: true, state: true } }),
  ]);

  const rows = [...colleges, ...companies];
  const cities = [...new Set(rows.map((r) => r.city).filter((v): v is string => Boolean(v?.trim())))];
  const states = [...new Set(rows.map((r) => r.state).filter((v): v is string => Boolean(v?.trim())))];

  let added = 0;
  for (const city of cities.sort()) if (await add(RefKind.CITY, city)) added++;
  for (const state of states.sort()) if (await add(RefKind.STATE, state)) added++;

  // Ordered as a reader expects them, best first, rather than alphabetically.
  for (const [i, grade] of GRADES.entries()) if (await add(RefKind.NAAC_GRADE, grade, i)) added++;
  for (const [i, gender] of GENDERS.entries()) if (await add(RefKind.GENDER, gender, i)) added++;

  const counts = await prisma.refValue.groupBy({ by: ['kind'], _count: { _all: true } });
  console.log(`Reference values: ${added} added.`);
  for (const c of counts) console.log(`  ${c.kind.padEnd(12)} ${c._count._all}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
