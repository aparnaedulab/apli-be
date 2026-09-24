import { describe, expect, it } from 'vitest';
import { estimateInHand, incomeTaxNewRegime } from '../src/modules/trust/inHand.js';
import { jobText, scanForFeeDemand } from '../src/modules/trust/scam.js';

/**
 * The two trust checks that are pure functions: the take-home estimate and
 * the fee-demand scanner. Worked by hand against the FY 2025-26 new regime.
 */
describe('monthly take-home', () => {
  it('charges no tax up to ₹12 lakh of taxable income (₹12.75 lakh salary)', () => {
    expect(incomeTaxNewRegime(600_000).tax).toBe(0);
    expect(incomeTaxNewRegime(1_275_000)).toEqual({ taxable: 1_200_000, tax: 0 });
  });

  it('applies marginal relief just above the rebate line', () => {
    // Taxable 12.25 L: slab tax 63,750, capped at the 25,000 over the line, plus 4% cess.
    expect(incomeTaxNewRegime(1_300_000)).toEqual({ taxable: 1_225_000, tax: 26_000 });
  });

  it('uses the slabs once marginal relief no longer helps', () => {
    // Taxable 19.25 L: 20k + 40k + 60k + 65k = 185,000, plus cess.
    expect(incomeTaxNewRegime(2_000_000).tax).toBe(192_400);
    // Taxable 29.25 L: 20k + 40k + 60k + 80k + 100k + 157.5k = 457,500, plus cess.
    expect(incomeTaxNewRegime(3_000_000).tax).toBe(475_800);
  });

  it('takes PF on a capped basic and professional tax, and rounds the headline', () => {
    const e = estimateInHand(600_000)!;
    // Basic 25,000 a month is capped at 15,000 for PF: 1,800 a month.
    expect(e.breakdown.epfMonthly).toBe(1800);
    expect(e.yearly.professionalTax).toBe(2500);
    // (6,00,000 - 21,600 - 2,500) / 12
    expect(e.monthlyExact).toBeCloseTo(47_991.67, 2);
    expect(e.monthly).toBe(48_000);
  });

  it('takes PF on the real basic when it is below the cap', () => {
    // 3 L a year: basic 12,500 a month, PF 1,500.
    expect(estimateInHand(300_000)!.breakdown.epfMonthly).toBe(1500);
  });

  it('says what it assumed, and refuses to guess from nothing', () => {
    expect(estimateInHand(1_000_000)!.assumptions.length).toBeGreaterThanOrEqual(4);
    expect(estimateInHand(0)).toBeNull();
    expect(estimateInHand(Number.NaN)).toBeNull();
  });
});

describe('fee-demand scanner', () => {
  const flags = (text: string) => scanForFeeDemand(text).length > 0;

  it.each([
    'A one-time registration fee of ₹1,500 is payable before joining.',
    'Selected candidates must pay a refundable security deposit.',
    'Pay ₹2,999 to receive your offer letter.',
    'Training charges of Rs. 5000 apply for the certification programme.',
    'Candidates are required to deposit the kit amount on day one.',
    'The offer letter will be released upon payment of the processing fee.',
    'You will need to transfer INR 999 for verification.',
  ])('flags: %s', (text) => {
    expect(flags(text)).toBe(true);
  });

  it.each([
    'Stipend of ₹15,000 per month.',
    'We pay ₹20,000 a month during the internship.',
    'The company will pay a joining bonus of ₹50,000.',
    'There is no registration fee and we never charge any deposit.',
    'We do not charge candidates any training fee.',
    'Please carry a copy of your offer letter on joining day.',
    'Registration closes on Friday.',
  ])('leaves alone: %s', (text) => {
    expect(flags(text)).toBe(false);
  });

  it('points at the words and gives a little context', () => {
    const [hit] = scanForFeeDemand('Great role. A registration fee of ₹500 applies. Apply now.');
    expect(hit!.phrase.toLowerCase()).toBe('registration fee');
    expect(hit!.snippet).toContain('registration fee of ₹500');
    expect(hit!.kind).toBe('fee');
  });

  it('reads every part of a role, conditions included', () => {
    const text = jobText({
      title: 'Intern',
      description: 'Good role.',
      terms: [{ text: 'A security deposit of ₹5,000 is collected at joining.' }],
    });
    expect(flags(text)).toBe(true);
  });
});
