import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Refuses to build against a Prisma client that predates the schema.
 *
 * The failure this exists for: somebody pulls a branch that added a model,
 * runs `npm run build`, and gets a page of errors that all say some variant
 * of "has no exported member" or "does not exist on type PrismaClient". None
 * of them mentions Prisma, none of them is a real type error, and the actual
 * cause - a generated client older than prisma/schema.prisma - is not
 * anywhere in the output. It cost a deploy to work out once.
 *
 * `deploy.sh` generates before it builds, so this only ever fires on a
 * manual build. It is a check rather than a `prisma generate` wired into
 * the build script because generating rewrites the query engine binary, and
 * on Windows that fails outright while any other process has the engine
 * open - which would trade a clear error for a confusing one.
 */

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const SCHEMA = here('../prisma/schema.prisma');
const GENERATED = here('../node_modules/.prisma/client/schema.prisma');

const say = (lines) => {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
};

let schema;
try {
  schema = readFileSync(SCHEMA, 'utf8');
} catch {
  // No schema at all is somebody else's problem; do not stand in the way.
  process.exit(0);
}

let generated;
try {
  generated = readFileSync(GENERATED, 'utf8');
} catch {
  say([
    'The Prisma client has not been generated yet.',
    '',
    '  npx prisma generate',
    '',
    'Then build again.',
  ]);
}

// Line endings differ between a Windows checkout and a Linux one, and mean
// nothing here.
const same = (a) => a.replace(/\r\n/g, '\n').trim();

if (same(schema) !== same(generated)) {
  say([
    'The generated Prisma client is out of date with prisma/schema.prisma.',
    '',
    'Every "has no exported member" and "does not exist on type PrismaClient"',
    'error you would get from this build is that, and nothing else.',
    '',
    '  npx prisma generate',
    '  npx prisma migrate deploy   # if the schema change added a migration',
    '',
    'Then build again. (deploy.sh already does both; a manual build does not.)',
  ]);
}
