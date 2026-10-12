/**
 * Two demo simulations for Sample Ledger Works, for trying everything locally:
 * `npx tsx src/scripts/seedQuestionShowcase.ts`.
 *
 *   "Every kind of question"   live - every kind of question and every way of
 *                              handing in, to try as a student
 *   "Practice draft - edit me" a draft with gaps, to try the company's editor
 *                              and its Check & send
 *
 * Safe to run again: a simulation already there is left as it is. Made up.
 */
import { PrismaClient, WorkSimulationStatus } from '@prisma/client';
import { handInKindsSchema, pagesSchema } from '../modules/companyApp/pages.js';

const prisma = new PrismaClient();

const COMPANY = 'Sample Ledger Works';

const SHOWCASE = {
  slug: 'sample-ledger-works-every-kind-of-question',
  title: 'Every kind of question',
  summary:
    'A short tour of a month-end at a small accounting firm, built to show every kind of question and every way of handing work in.',
  about:
    'Each task uses different kinds of question, so you can try them all: pick one, pick several, drag into groups, drag into order, and a written answer.\n\nEach task is also handed in a different way - written, as a link, as a file, or any of them - so you can see how each works.',
  field: 'Finance',
  level: 'BEGINNER' as const,
  hours: 2,
  skills: ['Reconciliation', 'Attention to detail', 'Clear writing'],
  tasks: [
    {
      title: 'Spot the problems',
      brief:
        'A client has sent last month\'s bank statement and their own list of payments. Before matching anything, spot what looks wrong.\n\nAnswer the test, then write two lines on the biggest problem you noticed.',
      learn: ['Reading a bank statement', 'Telling a fee from a payment'],
      steps: ['Answer the test', 'Write two lines on the biggest problem'],
      handIn: 'Two or three sentences on the biggest problem you spotted.',
      handInKinds: ['text'],
      minutes: 20,
      pages: [
        {
          kind: 'check',
          title: 'Pick the right answers',
          questions: [
            {
              kind: 'choice',
              multiple: false,
              prompt: 'The bank shows ₹9,950 received against a ₹10,000 invoice. What is the most likely reason?',
              options: ['The customer made a mistake', 'A ₹50 payment charge was taken', 'The invoice was never sent', 'It is a refund'],
              correct: [1],
              explain: 'A small, round shortfall is usually a charge taken on the way.',
            },
            {
              kind: 'choice',
              multiple: true,
              prompt: 'Which of these appear on a bank statement but never on an invoice? Pick all that apply.',
              options: ['Account maintenance fee', 'Customer payment', 'Interest earned', 'GST number of the seller'],
              correct: [0, 2],
              explain: 'Fees and interest come from the bank itself, so no invoice exists for them.',
            },
          ],
        },
      ],
    },
    {
      title: 'Sort and sequence',
      brief:
        'Now sort the month\'s lines into what you would do with them, and put the month-end steps in order.\n\nAnswer the test, then share a link to a sheet or doc with your sorted list.',
      learn: ['Grouping differences by cause', 'The order of a month-end close'],
      steps: ['Answer the test', 'Put your sorted list in a sheet or doc', 'Share a link anyone can open'],
      handIn: 'A link to a sheet or doc with your sorted list.',
      handInKinds: ['link'],
      minutes: 25,
      pages: [
        {
          kind: 'check',
          title: 'Drag them into place',
          questions: [
            {
              kind: 'sort',
              prompt: 'Drag each line into what you would do with it.',
              groups: ['Matches an invoice', 'Needs a question', 'Bank-only entry'],
              items: [
                { text: '₹24,000 received with invoice number INV-0412', group: 0 },
                { text: '₹15,500 received with no reference', group: 1 },
                { text: 'Account maintenance fee ₹350', group: 2 },
                { text: 'Two payments of ₹6,200 on the same day', group: 1 },
                { text: '₹8,000 for invoices INV-0415 and INV-0416', group: 0 },
              ],
              explain: 'Name the invoice and it matches; unsure, ask; only the bank could make it, it is bank-only.',
            },
            {
              kind: 'order',
              prompt: 'Drag the month-end steps into order.',
              items: [
                'Download the bank statement',
                'Match payments to invoices',
                'List what did not match',
                'Find the reason for each',
                'Send the note to the owner',
              ],
              explain: 'Get the facts, match them, then explain what is left.',
            },
          ],
        },
      ],
    },
    {
      title: 'Explain your thinking',
      brief:
        'The owner wants to understand one difference properly. Answer the test - including a short written answer - then upload your note as a PDF or a picture.',
      learn: ['Explaining a number to someone outside finance'],
      steps: ['Answer the test', 'Write a short note to the owner', 'Save it as a PDF, or take a picture of it', 'Upload it'],
      handIn: 'Your note to the owner, as a PDF or a picture.',
      handInKinds: ['file'],
      minutes: 30,
      pages: [
        {
          kind: 'check',
          title: 'Say it in your words',
          questions: [
            {
              kind: 'text',
              prompt: 'In two or three sentences, what would you do about the ₹15,500 payment with no reference?',
              hint: 'Say who you would ask, and what you would ask them.',
              minWords: 15,
              explain: 'Ask the bank for the payer’s details, then the likely customer, before matching it.',
            },
            {
              kind: 'choice',
              multiple: false,
              prompt: 'Who should hear about that payment first?',
              options: ['The bank', 'The owner', 'The tax office'],
              correct: [0],
              explain: 'Only the bank can say who sent it.',
            },
          ],
        },
      ],
    },
    {
      title: 'Put it all together',
      brief:
        'Read the short page on what a good month-end note looks like, take the final test - every kind of question in one - then hand in your note any way you like.',
      learn: ['What makes a month-end note useful'],
      steps: ['Read the page', 'Take the final test', 'Hand in your note: written, as a link, or as a file'],
      handIn: 'Your month-end note to the owner, any way you like.',
      handInKinds: ['text', 'link', 'file'],
      minutes: 35,
      pages: [
        {
          kind: 'read',
          title: 'What a good month-end note looks like',
          body:
            'Start with one line: how many payments matched, and how many did not.\n\nThen list the differences, largest first, each with its likely reason. End with what you need from the owner to close each one.\n\nKeep it to a page. The owner should be able to act on it without calling you.',
        },
        {
          kind: 'check',
          title: 'The final test',
          questions: [
            {
              kind: 'choice',
              multiple: false,
              prompt: 'What goes in the first line of the note?',
              options: ['A thank-you', 'How many matched and how many did not', 'The bank’s address'],
              correct: [1],
            },
            {
              kind: 'choice',
              multiple: true,
              prompt: 'Which belong in the note? Pick all that apply.',
              options: ['The differences, largest first', 'Every matched payment', 'What you need from the owner', 'Your login details'],
              correct: [0, 2],
            },
            {
              kind: 'sort',
              prompt: 'Drag each sentence into the part of the note it belongs in.',
              groups: ['Opening line', 'Differences', 'What we need'],
              items: [
                { text: '42 of 45 payments matched.', group: 0 },
                { text: '₹15,500 received with no reference.', group: 1 },
                { text: 'Please confirm who sent the ₹15,500.', group: 2 },
              ],
            },
            {
              kind: 'order',
              prompt: 'Drag the parts of the note into order.',
              items: ['The opening line', 'The differences', 'The likely reasons', 'What we need from you'],
            },
            {
              kind: 'text',
              prompt: 'Write the opening line of your note.',
              hint: 'One sentence.',
              minWords: 5,
              explain: 'Something like: "42 of 45 payments matched; the three that did not are below."',
            },
          ],
        },
      ],
    },
  ],
};

const DRAFT = {
  slug: 'sample-ledger-works-practice-draft-edit-me',
  title: 'Practice draft - edit me',
  summary: 'A half-written draft to try the editor with: fill the gaps, add questions of each kind, and press Check & send.',
  about: null,
  field: 'Finance',
  level: 'BEGINNER' as const,
  hours: 2,
  skills: ['Spreadsheets'],
  tasks: [
    {
      title: 'Read the invoices',
      brief: 'You have a month of sample invoices. Find the three largest customers and what they owe.',
      learn: ['Reading an invoice'],
      steps: ['Sort the invoices by amount', 'Note the three largest customers'],
      handIn: 'A short list of the three customers and what each owes.',
      handInKinds: ['text', 'file'],
      minutes: 30,
      pages: [
        {
          kind: 'check',
          title: 'Quick check',
          questions: [
            {
              kind: 'choice',
              multiple: false,
              prompt: 'Where on an invoice is the amount due usually shown?',
              options: ['At the top', 'At the bottom, as the total', 'On the back'],
              correct: [1],
            },
          ],
        },
      ],
    },
    {
      // Left short on purpose, so Check & send has something to flag.
      title: 'Chase',
      brief: 'Write to them.',
      learn: [],
      steps: [],
      handIn: '',
      handInKinds: ['text'],
      minutes: 20,
      pages: [],
    },
  ],
};

async function make(def: typeof SHOWCASE | typeof DRAFT, status: WorkSimulationStatus, companyId: string) {
  if (await prisma.workSimulation.findUnique({ where: { slug: def.slug } })) return `${def.title}: already there`;
  await prisma.workSimulation.create({
    data: {
      slug: def.slug,
      companyId,
      title: def.title,
      summary: def.summary,
      about: def.about,
      field: def.field,
      level: def.level,
      hours: def.hours,
      skills: def.skills,
      status,
      publishedAt: status === WorkSimulationStatus.LIVE ? new Date() : null,
      tasks: {
        create: def.tasks.map((t, i) => ({
          position: i + 1,
          title: t.title,
          brief: t.brief,
          learn: t.learn,
          steps: t.steps,
          handIn: t.handIn || null,
          handInKinds: handInKindsSchema.parse(t.handInKinds),
          // The draft's short task is stored as it is; the live one is checked like any company's.
          pages: pagesSchema.parse(t.pages) as object[],
          minutes: t.minutes,
        })),
      },
    },
  });
  return `${def.title}: added (${status.toLowerCase()})`;
}

async function main() {
  const company = await prisma.company.findFirst({ where: { name: COMPANY }, select: { id: true } });
  if (!company) {
    console.log(`No company called ${COMPANY}. Sign it up first.`);
    return;
  }
  console.log(await make(SHOWCASE, WorkSimulationStatus.LIVE, company.id));
  console.log(await make(DRAFT, WorkSimulationStatus.DRAFT, company.id));
}

main().finally(() => prisma.$disconnect());
