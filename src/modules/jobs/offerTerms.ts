/**
 * The fixed vocabularies behind the offer questions. Fixed because a
 * college compares these across companies, which only works if "PF" means
 * the same thing on every role.
 */

export const EMPLOYER_TYPES = ['DIRECT', 'SUBSIDIARY', 'THIRD_PARTY'] as const;

/** What a CTC figure may contain beyond salary. */
export const CTC_INCLUDES = [
  { key: 'PF', label: 'Employer PF contribution' },
  { key: 'GRATUITY', label: 'Gratuity' },
  { key: 'INSURANCE', label: 'Health insurance premium' },
  { key: 'RELOCATION', label: 'Relocation allowance' },
  { key: 'MEALS', label: 'Meal or food allowance' },
  { key: 'RETENTION', label: 'Retention or long-term bonus' },
] as const;

/** What an offer may be conditional on. */
export const OFFER_CONDITIONS = [
  { key: 'PASS_FINAL', label: 'Passing the final-year exams' },
  { key: 'NO_BACKLOGS', label: 'No backlogs by the joining date' },
  { key: 'MIN_MARKS', label: 'Keeping the minimum marks until graduation' },
  { key: 'BACKGROUND', label: 'Background verification' },
  { key: 'MEDICAL', label: 'Medical fitness test' },
  { key: 'DOCUMENTS', label: 'Original documents at joining' },
] as const;
