import { z } from 'zod';
import { GradingScale, TenantKind } from '@prisma/client';
import { isAssetRef } from './assets.js';

/**
 * The shapes each onboarding step accepts.
 *
 * One schema per step, because the wizard saves a step at a time: somebody who
 * has the institution's details today and its college list next week must be
 * able to save the first without inventing the second.
 */

const blank = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** Words that are routes of the platform itself, so no tenant may own them. */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'campus',
  'company',
  'help',
  'invite',
  'join',
  'login',
  'logout',
  'platform',
  'register',
  'status',
  'student',
  'support',
  'www',
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(40, 'Keep it under 40 characters.')
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lower-case letters, numbers and hyphens only.')
  .refine((s) => !s.includes('--'), 'No double hyphens.')
  .refine((s) => !RESERVED_SLUGS.has(s), 'That address is reserved by the platform.');

/** A hex colour, #rgb or #rrggbb, stored as #rrggbb. */
const colourSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour, for example #1d3b8b.')
  .transform((v) =>
    v.length === 4
      ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase()
      : v.toLowerCase(),
  );

const urlOrBlank = z
  .string()
  .trim()
  .max(500)
  .url('Enter a full address, starting with https://')
  .optional()
  .or(z.literal(''));

/**
 * A logo or favicon: a file uploaded here (a path under /api/files), or a
 * full https link to one hosted elsewhere. Nothing else - no other paths,
 * no data: URLs.
 */
const imageRef = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === '' || isAssetRef(v) || /^https:\/\/\S+$/i.test(v),
    'Upload an image, or paste a link starting with https://',
  )
  .optional();

/** A phone number as people write it: optional +, digits, spaces and hyphens. */
const phone = z
  .string()
  .trim()
  .max(24)
  .refine((v) => v === '' || /^\+?[0-9][0-9\s-]{6,20}$/.test(v), 'Enter a phone number, for example +91 90000 00000.')
  .optional();

export const identitySchema = z.object({
  name: z.string().trim().min(3, 'Enter the institution’s name.').max(200),
  shortName: blank(40),
  slug: slugSchema,
  kind: z.nativeEnum(TenantKind),
  legalName: blank(200),
  website: urlOrBlank,
  logoUrl: imageRef,
  faviconUrl: imageRef,
  brandColor: colourSchema,
  tagline: blank(160),
  city: blank(120),
  state: blank(120),
  address: blank(400),
  pincode: blank(12),
  contactName: z.string().trim().min(2, 'Who should we talk to there?').max(120),
  contactEmail: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  contactPhone: blank(24),

  supportEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().or(z.literal('')),
  supportPhone: phone,
  supportAltPhone: phone,
  supportWhatsapp: phone,
  officeHours: blank(120),
});

export const academicsSchema = z.object({
  // No longer asked in the wizard: the tenant keeps its defaults (CGPA out of
  // 10, a June year) until a screen that needs them asks. Still accepted, so
  // a later settings screen can set them without a schema change.
  gradingScale: z.nativeEnum(GradingScale).optional(),
  academicYearStartMonth: z.number().int().min(1).max(12).optional(),
  oneOfferDefault: z.boolean(),
  allowSelfJoin: z.boolean(),
  /** Days a company has to answer an application before it shows as overdue. */
  responseDays: z.number().int().min(1).max(30).optional(),
  /** Companies need this institution's own approval, on top of platform verification. */
  companyApprovalRequired: z.boolean().optional(),
  /** Whether a company can sign in while the platform is still checking it. */
  unverifiedCompanyAccess: z.boolean().optional(),
  /** A course with an empty branch list means the course as a whole. */
  programs: z
    .array(
      z.object({
        courseId: z.string().min(1),
        specialisationIds: z.array(z.string().min(1)).max(80),
      }),
    )
    .max(80),
});

export const collegeRowSchema = z.object({
  /** Present for a college that already exists; absent for a new row. */
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Enter the college name.').max(200),
  code: z
    .string()
    .trim()
    .min(2, 'Enter a short code, for example PICT.')
    .max(16, 'Keep the code short.')
    .regex(/^[A-Za-z0-9.-]+$/, 'Letters, numbers, dots and hyphens only.')
    .transform((v) => v.toUpperCase()),
  city: z.string().trim().min(2, 'Enter the city.').max(120),
  state: z.string().trim().min(2, 'Enter the state.').max(120),
  collegeTypeId: blank(40),
  naacGrade: blank(8),
  /** Course names (from the tenant's programs) this college runs, for batches. */
  courses: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  /** The placement officer, invited when the step is saved. Both or neither. */
  officerName: blank(120),
  officerEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().or(z.literal('')),
});

export const collegesSchema = z.object({
  colleges: z.array(collegeRowSchema).max(400),
  /**
   * Passing years to make starter batches for: one per college, course and
   * year - "B.Tech 2027". Empty makes none; the placement cell can always add
   * its own later.
   */
  passingYears: z.array(z.number().int().min(2000).max(2100)).max(6).default([]),
});

/** A branch for the master list. `confirm` adds it despite a look-alike. */
export const newBranchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter the branch name, for example Computer Engineering.')
    .max(80)
    .transform((v) => v.replace(/\s+/g, ' ')),
  confirm: z.boolean().default(false),
});

/**
 * A course the shared catalogue does not have yet. Its branches are picked
 * from the master list by id - never typed - so they cannot be misspelt.
 */
export const newCourseSchema = z.object({
  name: z.string().trim().min(2, 'Enter the course name, for example B.Tech.').max(80),
  branchIds: z.array(z.string().min(1)).max(60).default([]),
});

const bulkName = z.string().trim().max(80).transform((v) => v.replace(/\s+/g, ' '));

/** Many branches at once - a pasted column. Blank lines are dropped. */
export const bulkBranchesSchema = z.object({
  names: z
    .array(bulkName)
    .max(300)
    .transform((list) => list.filter((n) => n.length > 0)),
});

/**
 * Many courses at once, each with its branches by name. Names, not ids,
 * because this comes from a spreadsheet - and every name is resolved against
 * the master list before anything is saved, which is what `preview` shows.
 */
export const bulkCoursesSchema = z.object({
  rows: z
    .array(
      z.object({
        course: bulkName,
        branches: z.array(bulkName).max(60).default([]),
      }),
    )
    .max(200)
    .transform((rows) => rows.filter((r) => r.course.length > 0)),
  /** Add branch names the master list has never seen. Look-alikes are never added. */
  addMissingBranches: z.boolean().default(false),
  /** Work out what would happen, change nothing. */
  preview: z.boolean().default(true),
});

/** More master branches for a course that already exists. */
export const attachBranchesSchema = z.object({
  branchIds: z.array(z.string().min(1)).min(1).max(60),
});

/**
 * One college, as the "Add a college" form sends it. Every column the College
 * table holds, plus the placement officer to invite.
 */
export const collegeInputSchema = z.object({
  name: z.string().trim().min(2, 'Enter the college name.').max(200),
  code: z
    .string()
    .trim()
    .min(2, 'Enter a short code, for example PICT.')
    .max(16, 'Keep the code short.')
    .regex(/^[A-Za-z0-9.-]+$/, 'Letters, numbers, dots and hyphens only.')
    .transform((v) => v.toUpperCase()),
  collegeTypeId: blank(40),
  /** Affiliated to this university, autonomous, or affiliated elsewhere. */
  affiliation: z.enum(['THIS_UNIVERSITY', 'AUTONOMOUS', 'OTHER']).default('THIS_UNIVERSITY'),
  affiliationName: blank(200),
  city: z.string().trim().min(2, 'Enter the city.').max(120),
  state: z.string().trim().min(2, 'Enter the state.').max(120),
  address: blank(400),
  pincode: z
    .string()
    .trim()
    .refine((v) => v === '' || /^[0-9]{6}$/.test(v), 'A PIN code is six digits.')
    .optional(),
  naacGrade: blank(8),
  /** The platform team has checked this college is what it says it is. */
  isVerified: z.boolean().default(false),
  officerName: blank(120),
  officerEmail: z.string().trim().toLowerCase().email('Enter a valid email address.').optional().or(z.literal('')),
}).refine((v) => v.affiliation !== 'OTHER' || Boolean(v.affiliationName), {
  message: 'Name the university it is affiliated to.',
  path: ['affiliationName'],
});

/**
 * A batch, created once for the whole university or once per chosen college.
 * Every field but the scope is optional: "2026 Batch" is a year and nothing
 * else, "B.Tech Computer Engineering 2026" is all three.
 */
export const batchesSchema = z
  .object({
    scope: z.enum(['UNIVERSITY', 'ALL_COLLEGES', 'SOME_COLLEGES']),
    collegeIds: z.array(z.string().min(1)).max(400).default([]),
    name: z.string().trim().max(120).optional().or(z.literal('')),
    course: z.string().trim().max(120).optional().or(z.literal('')),
    specialisation: z.string().trim().max(120).optional().or(z.literal('')),
    graduationYear: z.number().int().min(2000).max(2100).optional(),
    studyYear: z.number().int().min(1).max(6).optional(),
    headOfDept: z.string().trim().max(120).optional().or(z.literal('')),
  })
  .refine((v) => v.scope !== 'SOME_COLLEGES' || v.collegeIds.length > 0, {
    message: 'Choose at least one college.',
    path: ['collegeIds'],
  })
  .refine((v) => Boolean(v.name || v.course || v.graduationYear || v.studyYear), {
    message: 'Give the batch a name, or at least a course or a year.',
    path: ['name'],
  });

export const featuresSchema = z.object({
  selected: z.array(z.string().min(1)).max(200),
  /**
   * Asked here as well as in step 2: this is the step where somebody decides
   * what a company gets, and "can a company that registered get in at all" is
   * the first of those.
   */
  unverifiedCompanyAccess: z.boolean().optional(),
});

export const adminInviteSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter their name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  phone: blank(24),
  /** An operations role. Defaults to the super admin of the institution. */
  roleId: z.string().trim().optional().or(z.literal('')),
  sendEmail: z.boolean().default(true),
});

export const actAsSchema = z.object({
  tenantId: z.string().min(1).nullable(),
});

export type IdentityInput = z.infer<typeof identitySchema>;
export type AcademicsInput = z.infer<typeof academicsSchema>;
export type CollegesInput = z.infer<typeof collegesSchema>;
export type CollegeInput = z.infer<typeof collegeInputSchema>;
export type BatchesInput = z.infer<typeof batchesSchema>;
