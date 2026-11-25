/**
 * Builds (or resets) the demo logins from the command line - the same as the
 * "Reset demo logins" button in the platform console.
 *
 *   npm run demo:logins            build or reset, then list every login
 *   npm run demo:logins -- --wipe  remove the demo pack and stop
 *
 * Sends no mail and no WhatsApp. Touches nothing outside the demo pack.
 */
import { disconnectPrisma } from '../lib/prisma.js';
import { demoPassword, describeDemoLogins, resetDemoPack, wipeDemoPack } from '../modules/demoLogins/demoLogins.service.js';

async function main() {
  if (process.argv.includes('--wipe')) {
    await wipeDemoPack();
    console.log('Demo pack removed.');
    return;
  }
  const r = await resetDemoPack();
  console.log(`Built ${r.logins} demo logins (${r.students} students, ${r.companies} companies) in ${r.seconds}s.`);
  const d = await describeDemoLogins();
  console.log(`\nPassword for every login: ${demoPassword()}\n`);
  let group = '';
  for (const l of d.logins) {
    if (l.group !== group) console.log(`\n${(group = l.group).toUpperCase()}`);
    console.log(`  ${l.email.padEnd(46)} ${l.situation}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
