/**
 * Who a role is open to beyond marks: disability, gender, and the working
 * conditions a student should know before applying.
 *
 * Kept as fixed lists rather than open ones. The disability groups follow
 * the Rights of Persons with Disabilities Act, 2016 - its 21 specified
 * disabilities, grouped the way employers identify suitable posts - and a
 * list somebody could add to would stop meaning the same thing on every role.
 */

export const PWD_CATEGORIES = [
  { key: 'VISUAL', label: 'Blindness and low vision' },
  { key: 'HEARING', label: 'Deaf and hard of hearing' },
  {
    key: 'LOCOMOTOR',
    label: 'Locomotor disability',
    hint: 'Including cerebral palsy, dwarfism, muscular dystrophy, leprosy cured and acid attack survivors',
  },
  { key: 'SPEECH', label: 'Speech and language disability' },
  { key: 'AUTISM', label: 'Autism spectrum disorder' },
  { key: 'INTELLECTUAL', label: 'Intellectual disability' },
  { key: 'LEARNING', label: 'Specific learning disabilities', hint: 'Such as dyslexia or dyscalculia' },
  { key: 'MENTAL', label: 'Mental illness' },
  { key: 'NEUROLOGICAL', label: 'Chronic neurological conditions', hint: 'Such as multiple sclerosis or Parkinson’s' },
  { key: 'BLOOD', label: 'Blood disorders', hint: 'Haemophilia, thalassaemia, sickle cell disease' },
  { key: 'MULTIPLE', label: 'Multiple disabilities', hint: 'Including deaf-blindness' },
] as const;

export const ACCOMMODATIONS = [
  { key: 'WHEELCHAIR', label: 'Wheelchair-accessible office and restrooms' },
  { key: 'SCREEN_READER', label: 'Screen-reader-friendly tools and documents' },
  { key: 'SIGN_LANGUAGE', label: 'Sign-language interpreter for interviews' },
  { key: 'EXTRA_TIME', label: 'Extra time in tests' },
  { key: 'ASSISTIVE_TECH', label: 'Assistive technology provided' },
  { key: 'FLEXIBLE_HOURS', label: 'Flexible working hours' },
  { key: 'REMOTE_OPTION', label: 'Work from home where needed' },
  { key: 'TRANSPORT', label: 'Accessible transport to the office' },
] as const;

export const GENDER_ELIGIBILITY = ['ANY', 'WOMEN_PREFERRED', 'WOMEN', 'MEN'] as const;
export type GenderEligibility = (typeof GENDER_ELIGIBILITY)[number];

export const SHIFTS = ['DAY', 'ROTATIONAL', 'NIGHT', 'FLEXIBLE'] as const;
export const TRAVEL = ['NONE', 'OCCASIONAL', 'FREQUENT'] as const;

/**
 * What a restricted role matches on a student's recorded gender.
 *
 * Colleges record gender from a list operations keeps (Female, Male, Other,
 * Prefer not to say), and older rows were typed. The database compares
 * case-insensitively, so these cover both. A student with nothing recorded
 * fails a restriction, the same as a missing mark fails a bar.
 */
export const GENDER_VALUES: Record<'WOMEN' | 'MEN', string[]> = {
  WOMEN: ['Female', 'Woman', 'F'],
  MEN: ['Male', 'Man', 'M'],
};

export const isRestricted = (g: string | null | undefined): g is 'WOMEN' | 'MEN' => g === 'WOMEN' || g === 'MEN';

/** Keeps only keys that are on the list, in the list's order. */
export function cleanKeys(values: unknown, list: readonly { key: string }[]): string[] {
  const given = new Set(Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : []);
  return list.map((i) => i.key).filter((k) => given.has(k));
}
