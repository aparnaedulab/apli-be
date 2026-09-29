import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { STUDENT_FIELDS, configurableFields, fieldFor, type StudentField } from './fields.js';

/**
 * What one institution collects about a student, and who may put them on the
 * roster.
 *
 * ---------------------------------------------------------------------------
 * Why this is a setting and not a constant
 *
 * The field registry says what a student record *can* hold. It cannot say
 * what a particular university *wants*: one insists on a PRN and never asks
 * for a date of birth, another is the reverse, and a third collects the
 * postgraduate marks because half its colleges are postgraduate. Before
 * this, every institution got the same three required fields and everything
 * else optional, because nobody had been asked.
 *
 * The same is true of who may add a student. The platform let the university
 * and every college do it, always. A university that enters its own rosters
 * centrally had no way to stop a college adding students it had not checked,
 * and a university that wanted students to register themselves had only a
 * batch join code that collected a name, an email and a password - which
 * produced students with no course, invisible to every role that filters on
 * one, for the rest of their degree.
 *
 * ---------------------------------------------------------------------------
 * What cannot be configured
 *
 * Two things, whatever the policy says. A name and an email are the account:
 * turning either off would mean a student nobody can identify or reach, so
 * they are always required. And a field the registry does not know is
 * dropped on the way in, so retiring a field cannot break a saved policy.
 */

export type FieldRule = 'off' | 'optional' | 'required';

export interface IntakePolicy {
  /** Keyed by field. Every registry field has an answer, defaulted if unsaid. */
  fields: Record<string, FieldRule>;
  universityMayAdd: boolean;
  collegeMayAdd: boolean;
  selfRegister: boolean;
  /** Field keys the public registration form asks for. */
  selfFields: string[];
  selfNeedsApproval: boolean;
}

/** The account itself. No institution may switch these off. */
export const ALWAYS_REQUIRED = ['fullName', 'email'] as const;

/**
 * Structural, not a question on a form.
 *
 * Which college a student belongs to is settled by how they got here - the
 * code they typed, or whose roster they are on. Which batch is a choice the
 * registration form makes in its own right. Neither is a field somebody
 * ticks on the policy screen.
 */
export const NOT_SELF_ASKABLE = ['college', 'batch'] as const;

/**
 * What an institution gets before anybody has decided anything.
 *
 * Exactly the behaviour the platform had when the field set was fixed: name,
 * email and mobile required, everything else offered and optional, both the
 * university and its colleges able to add, and no self-registration. An
 * institution that never opens the screen is therefore unaffected by this
 * existing at all.
 */
export function defaultPolicy(): IntakePolicy {
  const fields: Record<string, FieldRule> = {};
  for (const f of configurableFields()) {
    fields[f.key] = f.requiredOnImport ? 'required' : 'optional';
  }

  return {
    fields,
    universityMayAdd: true,
    collegeMayAdd: true,
    selfRegister: false,
    selfFields: [],
    selfNeedsApproval: true,
  };
}

/** Anything saved is merged onto the defaults, so a new field arrives offered. */
function hydrate(saved: Partial<IntakePolicy> & { fields?: unknown; selfFields?: unknown }): IntakePolicy {
  const base = defaultPolicy();
  const raw = (saved.fields ?? {}) as Record<string, unknown>;

  for (const f of configurableFields()) {
    const rule = raw[f.key];
    if (rule === 'off' || rule === 'optional' || rule === 'required') base.fields[f.key] = rule;
  }
  for (const key of ALWAYS_REQUIRED) base.fields[key] = 'required';

  const self = Array.isArray(saved.selfFields) ? (saved.selfFields as unknown[]) : [];

  return {
    fields: base.fields,
    universityMayAdd: saved.universityMayAdd ?? base.universityMayAdd,
    collegeMayAdd: saved.collegeMayAdd ?? base.collegeMayAdd,
    selfRegister: saved.selfRegister ?? base.selfRegister,
    selfFields: self.filter(
      (k): k is string =>
        typeof k === 'string' &&
        configurableFields().some((f) => f.key === k) &&
        base.fields[k] !== 'off' &&
        !(NOT_SELF_ASKABLE as readonly string[]).includes(k),
    ),
    selfNeedsApproval: saved.selfNeedsApproval ?? base.selfNeedsApproval,
  };
}

/** The institution's policy, or the default if it has never set one. */
export async function policyFor(tenantId: string | null): Promise<IntakePolicy> {
  if (!tenantId) return defaultPolicy();
  const row = await prisma.studentIntakePolicy.findUnique({ where: { tenantId } });
  if (!row) return defaultPolicy();

  return hydrate({
    fields: row.fields,
    universityMayAdd: row.universityMayAdd,
    collegeMayAdd: row.collegeMayAdd,
    selfRegister: row.selfRegister,
    selfFields: row.selfFields,
    selfNeedsApproval: row.selfNeedsApproval,
  } as Partial<IntakePolicy>);
}

/** The policy that governs one college, which is its university's. */
export async function policyForCollege(collegeId: string | null): Promise<IntakePolicy> {
  if (!collegeId) return defaultPolicy();
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: { tenantId: true },
  });
  return policyFor(college?.tenantId ?? null);
}

/**
 * Saves a policy, refusing the combinations that cannot mean anything.
 *
 * Refused rather than quietly corrected: somebody who has just switched off
 * the only way students can be added should be told, not have the switch
 * flipped back under them.
 */
export async function savePolicy(tenantId: string, input: Partial<IntakePolicy>): Promise<IntakePolicy> {
  const next = hydrate(input);

  if (!next.universityMayAdd && !next.collegeMayAdd && !next.selfRegister) {
    throw badRequest(
      'Somebody has to be able to add students. Allow the university, its colleges, or registration.',
    );
  }

  if (next.selfRegister && next.selfFields.length === 0) {
    throw badRequest(
      'Registration needs at least one field beyond the name and email every account has.',
    );
  }

  await prisma.studentIntakePolicy.upsert({
    where: { tenantId },
    update: {
      fields: next.fields,
      universityMayAdd: next.universityMayAdd,
      collegeMayAdd: next.collegeMayAdd,
      selfRegister: next.selfRegister,
      selfFields: next.selfFields,
      selfNeedsApproval: next.selfNeedsApproval,
    },
    create: {
      tenantId,
      fields: next.fields,
      universityMayAdd: next.universityMayAdd,
      collegeMayAdd: next.collegeMayAdd,
      selfRegister: next.selfRegister,
      selfFields: next.selfFields,
      selfNeedsApproval: next.selfNeedsApproval,
    },
  });

  return next;
}

/* -------------------------------------------------------------------------- */
/* Reading a policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A field set by another - course and branch, which a programme resolves to
 * - follows whatever that other field was set to.
 */
const rule = (policy: IntakePolicy, key: string): FieldRule => {
  const field = STUDENT_FIELDS.find((f) => f.key === key);
  const own = policy.fields[field?.configuredBy ?? key];
  return own ?? 'optional';
};

export const isOn = (policy: IntakePolicy, key: string): boolean => rule(policy, key) !== 'off';
export const isRequired = (policy: IntakePolicy, key: string): boolean =>
  rule(policy, key) === 'required';

/** The fields this institution collects, in registry order. */
export const collectedFields = (policy: IntakePolicy): StudentField[] =>
  STUDENT_FIELDS.filter((f) => isOn(policy, f.key));

/** The ones it insists on. */
export const requiredFields = (policy: IntakePolicy): StudentField[] =>
  configurableFields().filter((f) => isRequired(policy, f.key));

/**
 * What a policy costs the students it covers.
 *
 * A field a role's eligibility reads can be switched off - it is the
 * institution's roster - but switching it off means every role that sets a
 * bar on it becomes invisible to every one of their students, and nothing on
 * a student's screen would explain why. So the screen says so, in the same
 * words, before it is saved.
 */
export function warningsFor(policy: IntakePolicy): string[] {
  return configurableFields().filter((f) => f.readsEligibility && !isOn(policy, f.key)).map(
    (f) =>
      `${f.label} is switched off. Any role that sets a bar on it will be invisible to your students, and nothing on their screen will say why.`,
  );
}

/** The fields a registration form may offer, whatever the institution picked. */
export const selfAskableFields = (policy: IntakePolicy): StudentField[] =>
  configurableFields().filter(
    (f) => isOn(policy, f.key) && !(NOT_SELF_ASKABLE as readonly string[]).includes(f.key),
  );

/** The ones it actually asks, in registry order. */
export const selfFormFields = (policy: IntakePolicy): StudentField[] =>
  selfAskableFields(policy).filter((f) => policy.selfFields.includes(f.key));

/**
 * Whether a row is missing something this institution insists on.
 *
 * Returns the labels, so the caller can say which - a refusal that names the
 * column is one somebody can act on.
 */
export function missingRequired(
  policy: IntakePolicy,
  has: (key: string) => boolean,
): string[] {
  return requiredFields(policy)
    .filter((f) => !has(f.key))
    .map((f) => f.label.toLowerCase());
}

export { fieldFor };

/* -------------------------------------------------------------------------- */
/* Who may add                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Refuses an actor the institution has not allowed to put students on the
 * roster.
 *
 * Checked on the way in rather than hidden on the screen alone: a university
 * that has taken roster entry away from its colleges has done so for a
 * reason, and a screen that merely stops showing the button is not that.
 */
export function assertMayAdd(policy: IntakePolicy, actor: 'university' | 'college'): void {
  if (actor === 'university' && !policy.universityMayAdd) {
    throw badRequest(
      'This institution has chosen that students are added by its colleges, not centrally. Change that under Set up → Students.',
    );
  }
  if (actor === 'college' && !policy.collegeMayAdd) {
    throw badRequest(
      'Your university adds students centrally. Ask your placement office to add them, or to allow colleges to.',
    );
  }
}


/* -------------------------------------------------------------------------- */
/* What the screen is given                                                    */
/* -------------------------------------------------------------------------- */

export const intakePolicySchema = z
  .object({
    fields: z.record(z.enum(['off', 'optional', 'required'])),
    universityMayAdd: z.boolean(),
    collegeMayAdd: z.boolean(),
    selfRegister: z.boolean(),
    selfFields: z.array(z.string()).max(64),
    selfNeedsApproval: z.boolean(),
  })
  .partial()
  .strict();

/**
 * Everything the screen needs to draw itself, in one answer.
 *
 * The list of fields comes from the registry rather than from the client, so
 * a field added to the platform appears on the screen without anybody
 * editing it - and its help note is the same sentence the spreadsheet and
 * the student's own form use.
 */
export function describeIntake(policy: IntakePolicy) {
  return {
    policy,
    warnings: warningsFor(policy),
    fields: configurableFields().map((f) => ({
      key: f.key,
      label: f.label,
      note: f.note,
      /** What a role's eligibility reads, which is what makes it costly to switch off. */
      readsEligibility: Boolean(f.readsEligibility),
      /** The account itself: offered, but not switchable. */
      locked: (ALWAYS_REQUIRED as readonly string[]).includes(f.key),
      /** May be asked on a registration form. */
      selfAskable: selfAskableFields(policy).some((s) => s.key === f.key),
      /** Settled by how a student got here, so never a question on a form. */
      structural: (NOT_SELF_ASKABLE as readonly string[]).includes(f.key),
    })),
  };
}
