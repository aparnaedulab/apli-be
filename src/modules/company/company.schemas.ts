import { z } from 'zod';
import { CompanySize } from '@prisma/client';
import { isAssetRef } from '../tenants/assets.js';

/**
 * The company profile, in one place.
 *
 * Three callers share it and must not drift apart: operations entering a
 * company by hand, a company registering itself, and a company editing its own
 * profile afterwards. Only `name` is required here - a placement cell that
 * knows a recruiter by reputation should not be blocked because nobody has
 * looked up their CIN. A company signing itself up answers more, which
 * `companyRegistrationSchema` below sets out.
 */

const blank = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

const url = (message: string) => z.string().trim().url(message).optional().or(z.literal(''));

/**
 * A picture is either one we stored ourselves or one hosted over https.
 * Anything else - a data: blob, a file path, another site's http - is refused
 * rather than put in front of students.
 */
const picture = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || isAssetRef(v) || /^https:\/\/\S+$/i.test(v), message)
    .optional()
    .or(z.literal(''));

/** The most a page shows, and the most anyone wants to scroll past. */
export const MAX_PHOTOS = 6;

export interface CompanyPhoto {
  url: string;
  caption?: string;
}

/**
 * Photographs as a list, whatever the column holds.
 *
 * The JSON column can hold anything a past write left there, and a screen
 * that maps over it should not have to wonder. Rubbish is dropped rather than
 * shown as a broken picture.
 */
export function photosOf(value: unknown): CompanyPhoto[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p): p is CompanyPhoto => Boolean(p) && typeof (p as CompanyPhoto).url === 'string')
    .slice(0, MAX_PHOTOS)
    .map((p) => ({ url: p.url, ...(p.caption ? { caption: String(p.caption) } : {}) }));
}

const photoSchema = z
  .object({
    url: picture('Upload the photograph, or give an https link to it.').pipe(
      z.string().min(1, 'That photograph has no image.'),
    ),
    caption: z.string().trim().max(120, 'Keep a caption under 120 characters.').optional().or(z.literal('')),
  })
  .strict();

/**
 * Checked for shape, not against any registry. A typo is worth catching; a
 * well-formed number that belongs to somebody else is what the human review
 * is for, and pretending otherwise would give the operator false confidence.
 */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const CIN = /^[LUu][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

export const companyProfileSchema = z.object({
  // The only required field, and it is the one students see.
  name: z.string().trim().min(2, 'Enter the company name.').max(200),

  legalName: blank(200),
  industryId: z.string().trim().optional().or(z.literal('')),
  /** Only when the list has nothing that fits; operations resolves it. */
  industryOther: z
    .string()
    .trim()
    .max(60, 'Keep it short.')
    .regex(/^[A-Za-z0-9 &.\-/]*$/, 'Letters, numbers, spaces and & . - / only.')
    .optional()
    .or(z.literal('')),
  sizeBand: z.nativeEnum(CompanySize).optional().or(z.literal('')),
  foundedYear: z.coerce
    .number()
    .int()
    .min(1800, 'That founding year looks wrong.')
    .max(new Date().getFullYear(), 'That founding year is in the future.')
    .optional(),

  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN, 'That does not look like a GSTIN.')
    .optional()
    .or(z.literal('')),
  cin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(CIN, 'That does not look like a CIN.')
    .optional()
    .or(z.literal('')),

  /**
   * The page's own words. Also writable through PUT /showcase/mine, which
   * predates this and is what the page editor used; both land in the same two
   * columns, so the company profile can be saved in one go.
   */
  whyJoin: blank(2000),
  howWeHire: blank(2000),
  /** The sentence beside the logo; `about` is the paragraph under it. */
  headline: blank(140),

  coverUrl: picture('Upload the cover, or give an https link to it.'),
  /** The office, the team, the work. Shown in the order they are sent. */
  photos: z.array(photoSchema).max(MAX_PHOTOS, `Six photographs is the most a page shows.`).optional(),

  website: url('Enter a valid website.'),
  careersUrl: url('Enter a valid careers page URL.'),
  linkedinUrl: url('Enter a valid LinkedIn URL.'),
  // A logo is a picture, not a link: it is almost always one we stored for
  // them, and `/api/files/logo-....png` is not a URL any `url()` would accept.
  logoUrl: picture('Upload the logo, or give an https link to it.'),
  about: blank(2000),

  city: blank(120),
  state: blank(120),
  address: blank(400),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'Enter a six-digit PIN code.')
    .optional()
    .or(z.literal('')),
});

export type CompanyProfileInput = z.infer<typeof companyProfileSchema>;

/**
 * What a company signing itself up must answer.
 *
 * Nobody is vouching for a stranger, so the details operations actually reads
 * during the review are asked for up front rather than chased afterwards. An
 * industry counts either way: one from the shared list, or one they typed
 * because nothing there fitted.
 */
export const companyRegistrationSchema = companyProfileSchema
  .extend({
    legalName: z.string().trim().min(2, 'Enter the registered name.').max(200),
    sizeBand: z.nativeEnum(CompanySize, { errorMap: () => ({ message: 'Choose a size.' }) }),
    foundedYear: z.coerce
      .number({ invalid_type_error: 'Enter the founding year.' })
      .int()
      .min(1800, 'That founding year looks wrong.')
      .max(new Date().getFullYear(), 'That founding year is in the future.'),
    gstin: z.string().trim().toUpperCase().regex(GSTIN, 'That does not look like a GSTIN.'),
    cin: z.string().trim().toUpperCase().regex(CIN, 'That does not look like a CIN.'),
    address: z.string().trim().min(5, 'Enter the head office address.').max(400),
  })
  .refine((d) => Boolean(d.industryId || d.industryOther), {
    message: 'Choose an industry, or tell us yours.',
    path: ['industryId'],
  });

const nil = (v: string | undefined) => (v ? v : null);

/** Empty strings from a form mean "not given", which in SQL is NULL. */
export function toCompanyData(d: Partial<CompanyProfileInput>) {
  return {
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.legalName !== undefined ? { legalName: nil(d.legalName) } : {}),
    ...(d.industryId !== undefined ? { industryId: nil(d.industryId) } : {}),
    ...(d.industryOther !== undefined ? { industryOther: nil(d.industryOther) } : {}),
    ...(d.sizeBand !== undefined ? { sizeBand: d.sizeBand ? d.sizeBand : null } : {}),
    ...(d.foundedYear !== undefined ? { foundedYear: d.foundedYear ?? null } : {}),
    ...(d.gstin !== undefined ? { gstin: nil(d.gstin) } : {}),
    ...(d.cin !== undefined ? { cin: nil(d.cin) } : {}),
    ...(d.website !== undefined ? { website: nil(d.website) } : {}),
    ...(d.careersUrl !== undefined ? { careersUrl: nil(d.careersUrl) } : {}),
    ...(d.linkedinUrl !== undefined ? { linkedinUrl: nil(d.linkedinUrl) } : {}),
    ...(d.logoUrl !== undefined ? { logoUrl: nil(d.logoUrl) } : {}),
    ...(d.headline !== undefined ? { headline: nil(d.headline) } : {}),
    ...(d.whyJoin !== undefined ? { whyJoin: nil(d.whyJoin) } : {}),
    ...(d.howWeHire !== undefined ? { howWeHire: nil(d.howWeHire) } : {}),
    ...(d.coverUrl !== undefined ? { coverUrl: nil(d.coverUrl) } : {}),
    // Captions are dropped when blank, so a photograph carries either words
    // worth reading or none at all.
    ...(d.photos !== undefined
      ? { photos: d.photos.map((p) => ({ url: p.url, ...(p.caption ? { caption: p.caption } : {}) })) }
      : {}),
    ...(d.about !== undefined ? { about: nil(d.about) } : {}),
    ...(d.city !== undefined ? { city: nil(d.city) } : {}),
    ...(d.state !== undefined ? { state: nil(d.state) } : {}),
    ...(d.address !== undefined ? { address: nil(d.address) } : {}),
    ...(d.pincode !== undefined ? { pincode: nil(d.pincode) } : {}),
  };
}

/** What every caller returns for a company, so the shape never diverges. */
export const COMPANY_PUBLIC_SELECT = {
  id: true,
  name: true,
  legalName: true,
  industryOther: true,
  coverUrl: true,
  photos: true,
  website: true,
  careersUrl: true,
  linkedinUrl: true,
  logoUrl: true,
  headline: true,
  about: true,
  sizeBand: true,
  foundedYear: true,
  gstin: true,
  cin: true,
  city: true,
  state: true,
  address: true,
  pincode: true,
  status: true,
  appliedAt: true,
  reviewedAt: true,
  rejectionReason: true,
  createdAt: true,
  industry: { select: { id: true, name: true } },
} as const;
