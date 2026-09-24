/**
 * Reports (and with --fix, rewrites) contact values in the database that are
 * not demo values: the old Campus Hire admin, real college email domains and
 * realistic mobile numbers. Dev databases only.
 */
import { prisma } from '../lib/prisma.js';

const EMAIL_SWAPS: [string, string][] = [
  ['admin@campushire.local', 'admin@apli.example'],
  ['no-reply@campushire.local', 'no-reply@apli.example'],
  ['@campushire.local', '@apli.example'],
  ['ops@unipune.example', 'ops@demo-university.example'],
  ['@unipune.ac.in', '@demo-university.example'],
  ['@pict.edu', '@pict.demo-college.example'],
  ['@vit.edu', '@vit.demo-college.example'],
  ['@dypit.edu', '@dypit.demo-college.example'],
  ['@viit.edu', '@viit.demo-college.example'],
  ['@aisc.edu', '@aisc.demo-college.example'],
];

const fix = process.argv.includes('--fix');

async function main() {
  const db = (await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT DATABASE() AS db'))[0]!.db;
  if (db.endsWith('_test')) throw new Error('Refusing to run against a test database.');
  console.log(`database: ${db}${fix ? ' (fixing)' : ' (report only)'}`);

  const cols = await prisma.$queryRawUnsafe<{ t: string; c: string }[]>(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('varchar','text','longtext','mediumtext')
       AND (COLUMN_NAME LIKE '%mail%' OR COLUMN_NAME LIKE '%phone%' OR COLUMN_NAME LIKE '%Phone%'
            OR COLUMN_NAME LIKE '%whatsapp%' OR COLUMN_NAME LIKE '%Whatsapp%' OR COLUMN_NAME LIKE '%mobile%')`,
  );

  for (const { t, c } of cols) {
    const q = (s: string) => '`' + s + '`';
    if (/mail/i.test(c)) {
      for (const [from, to] of EMAIL_SWAPS) {
        const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${q(c)} LIKE ?`, `%${from}%`,
        );
        const n = row?.n ?? 0n;
        if (Number(n) === 0) continue;
        console.log(`  ${t}.${c}: ${n} × ${from}`);
        if (fix) {
          await prisma.$executeRawUnsafe(
            `UPDATE ${q(t)} SET ${q(c)} = REPLACE(${q(c)}, ?, ?) WHERE ${q(c)} LIKE ?`, from, to, `%${from}%`,
          );
        }
      }
    } else {
      // A phone is a demo value when its digits start 90000 (after an optional 91).
      const rows = await prisma.$queryRawUnsafe<Record<string, string>[]>(
        `SELECT ${q(c)} AS v FROM ${q(t)} WHERE ${q(c)} IS NOT NULL AND ${q(c)} <> ''`,
      );
      const real = rows.map((r) => r.v).filter((v) => {
        const d = String(v).replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
        return d.length >= 10 && !d.startsWith('90000');
      });
      if (real.length === 0) continue;
      console.log(`  ${t}.${c}: ${real.length} non-demo number(s), e.g. ${real[0]}`);
      if (fix) {
        for (const v of new Set(real)) {
          const d = String(v).replace(/\D/g, '');
          const demo = `90000${d.slice(-5)}`;
          const shaped = String(v).trim().startsWith('+91') ? `+91 ${demo.slice(0, 5)} ${demo.slice(5)}` : demo;
          await prisma.$executeRawUnsafe(`UPDATE ${q(t)} SET ${q(c)} = ? WHERE ${q(c)} = ?`, shaped, v);
        }
      }
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
