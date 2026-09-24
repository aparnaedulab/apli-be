/**
 * What a salary is actually worth each month.
 *
 * "12 LPA" on a poster is not what lands in a bank account. The honest offer
 * card shows an estimate of monthly take-home pay beside the headline, so a
 * student comparing two offers compares money they would actually have.
 *
 * It is an estimate, and says so: the rules below are the common case for a
 * salaried fresher, and every assumption is returned as a sentence the card
 * shows under "how we worked this out". Only the fixed pay is counted -
 * variable pay may never arrive, and a joining bonus arrives once - so both
 * are shown beside the figure, never inside it.
 *
 * Tax is the new regime for FY 2025-26, the default a fresher is on.
 */

/** Deducted from salary before tax, under the new regime. */
const STANDARD_DEDUCTION = 75_000;

/** The FY 2025-26 new-regime slabs: [upper bound of the slab, rate]. */
const SLABS: [number, number][] = [
  [400_000, 0],
  [800_000, 0.05],
  [1_200_000, 0.1],
  [1_600_000, 0.15],
  [2_000_000, 0.2],
  [2_400_000, 0.25],
  [Infinity, 0.3],
];

/** Below this taxable income, section 87A takes the whole tax back. */
const REBATE_LIMIT = 1_200_000;
const CESS = 0.04;

/** Employee PF: 12% of basic, on a basic capped at the statutory wage ceiling. */
const EPF_RATE = 0.12;
const EPF_WAGE_CEILING_MONTHLY = 15_000;
/** Freshers' offers rarely state the basic; half of fixed is the usual split. */
const BASIC_SHARE = 0.5;

/** Maharashtra: ₹200 a month, ₹300 in February. */
const PROFESSIONAL_TAX_YEARLY = 2_500;

export interface InHandEstimate {
  /** The annual fixed pay the estimate starts from. */
  fixedYearly: number;
  /** The headline: rounded to the nearest ₹100, because the rest is noise. */
  monthly: number;
  /** Unrounded, for anyone checking the arithmetic. */
  monthlyExact: number;
  breakdown: {
    grossMonthly: number;
    incomeTaxMonthly: number;
    epfMonthly: number;
    professionalTaxMonthly: number;
  };
  yearly: {
    taxableIncome: number;
    incomeTax: number;
    epf: number;
    professionalTax: number;
  };
  assumptions: string[];
}

/** Tax on a taxable income from the slabs, before rebate and cess. */
function slabTax(taxable: number): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of SLABS) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

/**
 * Income tax for a year's salary under the new regime, cess included.
 *
 * Up to ₹12 lakh of taxable income the 87A rebate cancels the tax outright.
 * Just above it, marginal relief caps the tax at the amount by which income
 * crosses ₹12 lakh - otherwise earning ₹1 more would cost ₹60,000.
 */
export function incomeTaxNewRegime(grossYearly: number): { taxable: number; tax: number } {
  const taxable = Math.max(0, grossYearly - STANDARD_DEDUCTION);
  let tax = slabTax(taxable);
  if (taxable <= REBATE_LIMIT) tax = 0;
  else tax = Math.min(tax, taxable - REBATE_LIMIT);
  return { taxable, tax: Math.round(tax * (1 + CESS)) };
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function estimateInHand(fixedYearly: number): InHandEstimate | null {
  if (!Number.isFinite(fixedYearly) || fixedYearly <= 0) return null;

  const { taxable, tax } = incomeTaxNewRegime(fixedYearly);
  const basicMonthly = (fixedYearly / 12) * BASIC_SHARE;
  const epfMonthly = Math.min(basicMonthly, EPF_WAGE_CEILING_MONTHLY) * EPF_RATE;
  const epfYearly = epfMonthly * 12;

  const netYearly = fixedYearly - tax - epfYearly - PROFESSIONAL_TAX_YEARLY;
  const monthlyExact = netYearly / 12;

  return {
    fixedYearly,
    monthly: Math.round(monthlyExact / 100) * 100,
    monthlyExact: Math.round(monthlyExact * 100) / 100,
    breakdown: {
      grossMonthly: Math.round((fixedYearly / 12) * 100) / 100,
      incomeTaxMonthly: Math.round((tax / 12) * 100) / 100,
      epfMonthly: Math.round(epfMonthly * 100) / 100,
      professionalTaxMonthly: Math.round((PROFESSIONAL_TAX_YEARLY / 12) * 100) / 100,
    },
    yearly: {
      taxableIncome: taxable,
      incomeTax: tax,
      epf: Math.round(epfYearly),
      professionalTax: PROFESSIONAL_TAX_YEARLY,
    },
    assumptions: [
      `Starts from the fixed pay only (${rupees(fixedYearly)} a year). Variable pay and any joining bonus are shown separately, because they are not guaranteed every month.`,
      `Income tax under the new regime for FY 2025-26, after the ${rupees(STANDARD_DEDUCTION)} standard deduction. Up to ${rupees(REBATE_LIMIT)} of taxable income there is no tax at all. 4% cess included.`,
      `Your provident fund (PF): 12% of basic pay, taking basic as half the fixed pay, on at most ${rupees(EPF_WAGE_CEILING_MONTHLY)} of basic a month. This is your money, saved for you - not lost.`,
      `Professional tax of ${rupees(PROFESSIONAL_TAX_YEARLY)} a year, as charged in Maharashtra.`,
      'If the company counts its own PF share inside your CTC, your take-home is lower, by up to ₹1,800 a month. Ask them.',
    ],
  };
}
