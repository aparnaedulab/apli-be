import { describe, expect, it } from 'vitest';
import { JobOptionKind } from '@prisma/client';
import { db } from './setup.js';
import { makeCompany } from './factories.js';
import {
  addOption,
  assertKnown,
  labelsFor,
  optionsFor,
  traitsOf,
  valueFor,
} from '../src/modules/jobs/job.options.js';

/**
 * The dropdowns a company can add to.
 *
 * Two rules hold everything else up: what ships cannot be taken away, and
 * what one company invents stays with that company.
 */

describe('what a dropdown offers', () => {
  it('ships the standard choices to a company that has added nothing', async () => {
    const company = await makeCompany();
    const lists = await optionsFor(company.id);

    expect(lists.ROUND_TYPE.map((o) => o.value)).toContain('LIVE_INTERVIEW');
    expect(lists.WORK_MODE.map((o) => o.value)).toEqual(['ONSITE', 'HYBRID', 'REMOTE']);
    expect(lists.ROUND_TYPE.every((o) => o.isStandard)).toBe(true);
  });

  it('adds what a company invents, marked as theirs', async () => {
    const company = await makeCompany();
    const added = await addOption(company.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    expect(added).toMatchObject({ label: 'Machine test', isStandard: false });
    expect(added.value).toBe('CUSTOM_MACHINE_TEST');

    const lists = await optionsFor(company.id);
    expect(lists.ROUND_TYPE.find((o) => o.value === added.value)?.label).toBe('Machine test');

    // The shipped ones are still there - adding is not replacing.
    expect(lists.ROUND_TYPE.map((o) => o.value)).toContain('LIVE_INTERVIEW');
  });

  it('keeps one company out of another company list', async () => {
    const mine = await makeCompany();
    const theirs = await makeCompany();

    await addOption(mine.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    // A recruiter inventing a word should not change what every other company
    // on the platform sees in its own dropdown.
    const others = await optionsFor(theirs.id);
    expect(others.ROUND_TYPE.some((o) => o.label === 'Machine test')).toBe(false);
  });

  it('refuses a second choice that says the same thing', async () => {
    const company = await makeCompany();
    await addOption(company.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    // Case-insensitively: two spellings in one dropdown is a bug that only
    // ever looks like one to the person reading it.
    await expect(
      addOption(company.id, JobOptionKind.ROUND_TYPE, 'machine test'),
    ).rejects.toThrow(/already on that list/i);

    await expect(
      addOption(company.id, JobOptionKind.ROUND_TYPE, '  Machine   test  '),
    ).rejects.toThrow(/already on that list/i);
  });

  it('refuses one that collides with a shipped choice', async () => {
    const company = await makeCompany();

    await expect(
      addOption(company.id, JobOptionKind.ROUND_TYPE, 'Live interview'),
    ).rejects.toThrow(/already on that list/i);
  });

  it('never lets an invented value collide with a shipped one', () => {
    // A company calling something "Online test" must not silently become
    // MCQ_TEST and inherit whatever that comes to mean later.
    expect(valueFor('Online test')).toBe('CUSTOM_ONLINE_TEST');
    expect(valueFor('Online test')).not.toBe('MCQ_TEST');
    expect(valueFor('   ')).toBe('CUSTOM_OPTION');
  });
});

describe('the employment type, which the form behaves differently about', () => {
  it('ships the four kinds with what each one does', async () => {
    const company = await makeCompany();
    const lists = await optionsFor(company.id);

    const byValue = new Map(lists.EMPLOYMENT_TYPE.map((o) => [o.value, o]));

    expect(byValue.get('FULL_TIME')).toMatchObject({ paysStipend: false, convertsToPpo: false });
    expect(byValue.get('INTERNSHIP')).toMatchObject({ paysStipend: true, convertsToPpo: false });
    expect(byValue.get('INTERNSHIP_PPO')).toMatchObject({
      paysStipend: true,
      convertsToPpo: true,
    });
  });

  it('carries the traits of one a company invents', async () => {
    const company = await makeCompany();

    const added = await addOption(company.id, JobOptionKind.EMPLOYMENT_TYPE, 'Apprenticeship', {
      paysStipend: true,
      convertsToPpo: true,
    });

    expect(added).toMatchObject({ paysStipend: true, convertsToPpo: true, isStandard: false });
    expect(await traitsOf(company.id, added.value)).toEqual({
      paysStipend: true,
      convertsToPpo: true,
    });
  });

  it('will not let something convert that is not paid in the first place', async () => {
    const company = await makeCompany();

    // A pre-placement offer is a promise made at the end of something. A type
    // that converts but has nothing to convert from would ask the recruiter
    // for a figure that describes nothing.
    const added = await addOption(company.id, JobOptionKind.EMPLOYMENT_TYPE, 'Odd one', {
      convertsToPpo: true,
    });

    expect(added).toMatchObject({ paysStipend: false, convertsToPpo: false });
  });

  it('treats a type it has never seen as a plain job', async () => {
    const company = await makeCompany();

    // Rather than guessing: nothing is asked for that cannot be honoured.
    expect(await traitsOf(company.id, 'SOMETHING_RETIRED')).toEqual({
      paysStipend: false,
      convertsToPpo: false,
    });
  });

  it('keeps traits off the lists that are only words', async () => {
    const company = await makeCompany();

    const added = await addOption(company.id, JobOptionKind.ROUND_TYPE, 'Machine test', {
      paysStipend: true,
      convertsToPpo: true,
    });

    expect(added).toMatchObject({ paysStipend: false, convertsToPpo: false });
  });
});

describe('what may be stored', () => {
  it('accepts a shipped choice and one the company added', async () => {
    const company = await makeCompany();
    const added = await addOption(company.id, JobOptionKind.ROUND_MODE, 'At the test centre');

    await expect(
      assertKnown(company.id, JobOptionKind.ROUND_TYPE, 'LIVE_INTERVIEW'),
    ).resolves.toBeUndefined();
    await expect(
      assertKnown(company.id, JobOptionKind.ROUND_MODE, added.value),
    ).resolves.toBeUndefined();
  });

  it('refuses a value no dropdown offers', async () => {
    const company = await makeCompany();

    // Otherwise a typo in a request puts a choice on a round that nobody can
    // ever select again, and no screen can explain where it came from.
    await expect(
      assertKnown(company.id, JobOptionKind.ROUND_TYPE, 'TELEPATHY'),
    ).rejects.toThrow(/not one of the choices/i);
  });

  it('refuses another company invention', async () => {
    const mine = await makeCompany();
    const theirs = await makeCompany();
    const added = await addOption(theirs.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    await expect(
      assertKnown(mine.id, JobOptionKind.ROUND_TYPE, added.value),
    ).rejects.toThrow(/not one of the choices/i);
  });

  it('lets nothing through as nothing', async () => {
    const company = await makeCompany();

    // Not stating a work mode is allowed; it is the empty case, not a value.
    await expect(
      assertKnown(company.id, JobOptionKind.WORK_MODE, null),
    ).resolves.toBeUndefined();
    await expect(assertKnown(company.id, JobOptionKind.WORK_MODE, '')).resolves.toBeUndefined();
  });
});

describe('reading a stored value back', () => {
  it('gives the words a person chose, not the key it was saved under', async () => {
    const company = await makeCompany();
    const added = await addOption(company.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    const label = await labelsFor(company.id);

    expect(label('ROUND_TYPE', added.value)).toBe('Machine test');
    expect(label('ROUND_TYPE', 'LIVE_INTERVIEW')).toBe('Live interview');
    expect(label('WORK_MODE', null)).toBeNull();
  });

  it('falls back to the stored value rather than showing nothing', async () => {
    const company = await makeCompany();
    const label = await labelsFor(company.id);

    // A choice retired after a role was saved still has to render as
    // something - a blank where a round kind should be tells nobody anything.
    expect(label('ROUND_TYPE', 'SOMETHING_RETIRED')).toBe('SOMETHING_RETIRED');
  });

  it('goes when the company goes', async () => {
    const company = await makeCompany();
    await addOption(company.id, JobOptionKind.ROUND_TYPE, 'Machine test');

    await db.company.delete({ where: { id: company.id } });

    expect(await db.jobOption.count({ where: { companyId: company.id } })).toBe(0);
  });
});
