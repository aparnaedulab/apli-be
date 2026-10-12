/**
 * Gives demo tasks pages to read and quick checks - every kind of question,
 * the dragged ones included - so the task
 * workspace has something to show locally: `npx tsx src/scripts/demoTaskPages.ts`.
 *
 * Safe to run again; it only fills a task that has no pages. Made up.
 */
import { PrismaClient } from '@prisma/client';
import { pagesSchema } from '../modules/companyApp/pages.js';

const prisma = new PrismaClient();

const PAGES = pagesSchema.parse([
  {
    kind: 'read',
    title: 'What a manager reads first',
    body:
      'A regional manager opening the Monday page has about two minutes. They are looking for what changed, not for everything that happened.\n\n' +
      'Three kinds of number earn a place: the one that tells them whether the month was good (total sales against last month), the one that tells them where to look (the store or product that moved most), and the one that tells them what to do next (stock that will run out, or stock that will not move).\n\n' +
      'Everything else can sit in a table further down, for the day someone asks.',
  },
  {
    kind: 'check',
    title: 'Quick check',
    questions: [
      {
        kind: 'choice',
        prompt: 'Which number belongs at the very top of the page?',
        options: ['Every product sold, in a table', 'Total sales against last month', 'The number of rows you cleaned'],
        correct: [1],
        explain: 'It answers the first question a manager has: was the month good or not?',
      },
      {
        kind: 'sort',
        prompt: 'Sort each number by what it helps the manager do.',
        groups: ['Judge the month', 'Know where to look', 'Decide what to do'],
        items: [
          { text: 'Sales this month against last month', group: 0 },
          { text: 'The store whose sales fell most', group: 1 },
          { text: 'Items that will run out in a week', group: 2 },
          { text: 'The product that grew fastest', group: 1 },
        ],
        explain: 'Good, then where, then what next - the order a busy reader thinks in.',
      },
    ],
  },
]);

/** Reconcile a month of payments: one task each kind of question, including the dragged ones. */
const LEDGER_MATCH = pagesSchema.parse([
  {
    kind: 'read',
    title: 'What reconciling means',
    body:
      'Every month a business checks that the money its bank says moved matches the money its own books say moved. ' +
      'That check is a reconciliation.\n\n' +
      'You line each bank payment up with the invoice it pays. Most match exactly. The ones that do not are the interesting part: ' +
      'a payment for two invoices at once, a bank charge nobody recorded, a customer who paid a little short.\n\n' +
      'The goal is not a perfect sheet. It is a short list of differences, each with a likely reason, that the owner can act on.',
  },
  {
    kind: 'check',
    title: 'Before you start matching',
    questions: [
      {
        kind: 'choice',
        prompt: 'A customer paid ₹9,950 against an invoice for ₹10,000. What is the most likely reason to check first?',
        options: ['The invoice is wrong', 'A bank or payment charge was taken', 'The payment belongs to another customer', 'It is a refund'],
        correct: [1],
        explain: 'A small, round shortfall usually means a charge was deducted on the way.',
      },
      {
        kind: 'choice',
        prompt: 'Which of these would you expect to see on the bank statement but not on an invoice? Pick all that apply.',
        options: ['Monthly account fee', 'Customer payment', 'Interest earned', 'Supplier invoice number'],
        correct: [0, 2],
        explain: 'Fees and interest come from the bank itself, so no invoice exists for them.',
      },
      {
        kind: 'sort',
        prompt: 'Drag each line into what you would do with it.',
        groups: ['Matches an invoice', 'Needs a question', 'Bank-only entry'],
        items: [
          { text: 'Payment of ₹24,000 with invoice number INV-0412', group: 0 },
          { text: 'Payment of ₹15,500 with no reference at all', group: 1 },
          { text: 'Account maintenance fee ₹350', group: 2 },
          { text: 'Payment of ₹8,000 for invoices INV-0415 and INV-0416', group: 0 },
          { text: 'Two payments of ₹6,200 on the same day from one customer', group: 1 },
        ],
        explain: 'If you can name the invoice, it matches; if you cannot be sure, ask; if only the bank could have made it, it is bank-only.',
      },
    ],
  },
]);

const LEDGER_GAPS = pagesSchema.parse([
  {
    kind: 'check',
    title: 'Writing it up',
    questions: [
      {
        kind: 'order',
        prompt: 'Drag these into the order you would put them in a note to the owner.',
        items: [
          'One line: how many payments matched, and how many did not',
          'The differences, largest first',
          'For each, the likely reason',
          'What you need from the owner to close each one',
        ],
        explain: 'Lead with the overall picture, then what matters most, then what to do about it.',
      },
      {
        kind: 'choice',
        prompt: 'Which difference should the owner hear about first?',
        options: ['A ₹350 bank fee', 'A ₹15,500 payment with no reference', 'Two invoices paid in one payment'],
        correct: [1],
        explain: 'The largest unexplained amount carries the most risk, so it goes first.',
      },
    ],
  },
]);

/** A test of nothing but dragging: cards on the left, into groups or into order. */
const LEDGER_DRAG = pagesSchema.parse([
  {
    kind: 'check',
    title: 'Match it up',
    questions: [
      {
        kind: 'sort',
        prompt: 'Drag each difference to the reason it most likely has.',
        groups: ['Bank charge', 'Paid short', 'Paid twice', 'Not yet on the books'],
        items: [
          { text: '₹10,000 invoice, ₹9,950 received', group: 0 },
          { text: '₹12,000 invoice, ₹10,000 received with a note "rest next week"', group: 1 },
          { text: 'Two payments of ₹6,200 for the same invoice', group: 2 },
          { text: '₹4,500 received, no invoice raised yet', group: 3 },
          { text: 'Monthly SMS alert charge ₹45', group: 0 },
        ],
        explain: 'Small round amounts are usually charges; a note or a part payment means short; the same amount twice means a repeat.',
      },
      {
        kind: 'sort',
        prompt: 'Drag each item to the document you would find it on.',
        groups: ['Bank statement', 'Invoice'],
        items: [
          { text: 'Closing balance', group: 0 },
          { text: 'GST number of the seller', group: 1 },
          { text: 'Date the money arrived', group: 0 },
          { text: 'Due date for payment', group: 1 },
        ],
        explain: 'The bank records what moved and when; the invoice records what was asked for.',
      },
      {
        kind: 'order',
        prompt: 'Drag the steps of a month-end reconciliation into order.',
        items: [
          'Download the bank statement for the month',
          'Match each payment to its invoice',
          'List what did not match',
          'Find the likely reason for each',
          'Send the note to the owner',
        ],
        explain: 'Get the facts, match them, then explain what is left over.',
      },
    ],
  },
]);

/** Adds a page to a task unless one with that title is already there. */
async function add(slug: string, position: number, pages: typeof PAGES) {
  const task = await prisma.workSimulationTask.findFirst({
    where: { simulation: { slug }, position },
    select: { id: true, pages: true },
  });
  if (!task) return `${slug} #${position}: no such task`;
  const have = Array.isArray(task.pages) ? (task.pages as { title?: string }[]) : [];
  const fresh = pages.filter((p) => !have.some((h) => h.title === p.title));
  if (!fresh.length) return `${slug} #${position}: already there`;
  await prisma.workSimulationTask.update({ where: { id: task.id }, data: { pages: [...have, ...fresh] as object[] } });
  return `${slug} #${position}: ${fresh.map((p) => p.title).join(', ')} added`;
}

async function fill(slug: string, position: number, pages: typeof PAGES) {
  const task = await prisma.workSimulationTask.findFirst({
    where: { simulation: { slug }, position },
    select: { id: true, pages: true },
  });
  if (!task) return `${slug} #${position}: no such task`;
  if (Array.isArray(task.pages) && task.pages.length > 0) return `${slug} #${position}: already has pages`;
  await prisma.workSimulationTask.update({ where: { id: task.id }, data: { pages } });
  return `${slug} #${position}: pages added`;
}

async function main() {
  console.log(await fill('northwind-sales-dashboard', 2, PAGES));
  console.log(await fill('sample-ledger-works-reconcile-a-month-of-payments', 1, LEDGER_MATCH));
  console.log(await fill('sample-ledger-works-reconcile-a-month-of-payments', 2, LEDGER_GAPS));
  console.log(await add('sample-ledger-works-reconcile-a-month-of-payments', 1, LEDGER_DRAG));
}

main().finally(() => prisma.$disconnect());
