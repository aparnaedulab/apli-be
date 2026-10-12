/**
 * Gives every task in the demo work simulations a test with all five kinds
 * of question - written, pick one, pick several, drag into order, drag into
 * groups - written to fit the task: `npx tsx src/scripts/seedEveryTaskTests.ts`.
 *
 * A task that already has every kind across its tests is left alone, and so
 * is one that already has this test. Made up.
 */
import { PrismaClient } from '@prisma/client';
import { pagesSchema, readPages } from '../modules/companyApp/pages.js';

const prisma = new PrismaClient();

const TITLE = 'Check your understanding';

/* -- the five kinds, short to write ------------------------------------------ */
const text = (prompt: string, hint: string, minWords: number, explain: string) => ({ kind: 'text' as const, prompt, hint, minWords, explain });
const one = (prompt: string, options: string[], right: number, explain: string) => ({
  kind: 'choice' as const,
  multiple: false,
  prompt,
  options,
  correct: [right],
  explain,
});
const many = (prompt: string, options: string[], right: number[], explain: string) => ({
  kind: 'choice' as const,
  multiple: true,
  prompt,
  options,
  correct: right,
  explain,
});
const order = (prompt: string, items: string[], explain: string) => ({ kind: 'order' as const, prompt, items, explain });
const sort = (prompt: string, groups: string[], items: [string, number][], explain: string) => ({
  kind: 'sort' as const,
  prompt,
  groups,
  items: items.map(([t, group]) => ({ text: t, group })),
  explain,
});

type Q = ReturnType<typeof text> | ReturnType<typeof one> | ReturnType<typeof order> | ReturnType<typeof sort>;

/** By simulation, then task position: the five questions for that task. */
const TESTS: Record<string, Record<number, Q[]>> = {
  'northwind-sales-dashboard': {
    1: [
      text('Name one problem you would look for first in a raw sales sheet, and why.', 'One or two sentences.', 10, 'Duplicates and dates stored as text are the usual first culprits.'),
      one('An order appears twice with the same number and amount. What do you do?', ['Keep both', 'Remove one and note it', 'Delete both'], 1, 'Remove the repeat, and record that you did.'),
      many('Which of these are signs a row cannot be trusted? Pick all that apply.', ['A negative quantity', 'A date in the future', 'A round amount', 'A store code that does not exist'], [0, 1, 3], 'Round amounts are normal; the others point to an error.'),
      order('Drag the cleaning steps into a sensible order.', ['Make a copy of the raw sheet', 'Fix the dates', 'Remove duplicates', 'Check store totals', 'Note what you changed'], 'Never clean the only copy; check totals after fixing rows.'),
      sort('Drag each problem to what you would do about it.', ['Fix it', 'Flag it'], [['Date typed as "3rd March"', 0], ['Store total off by ₹12,000 with no reason', 1], ['Same order twice', 0], ['A store missing for one week', 1]], 'Fix what has one right answer; flag what needs someone to explain.'),
    ],
    2: [
      text('Which single number would you put at the top of the manager\'s page, and why?', 'One or two sentences.', 10, 'Usually total sales against last month - it answers "was it a good month?".'),
      one('A manager has two minutes. What do they need most?', ['Every product\'s sales', 'What changed and where', 'How the data was cleaned'], 1, 'What changed, and where to look.'),
      many('Which numbers help a manager decide what to do next? Pick all that apply.', ['Stock that will run out', 'Rows you cleaned', 'Products not selling', 'Your working hours'], [0, 2], 'Both point to an action: reorder, or stop ordering.'),
      order('Drag these into the order a busy reader thinks.', ['Was the month good?', 'Where should I look?', 'What should I do?'], 'Good, then where, then what next.'),
      sort('Drag each number to what it helps the manager do.', ['Judge the month', 'Know where to look', 'Decide what to do'], [['Sales vs last month', 0], ['Store that fell most', 1], ['Items running out', 2], ['Fastest-growing product', 1]], 'Each number earns its place by the question it answers.'),
    ],
    3: [
      text('Write the two-line summary you would put on the dashboard.', 'Lead with what changed.', 15, 'Something like: "Sales up 6% on last month, led by Pune; two stores need stock of item X."'),
      one('Which chart shows a change over the month best?', ['A pie chart', 'A line chart by week', 'A table of every order'], 1, 'Lines show change over time.'),
      many('What belongs on a one-page dashboard? Pick all that apply.', ['Your three numbers', 'A chart of the change', 'Every row of data', 'A two-line summary'], [0, 1, 3], 'The full data can live behind it, not on it.'),
      order('Drag the parts of the page from top to bottom.', ['The three numbers', 'The chart', 'The two-line summary', 'Where the data came from'], 'Most important first; sources last.'),
      sort('Drag each item to where it goes.', ['On the page', 'Left off'], [['Sales vs last month', 0], ['Your cleaning notes', 1], ['A chart of weekly sales', 0], ['Every store\'s raw rows', 1]], 'Only what helps someone act in two minutes.'),
    ],
  },
  'harbour-loan-check': {
    1: [
      text('Why does a lender care about cash, not just profit?', 'Two or three sentences.', 15, 'Loans are repaid in cash; a profitable business can still run out of it.'),
      one('Where do you find how much cash the bakery has?', ['The profit and loss account', 'The balance sheet', 'The invoice book'], 1, 'Cash is an asset, on the balance sheet.'),
      many('Which are costs on a bakery\'s profit and loss? Pick all that apply.', ['Flour', 'Rent', 'The loan it wants', 'Wages'], [0, 1, 3], 'The loan it wants is not a cost yet.'),
      order('Drag these into the order you would read the accounts.', ['Revenue', 'Costs', 'Profit', 'Cash in the bank'], 'Top of the P&L down, then the balance sheet.'),
      sort('Drag each line to the statement it comes from.', ['Profit and loss', 'Balance sheet'], [['Sales', 0], ['Cash', 1], ['Rent paid', 0], ['Money owed to suppliers', 1]], 'Flows over the year vs what is held at the end.'),
    ],
    2: [
      text('In plain words, what does a high debt ratio tell you?', 'One or two sentences.', 10, 'The business already owes a lot compared with what it has.'),
      one('Margin went from 12% to 8%. What happened?', ['Each sale earns less', 'Sales fell', 'Cash rose'], 0, 'Margin is profit per rupee of sales.'),
      many('Which suggest the bakery can repay? Pick all that apply.', ['Steady cash each month', 'Rising margins', 'Falling sales', 'Low existing debt'], [0, 1, 3], 'Falling sales is a warning, not a comfort.'),
      order('Drag the steps of working out a ratio into order.', ['Find the two numbers', 'Divide one by the other', 'Compare with last year', 'Say what it means'], 'A ratio means little until compared.'),
      sort('Drag each ratio to what it tells you.', ['Can it pay?', 'Is it profitable?'], [['Cash cover', 0], ['Gross margin', 1], ['Debt ratio', 0], ['Net margin', 1]], 'Repayment vs profitability.'),
    ],
    3: [
      text('Write the first line of your recommendation.', 'Say lend, lend with conditions, or decline.', 8, 'Lead with the decision, then the reasons.'),
      one('Cash is thin but improving. What fits best?', ['Lend as asked', 'Lend with conditions', 'Decline'], 1, 'Conditions manage the risk while it improves.'),
      many('Which make good loan conditions? Pick all that apply.', ['Monthly accounts sent to us', 'A smaller first amount', 'A free cake', 'A personal guarantee'], [0, 1, 3], 'Each one lowers the lender\'s risk.'),
      order('Drag the parts of the note into order.', ['The decision', 'The reasons', 'The conditions', 'What would change our mind'], 'Decision first, then why.'),
      sort('Drag each point to where it belongs in the note.', ['Reason', 'Condition'], [['Cash covers repayments 1.4 times', 0], ['Send monthly accounts', 1], ['Margins rose for two years', 0], ['Start with ₹3 lakh', 1]], 'Reasons explain; conditions protect.'),
    ],
  },
  'greycell-market-entry': {
    1: [
      text('What do you need to know before estimating a market? Name two things.', 'A sentence or two.', 10, 'Who buys, how often, and how much they spend.'),
      one('"Is this city worth it?" is first broken into...', ['Smaller questions you can answer', 'A single guess', 'A slide'], 0, 'Structure before numbers.'),
      many('Which help size a coffee market? Pick all that apply.', ['Number of office workers', 'Cups per week per drinker', 'The colour of the logo', 'Average price per cup'], [0, 1, 3], 'People × habit × price.'),
      order('Drag the steps into order.', ['Restate the question', 'Break it into parts', 'Find numbers for each part', 'Put them together'], 'Clear question, then parts, then numbers.'),
      sort('Drag each item to what it is.', ['Question', 'Data'], [['How many people drink coffee?', 0], ['Census: 12 lakh adults', 1], ['How often do they buy?', 0], ['Survey: 3 cups a week', 1]], 'Questions to answer, and the data that answers them.'),
    ],
    2: [
      text('Your two estimates differ a lot. What do you do?', 'Two or three sentences.', 15, 'Find which assumption drives the gap, test it, and say how sure you are.'),
      one('Top-down starts from...', ['The whole population', 'One café\'s sales', 'A competitor\'s price'], 0, 'Bottom-up is the one that starts small.'),
      many('Which make an estimate more trustworthy? Pick all that apply.', ['Stating assumptions', 'Two methods that roughly agree', 'Many decimal places', 'A range, not one number'], [0, 1, 3], 'Precision is not accuracy.'),
      order('Drag a top-down estimate into order.', ['Adults in the city', 'Share who drink coffee', 'Cups per year each', 'Price per cup'], 'Narrow down, then multiply by price.'),
      sort('Drag each method to its starting point.', ['Top-down', 'Bottom-up'], [['City population', 0], ['One café\'s daily cups', 1], ['National spend per head', 0], ['Footfall at one street', 1]], 'Big to small, or small to big.'),
    ],
    3: [
      text('Write the headline of your first slide.', 'One sentence that answers the question.', 6, 'e.g. "Yes - a ₹40 crore market with room for two cafés in year one."'),
      one('What goes on slide one?', ['Your method', 'Your answer', 'Thank you'], 1, 'Answer first; the client can ask why.'),
      many('Which make a client slide clearer? Pick all that apply.', ['A headline that says the point', 'One chart', 'Every calculation', 'Plain words'], [0, 1, 3], 'Workings go in the back.'),
      order('Drag the three slides into order.', ['The answer', 'Why we think so', 'What to do next'], 'Answer, reasons, next step.'),
      sort('Drag each item to where it goes.', ['On the slides', 'In the back-up'], [['The headline answer', 0], ['Full spreadsheet', 1], ['One market-size chart', 0], ['Survey method details', 1]], 'Slides persuade; back-up proves.'),
    ],
  },
  'zenith-fix-the-bug': {
    1: [
      text('Write the first step of your reproduction.', 'Be exact: what you open and click.', 8, 'e.g. "Open the shop, add one item, press Pay twice quickly."'),
      one('Why reproduce a bug before fixing it?', ['To prove the fix works', 'It looks busy', 'It is required by law'], 0, 'If you cannot make it happen, you cannot show it stopped.'),
      many('What should a reproduction note include? Pick all that apply.', ['Exact steps', 'What you expected', 'What happened instead', 'Who to blame'], [0, 1, 2], 'Facts, not fault.'),
      order('Drag these into order.', ['Read the customer report', 'Try the same steps', 'Note what happens', 'Write the steps down'], 'Report, try, observe, record.'),
      sort('Drag each item to what it is.', ['Fact', 'Guess'], [['Order shows twice after a double click', 0], ['The database is broken', 1], ['It happens on slow networks', 0], ['Someone changed the code', 1]], 'Write facts first; guesses come later.'),
    ],
    2: [
      text('Explain the cause in one sentence, as you would to a teammate.', 'Plain words.', 10, 'e.g. "The Pay button sends the order again if pressed before the first reply."'),
      one('The order is saved twice when Pay is pressed twice. Most likely cause?', ['No check for a repeat request', 'The price is wrong', 'The font is too small'], 0, 'Nothing stops the second request.'),
      many('Which help find a cause? Pick all that apply.', ['Reading the logs', 'Adding a breakpoint', 'Changing code at random', 'Reproducing with one change at a time'], [0, 1, 3], 'Change one thing at a time.'),
      order('Drag the steps of finding a cause into order.', ['Reproduce it', 'Narrow down where', 'Read that code', 'Explain why it fails'], 'Narrow before you read.'),
      sort('Drag each finding to what it is.', ['Cause', 'Symptom'], [['Two orders appear', 1], ['No repeat check on Pay', 0], ['Customer charged twice', 1], ['Button not disabled while waiting', 0]], 'Fix causes; symptoms follow.'),
    ],
    3: [
      text('Describe the test that proves your fix works.', 'What it does, and what it checks.', 12, 'e.g. "Send the same order twice; check only one is saved."'),
      one('A good test for this fix should...', ['Fail without the fix and pass with it', 'Always pass', 'Test every page'], 0, 'Otherwise it proves nothing.'),
      many('Which make a fix safe? Pick all that apply.', ['A small change', 'A test that covers it', 'Rewriting the whole file', 'Running the other tests too'], [0, 1, 3], 'Small, tested, nothing else broken.'),
      order('Drag these into order.', ['Write a failing test', 'Make the change', 'See the test pass', 'Run all the tests'], 'Red, green, then everything.'),
      sort('Drag each change to whether it belongs in this fix.', ['In this fix', 'Not now'], [['Ignore a repeat Pay request', 0], ['Rename every variable', 1], ['Disable Pay while waiting', 0], ['Redesign the checkout', 1]], 'Keep the fix about the bug.'),
    ],
    4: [
      text('Write the one-line summary for the team.', 'What broke and what you changed.', 10, 'e.g. "Double orders on fast double-clicks; Pay now ignores repeats."'),
      one('Who is the note mainly for?', ['The team that maintains the code', 'The customer', 'Investors'], 0, 'They need what changed and what to watch.'),
      many('What belongs in the note? Pick all that apply.', ['What broke', 'What you changed', 'What to watch', 'How tired you were'], [0, 1, 2], 'Useful the next morning.'),
      order('Drag the parts of the note into order.', ['What broke', 'Why it broke', 'What changed', 'What to watch'], 'Story order: problem, cause, fix, follow-up.'),
      sort('Drag each line to its part of the note.', ['What broke', 'What to watch'], [['Orders saved twice', 0], ['Watch for slow Pay replies', 1], ['Customers charged twice', 0], ['Check refunds this week', 1]], 'Past problem vs future watch.'),
    ],
  },
  'solace-clinic-waiting-time': {
    1: [
      text('Name the step in a clinic visit where you think most waiting happens, and why.', 'One or two sentences.', 10, 'Often between registration and the nurse, when patients queue.'),
      one('A patient sitting in the waiting area is...', ['A step where they wait', 'A step where they are seen', 'Not part of the visit'], 0, 'Waiting is part of the visit, and usually the biggest part.'),
      many('Which are steps a patient goes through? Pick all that apply.', ['Registration', 'Vitals with the nurse', 'Staff lunch break', 'Seeing the doctor'], [0, 1, 3], 'Staff breaks affect waits but are not a patient step.'),
      order('Drag a visit into order.', ['Arrive', 'Register', 'Vitals with the nurse', 'See the doctor', 'Pharmacy'], 'Front door to medicine.'),
      sort('Drag each step to who does it.', ['Receptionist', 'Nurse', 'Doctor'], [['Registration', 0], ['Blood pressure', 1], ['Diagnosis', 2], ['Booking a follow-up', 0]], 'Knowing who does what shows where queues form.'),
    ],
    2: [
      text('Average wait before the doctor is 40 minutes; the doctor sees each patient for 8. What does that tell you?', 'One or two sentences.', 10, 'The doctor\'s time is not the bottleneck - the wait before it is.'),
      one('Which number finds the bottleneck?', ['The longest average wait between steps', 'The number of patients', 'The clinic\'s opening hours'], 0, 'Where the time goes is where to look.'),
      many('Which could make one average misleading? Pick all that apply.', ['One patient waiting three hours', 'A very small sample', 'Timings from a holiday', 'Twenty normal Mondays'], [0, 1, 2], 'Check for outliers and odd days.'),
      order('Drag the steps of finding the bottleneck into order.', ['Work out minutes per step', 'Average them', 'Pick the longest', 'Check it is not one outlier'], 'Measure, average, pick, sanity-check.'),
      sort('Drag each finding to what it is.', ['Waiting', 'Being seen'], [['30 minutes before the nurse', 0], ['5 minutes of vitals', 1], ['40 minutes before the doctor', 0], ['8 minutes with the doctor', 1]], 'The bottleneck is usually in the waiting.'),
    ],
    3: [
      text('Describe your one change in a sentence.', 'Something the clinic could try next Monday.', 10, 'e.g. "Take vitals at registration so the nurse queue disappears."'),
      one('Which change is easiest to try next Monday?', ['A second registration window at 9-11', 'A new building', 'Hiring ten doctors'], 0, 'Small and cheap to test.'),
      many('What should a proposal include? Pick all that apply.', ['The change', 'What it costs', 'How to measure it', 'A logo'], [0, 1, 2], 'What, cost, and how you\'ll know.'),
      order('Drag these into order.', ['Measure the wait today', 'Make the change', 'Measure again', 'Keep it or drop it'], 'Before, change, after, decide.'),
      sort('Drag each item to what it is.', ['Cost', 'Measure'], [['One extra receptionist 9-11', 0], ['Average wait before the doctor', 1], ['Two hours of nurse time', 0], ['Patients seen by noon', 1]], 'Know what you spend and what you expect back.'),
    ],
  },
  'orbit-festive-campaign': {
    1: [
      text('Describe your audience in one sentence.', 'Who, and what they care about.', 10, 'e.g. "Families in tier-2 cities buying gifts for relatives in the last week before Diwali."'),
      one('"Everyone" as an audience is...', ['Too broad to write for', 'The best choice', 'Required'], 0, 'You cannot write one message for everyone.'),
      many('Which help describe an audience? Pick all that apply.', ['Where they live', 'What they buy for the festival', 'Their passwords', 'When they shop'], [0, 1, 3], 'Enough to write for them - nothing private.'),
      order('Drag these into order.', ['Look at last year\'s buyers', 'Pick one group', 'Describe them', 'Check the budget can reach them'], 'Data, choice, description, reality check.'),
      sort('Drag each detail to whether it helps.', ['Helps', 'Does not'], [['Shops on weekends', 0], ['Likes the colour blue', 1], ['Buys gifts for relatives', 0], ['Has a pet', 1]], 'Only what changes the message or the timing.'),
    ],
    2: [
      text('Which channel would you use in week one, and why?', 'One or two sentences.', 10, 'Whatever your audience already uses - often WhatsApp or Instagram for awareness.'),
      one('Week one of a three-week campaign is mostly for...', ['Getting noticed', 'Final discounts', 'Thank-you notes'], 0, 'Awareness first, offers closer to the day.'),
      many('Which belong in a campaign plan? Pick all that apply.', ['Channels', 'Messages', 'Timing', 'The office seating plan'], [0, 1, 2], 'Where, what and when.'),
      order('Drag the three weeks into order.', ['Get noticed', 'Show the offer', 'Last-chance reminder'], 'Build up to the festival.'),
      sort('Drag each message to its week.', ['Week 1', 'Week 3'], [['Meet our festive range', 0], ['Last 2 days for delivery', 1], ['See what\'s new this year', 0], ['Order by Friday', 1]], 'Introduce early, push late.'),
    ],
    3: [
      text('How will you know the campaign worked?', 'Name one number.', 6, 'e.g. "Festive sales against the same weeks last year."'),
      one('Most of the budget usually goes to...', ['The channel your audience uses most', 'Every channel equally', 'Printing the plan'], 0, 'Spend where your people are.'),
      many('Which are sensible ways to measure it? Pick all that apply.', ['Sales vs last year', 'Coupon codes used', 'Number of meetings held', 'Visits to the festive page'], [0, 1, 3], 'Tie it to what customers did.'),
      order('Drag these into order.', ['Fix the total budget', 'Split it by channel', 'Set what you expect back', 'Track it weekly'], 'Total, split, target, track.'),
      sort('Drag each line to what it is.', ['Spend', 'Expected return'], [['₹40,000 on Instagram', 0], ['300 extra orders', 1], ['₹15,000 on WhatsApp', 0], ['10% more festive sales', 1]], 'Know what you put in and what you want out.'),
    ],
  },
  'sample-ledger-works-reconcile-a-month-of-payments': {
    1: [
      text('In your words, what is a reconciliation?', 'One or two sentences.', 10, 'Checking that what the bank says moved matches what the books say moved.'),
      one('A payment matches an invoice exactly. What next?', ['Mark it matched', 'Ask the owner', 'Delete it'], 0, 'Exact matches need no questions.'),
      many('Which need a question before matching? Pick all that apply.', ['No reference at all', 'Exact amount with invoice number', 'Two equal payments on one day', 'An unusual amount'], [0, 2, 3], 'Anything you cannot be sure of.'),
      order('Drag the matching steps into order.', ['Sort both lists by date', 'Match exact amounts', 'Match the rest by reference', 'List what is left'], 'Easy matches first.'),
      sort('Drag each line to where it goes.', ['Matched', 'Left over'], [['₹24,000 with INV-0412', 0], ['₹15,500 no reference', 1], ['₹8,000 for INV-0415 and 0416', 0], ['₹350 bank fee', 1]], 'Left over still needs a reason.'),
    ],
    2: [
      text('What makes a difference worth telling the owner about?', 'One or two sentences.', 10, 'Its size, and whether you could explain it.'),
      one('Which difference goes first in the note?', ['The largest unexplained one', 'The smallest', 'The oldest invoice'], 0, 'Biggest risk first.'),
      many('Which are good reasons to give for a difference? Pick all that apply.', ['Bank charge', 'Paid short', 'Paid twice', 'Bad luck'], [0, 1, 2], 'Reasons the owner can check.'),
      order('Drag the note into order.', ['How many matched', 'Differences, largest first', 'Likely reasons', 'What we need from you'], 'Overview, then detail, then action.'),
      sort('Drag each difference to its likely reason.', ['Bank charge', 'Paid short'], [['₹9,950 for a ₹10,000 invoice', 0], ['₹10,000 for a ₹12,000 invoice, "rest next week"', 1], ['₹45 SMS alert fee', 0], ['Half paid with a note', 1]], 'Small round gaps are charges; notes mean short payment.'),
    ],
  },
  'sample-ledger-works-every-kind-of-question': {
    1: [
      text('What was the first thing you looked for on the statement?', 'One sentence.', 8, 'Anything that did not match an invoice.'),
      one('A line reads "SMS charges ₹45". What is it?', ['A bank fee', 'A customer payment', 'A refund'], 0, 'The bank charged it.'),
      many('Which would you check first? Pick all that apply.', ['Payments with no reference', 'Round-number fees', 'Payments that match exactly', 'Repeated amounts'], [0, 3], 'Exact matches and known fees are the easy part.'),
      order('Drag into order.', ['Read the statement', 'Read the client\'s list', 'Spot what looks wrong', 'Note it down'], 'Read both, then compare.'),
      sort('Drag each line to where it is from.', ['Bank', 'Client\'s list'], [['Interest earned', 0], ['Invoice INV-0412 sent', 1], ['Account fee', 0], ['Payment promised next week', 1]], 'Know which source said what.'),
    ],
    2: [
      text('Why put bank-only entries in their own group?', 'One sentence.', 8, 'They need booking, not matching.'),
      one('"Needs a question" means...', ['You cannot be sure what it is', 'It is wrong', 'It is matched'], 0, 'Not wrong - just unknown.'),
      many('Which are bank-only? Pick all that apply.', ['Interest', 'Account fee', 'Customer payment', 'SMS charges'], [0, 1, 3], 'The bank made them.'),
      order('Drag into order.', ['Group the lines', 'Write them in a sheet', 'Share a link', 'Check anyone can open it'], 'A link nobody can open is no hand-in.'),
      sort('Drag each line to its group.', ['Matches an invoice', 'Bank-only'], [['₹24,000 with INV-0412', 0], ['Interest ₹120', 1], ['₹5,000 with INV-0420', 0], ['Fee ₹350', 1]], 'Same rule as the task.'),
    ],
    3: [
      text('Write one sentence the owner would understand about the ₹15,500 payment.', 'No jargon.', 10, 'e.g. "We received ₹15,500 but cannot tell who sent it - we are asking the bank."'),
      one('A good note to an owner is...', ['Short and plain', 'Long and technical', 'Only numbers'], 0, 'They should act without calling you.'),
      many('Which make a note easy to act on? Pick all that apply.', ['A clear ask', 'Amounts and dates', 'Accounting jargon', 'What happens next'], [0, 1, 3], 'Plain, specific, with a next step.'),
      order('Drag into order.', ['What happened', 'What you think it is', 'What you are doing', 'What you need from them'], 'Facts, view, action, ask.'),
      sort('Drag each line to its part of the note.', ['What happened', 'What we need'], [['₹15,500 arrived with no reference', 0], ['Do you expect money from anyone?', 1], ['It came on the 12th', 0], ['Please check your invoices', 1]], 'Tell, then ask.'),
    ],
  },
  'sample-ledger-works-practice-draft-edit-me': {
    1: [
      text('How would you find the three largest customers?', 'One or two sentences.', 10, 'Total each customer\'s invoices and sort.'),
      one('Two invoices for one customer: what counts?', ['Their total', 'The larger one only', 'The first one'], 0, 'Customers, not invoices.'),
      many('What is on every invoice? Pick all that apply.', ['Amount', 'Customer', 'Date', 'Bank balance'], [0, 1, 2], 'The balance is on the statement.'),
      order('Drag into order.', ['List the invoices', 'Total by customer', 'Sort by total', 'Take the top three'], 'Group, total, sort.'),
      sort('Drag each item to where you find it.', ['Invoice', 'Bank statement'], [['Amount owed', 0], ['Amount received', 1], ['Due date', 0], ['Closing balance', 1]], 'Asked for vs received.'),
    ],
    2: [
      text('Write the first line of a polite reminder.', 'One sentence.', 8, 'e.g. "A quick reminder that invoice INV-0412 for ₹24,000 was due on the 5th."'),
      one('A reminder should be...', ['Polite and specific', 'Angry', 'Vague'], 0, 'People pay clear, polite reminders.'),
      many('What should a reminder include? Pick all that apply.', ['Invoice number', 'Amount', 'Due date', 'A threat'], [0, 1, 2], 'Everything they need to pay.'),
      order('Drag into order.', ['Greeting', 'What is owed', 'When it was due', 'How to pay'], 'Make paying easy.'),
      sort('Drag each line to its tone.', ['Polite', 'Too harsh'], [['A quick reminder about INV-0412', 0], ['Pay now or else', 1], ['Thank you for your business', 0], ['This is your final warning', 1]], 'Firm but friendly works best.'),
    ],
  },
};

/** Which kinds a task's tests already have. */
function kindsIn(pages: ReturnType<typeof readPages>): Set<string> {
  const k = new Set<string>();
  for (const p of pages) {
    if (p.kind !== 'check') continue;
    for (const q of p.questions) k.add(q.kind === 'choice' ? (q.multiple ?? q.correct.length > 1 ? 'many' : 'one') : q.kind);
  }
  return k;
}

async function main() {
  let added = 0;
  let skipped = 0;
  for (const [slug, byTask] of Object.entries(TESTS)) {
    const tasks = await prisma.workSimulationTask.findMany({
      where: { simulation: { slug } },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, pages: true },
    });
    for (const t of tasks) {
      const questions = byTask[t.position];
      if (!questions) continue;
      const pages = readPages(t.pages);
      const have = kindsIn(pages);
      const hasAll = ['text', 'one', 'many', 'order', 'sort'].every((k) => have.has(k));
      if (hasAll || pages.some((p) => p.title === TITLE)) {
        skipped += 1;
        continue;
      }
      const [test] = pagesSchema.parse([{ kind: 'check', title: TITLE, questions }]);
      await prisma.workSimulationTask.update({ where: { id: t.id }, data: { pages: [...pages, test] as object[] } });
      added += 1;
    }
  }
  console.log(`tests added: ${added}, already covered: ${skipped}`);
}

main().finally(() => prisma.$disconnect());
