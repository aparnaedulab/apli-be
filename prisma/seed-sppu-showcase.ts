/**
 * The SPPU demo: one university, real companies, and students at every stage.
 *
 *   npx tsx prisma/seed-sppu-showcase.ts
 *
 * What it does, in order:
 *
 *   1. Removes every institution except SPPU (slug "sppu").
 *   2. Adds the companies whose job simulations students know from Forage -
 *      JPMorgan, Goldman Sachs, BCG, Accenture, Tata, Mastercard and more -
 *      verified, each with a recruiter login, an interview process and one
 *      live work simulation modelled on theirs.
 *   3. Adds students to the SPPU colleges that had none.
 *   4. Puts SPPU's students in every state the admin and student screens
 *      show: not started, working, handed in, changes asked, certified,
 *      sharing with companies, internship offers (open, accepted, declined,
 *      withdrawn, lapsed) and interviews at every round.
 *
 * Safe to run again: it first removes what it added last time (the
 * companies below, and every user on *.sppu-demo.example), then rebuilds.
 * Deterministic: the same students land in the same states every run.
 * It never sends mail. Every login uses the demo password.
 */
import { InternshipOfferStatus, Role, RunStatus, WorkSimulationLevel, WorkSimulationStatus } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { rebuildDemoNotifications } from './rebuild-demo-notifications.js';
import { addShowcaseJobs } from './seed-sppu-jobs.js';

const PASSWORD = process.env.DEMO_PASSWORD ?? 'CampusHire2026';
const DOMAIN = 'sppu-demo.example';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3600 * 1000);
const ahead = (days: number) => new Date(NOW + days * DAY);

/** A small seeded random, so every run puts the same student in the same state. */
let seed = 20261029;
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

// ---------------------------------------------------------------------------
// The companies and their simulations
// ---------------------------------------------------------------------------

interface TaskDef {
  title: string;
  brief: string;
  handIn: string;
  minutes: number;
  learn: string[];
  steps: string[];
  answer: string;
}

interface CompanyDef {
  key: string;
  name: string;
  legalName: string;
  website: string;
  city: string;
  state: string;
  industry: string;
  headline: string;
  about: string;
  recruiter: [string, string];
  sim: {
    slug: string;
    title: string;
    field: string;
    level: WorkSimulationLevel;
    hours: number;
    skills: string[];
    summary: string;
    about: string;
    tasks: TaskDef[];
  };
  internship: { role: string; about: string; workMode: 'REMOTE' | 'OFFICE' | 'HYBRID'; city: string | null; months: number; stipend: number };
}

const t = (
  title: string,
  brief: string,
  handIn: string,
  minutes: number,
  learn: string[],
  steps: string[],
  answer: string,
): TaskDef => ({ title, brief, handIn, minutes, learn, steps, answer });

const COMPANIES: CompanyDef[] = [
  {
    key: 'jpmorgan',
    name: 'JPMorgan Chase & Co.',
    legalName: 'J.P. Morgan Services India Private Limited',
    website: 'https://www.jpmorganchase.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Banking and financial services',
    headline: 'Software engineering at a global bank',
    about: 'One of the largest banks in the world. Its technology teams in Mumbai, Bengaluru and Hyderabad build the trading, payments and risk systems the bank runs on.',
    recruiter: ['Priya Raghavan', 'campus'],
    sim: {
      slug: 'jpmorgan-software-engineering',
      title: 'Software Engineering',
      field: 'Software',
      level: 'INTERMEDIATE',
      hours: 5,
      skills: ['Python', 'Git', 'Data feeds', 'Data visualisation'],
      summary: 'Join a trading-tools team: fix a broken stock price feed and help traders see the data they need.',
      about: 'Traders watch prices move by the second, and a feed that is slightly wrong costs real money. In this simulation you set up the project, fix the code that reads the price feed, and build the view traders use to spot when two stocks drift apart.',
      tasks: [
        t('Set up your environment', 'Clone the project, install what it needs and get the tests running.', 'A screenshot of the tests running, and anything you had to fix to get there.', 40,
          ['Setting up a real project from its README', 'Running a test suite'],
          ['Clone the repository and read the README.', 'Install the dependencies.', 'Run the tests and note which ones fail.'],
          'Cloned the repo, installed Python 3.11 and the requirements. Two tests failed on first run; both were the price feed, which is the next task.'),
        t('Fix the stock price feed', 'The feed reports the wrong price for each stock. Find out why and correct it.', 'Your changed file, and two lines on what was wrong.', 90,
          ['Reading code you did not write', 'Writing a test that proves a fix'],
          ['Read how a quote becomes a price.', 'Work out why the price is wrong.', 'Fix it and make the tests pass.'],
          'The price was taken from the bid only. It should be the mid-point of bid and ask. I changed getDataPoint to average them and fixed getRatio to avoid dividing by zero. All tests pass.'),
        t('Show traders the ratio', 'Traders want to see when two stocks move apart. Build the chart that shows it.', 'A link or screenshot of your chart, and how a trader should read it.', 90,
          ['Turning a data feed into a chart', 'Designing for someone who has seconds to look'],
          ['Add the ratio between the two stocks to the feed.', 'Chart it with upper and lower bounds.', 'Mark when it crosses a bound.'],
          'Added the ratio and 10% bounds above and below the 12-month average. A red marker appears when the ratio crosses a bound, which is the moment a trader should look.'),
      ],
    },
    internship: { role: 'Software Engineer Intern', about: 'Eight weeks on a trading-tools team in Mumbai, working on the market data services you saw in the simulation.', workMode: 'HYBRID', city: 'Mumbai', months: 2, stipend: 60000 },
  },
  {
    key: 'goldman',
    name: 'Goldman Sachs',
    legalName: 'Goldman Sachs Services Private Limited',
    website: 'https://www.goldmansachs.com',
    city: 'Bengaluru',
    state: 'Karnataka',
    industry: 'Banking and financial services',
    headline: 'Where finance and technology meet',
    about: 'A global investment bank whose Bengaluru office is one of its largest anywhere, home to engineering, risk and controllers teams.',
    recruiter: ['Rahul Menon', 'campus'],
    sim: {
      slug: 'goldman-sachs-controllers',
      title: 'Controllers',
      field: 'Finance',
      level: 'BEGINNER',
      hours: 2,
      skills: ['Fund accounting', 'Excel', 'Financial reporting'],
      summary: 'Work as a Controllers analyst: budget like a professional, then work out what a fund is worth today.',
      about: 'Controllers make sure the numbers the firm reports are right. You will start with your own semester budget, then calculate a fund\'s net asset value from its contributions, distributions, fees and income.',
      tasks: [
        t('Build a semester budget', 'Plan a student\'s money for one semester the way Controllers plan a fund\'s.', 'Your budget sheet, and the one line you would cut first.', 40,
          ['Separating fixed and variable costs', 'Checking a total adds up'],
          ['List income and costs for the semester.', 'Split costs into fixed and variable.', 'Show the balance month by month.'],
          'Income ₹42,000 for the semester against ₹39,600 of costs. Rent and fees are fixed; food and travel vary. I would cut eating out first, which frees ₹3,000.'),
        t('Calculate a fund\'s NAV', 'From a year of fund activity, work out the history-to-date balances and the net asset value.', 'Your sheet with the NAV, and any figure you think is wrong.', 60,
          ['How a fund\'s value is built up', 'Spotting a bad data point'],
          ['Total contributions and distributions.', 'Take off fees, add income.', 'Check your NAV against the statement.'],
          'NAV comes to $48.2m. The Q3 management fee looks doubled compared with the other quarters; I flagged it rather than use it.'),
      ],
    },
    internship: { role: 'Controllers Summer Analyst', about: 'Ten weeks with the fund controllers team in Bengaluru.', workMode: 'OFFICE', city: 'Bengaluru', months: 3, stipend: 55000 },
  },
  {
    key: 'bofa',
    name: 'Bank of America',
    legalName: 'BA Continuum India Private Limited',
    website: 'https://www.bankofamerica.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Banking and financial services',
    headline: 'Investment banking, from the analyst\'s desk',
    about: 'One of the world\'s largest financial institutions, with major operations in Mumbai, Gurugram, Chennai and Hyderabad.',
    recruiter: ['Anjali Deshmukh', 'campus'],
    sim: {
      slug: 'bank-of-america-investment-banking',
      title: 'Investment Banking',
      field: 'Finance',
      level: 'ADVANCED',
      hours: 4,
      skills: ['Financial analysis', 'Financial modelling', 'M&A', 'Valuation'],
      summary: 'Be an analyst on a technology, media and telecom deal team: read a client\'s annual report, screen a target and brief the client.',
      about: 'A client in technology and telecom wants to grow by buying another company. You will summarise how the client has performed, screen a possible target, and write the messages a real deal team sends.',
      tasks: [
        t('Summarise the client\'s financials', 'From the annual report, build a five-year summary and a SWOT analysis.', 'Your summary sheet and SWOT, one page each.', 75,
          ['Reading an annual report quickly', 'A SWOT that says something'],
          ['Pull revenue, EBITDA and net income for five years.', 'Work out growth and margins.', 'Write the SWOT.'],
          'Revenue grew 11% a year but margins fell from 24% to 19%. The biggest threat is pricing pressure from two new low-cost entrants.'),
        t('Screen an acquisition target', 'Decide whether a smaller company is worth buying, and at roughly what price.', 'Three slides: the target, the price range, your view.', 90,
          ['Comparable-company valuation', 'Saying yes or no with reasons'],
          ['Find three comparable companies.', 'Apply their multiples to the target.', 'Give a range and a recommendation.'],
          'At 9–11x EBITDA the target is worth $1.4–1.7bn. I recommend proceeding: it fills the client\'s gap in cloud services.'),
        t('Brief the client', 'Write the email to the client\'s CFO setting out what you found.', 'The email, under 250 words.', 45,
          ['Writing for a senior reader', 'Leading with the answer'],
          ['Lead with the recommendation.', 'Give the three reasons.', 'Say what happens next.'],
          'Dear Ms Rao - we recommend opening talks with the target at a range of $1.4–1.7bn. Three reasons follow…'),
      ],
    },
    internship: { role: 'Investment Banking Summer Analyst', about: 'Ten weeks on the TMT coverage team in Mumbai.', workMode: 'OFFICE', city: 'Mumbai', months: 3, stipend: 75000 },
  },
  {
    key: 'bcg',
    name: 'BCG',
    legalName: 'The Boston Consulting Group (India) Private Limited',
    website: 'https://www.bcg.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Management consulting',
    headline: 'Strategy consulting, one client problem at a time',
    about: 'A global management consulting firm advising the largest companies in India and the world on strategy, operations and transformation.',
    recruiter: ['Karthik Iyer', 'campus'],
    sim: {
      slug: 'bcg-strategy-consulting',
      title: 'Strategy Consulting',
      field: 'Consulting',
      level: 'INTERMEDIATE',
      hours: 4,
      skills: ['Problem structuring', 'Data analysis', 'Stakeholder analysis', 'Presentations'],
      summary: 'An energy client is losing small-business customers. Find out why and tell the partner what to do about it.',
      about: 'A power utility is watching its small and medium business customers leave. You will scope the problem, analyse customer and pricing data, weigh the risks and recommend an answer to the partner.',
      tasks: [
        t('Scope the problem', 'Break the client\'s question into the parts you need to answer.', 'An issue tree and the data you would ask for.', 45,
          ['Structuring a vague question', 'Asking for the right data'],
          ['Write the key question in one line.', 'Break it into three or four branches.', 'List the data each branch needs.'],
          'Key question: will a 20% discount stop SME churn? Branches: who leaves, why, what competitors charge, what a discount costs.'),
        t('Analyse the churn data', 'Use the customer data to find who is leaving and why.', 'Two charts and what they show.', 90,
          ['Cleaning and segmenting customer data', 'Finding the signal'],
          ['Clean the customer file.', 'Segment churn by size and usage.', 'Test whether price explains churn.'],
          'Churn is concentrated in customers with high usage and no long-term contract. Price sensitivity is real but explains under half of it.'),
        t('Recommend to the partner', 'Put your answer on three slides the partner could take to the client.', 'Three slides.', 60,
          ['The pyramid principle', 'Saying what you are unsure of'],
          ['Answer first.', 'Back it with your two strongest findings.', 'Say what you would test next.'],
          'Offer the discount only to high-usage customers out of contract: it keeps 60% of at-risk revenue at a third of the cost of a blanket discount.'),
      ],
    },
    internship: { role: 'Associate Intern', about: 'Eight weeks on a live client case team in Mumbai.', workMode: 'HYBRID', city: 'Mumbai', months: 2, stipend: 80000 },
  },
  {
    key: 'pwc',
    name: 'PwC',
    legalName: 'PricewaterhouseCoopers Private Limited',
    website: 'https://www.pwc.in',
    city: 'Kolkata',
    state: 'West Bengal',
    industry: 'Professional services',
    headline: 'Cyber security and risk consulting',
    about: 'One of the Big Four professional services firms, with cyber, risk and technology consulting teams across Indian cities.',
    recruiter: ['Sneha Banerjee', 'campus'],
    sim: {
      slug: 'pwc-cyber-security-consulting',
      title: 'Cyber Security Consulting',
      field: 'Cybersecurity',
      level: 'INTERMEDIATE',
      hours: 4,
      skills: ['Risk assessment', 'Controls', 'Business writing', 'Research'],
      summary: 'Check a client\'s procure-to-pay process for missing controls and write up the risks for its finance director.',
      about: 'A fictional manufacturing client pays suppliers through a process nobody has reviewed in years. You will find the gaps, explain what could go wrong and recommend the controls that close them.',
      tasks: [
        t('Assess the risks', 'Walk through the procure-to-pay process and find where controls are missing.', 'A table of gaps and the risk each one creates.', 75,
          ['How procure-to-pay works', 'Thinking like an auditor'],
          ['Map the process from order to payment.', 'Mark where nobody checks.', 'Say what could go wrong at each.'],
          'Five gaps. The worst: the same person can add a new supplier and approve its first payment, which allows a fake supplier to be paid.'),
        t('Recommend controls', 'For each gap, say which control closes it and what it costs.', 'Your table with a control added to each row.', 60,
          ['Preventive and detective controls', 'Weighing cost against risk'],
          ['Choose a control for each gap.', 'Say whether it prevents or detects.', 'Rank them by risk closed.'],
          'Split supplier set-up from payment approval first; it closes the largest risk for almost no cost.'),
        t('Write to the finance director', 'Summarise your findings in an email the director will act on.', 'The email.', 40,
          ['Writing for a non-specialist', 'Making the ask clear'],
          ['Say what you found in one line.', 'List the top three fixes.', 'Ask for a decision.'],
          'Dear Mr Sen - we found five control gaps in supplier payments; three need fixing this quarter…'),
      ],
    },
    internship: { role: 'Cyber Risk Intern', about: 'Twelve weeks with the cyber and risk consulting team.', workMode: 'HYBRID', city: 'Kolkata', months: 3, stipend: 35000 },
  },
  {
    key: 'accenture',
    name: 'Accenture',
    legalName: 'Accenture Solutions Private Limited',
    website: 'https://www.accenture.com/in-en',
    city: 'Bengaluru',
    state: 'Karnataka',
    industry: 'IT services and consulting',
    headline: 'Data and analytics for the world\'s biggest brands',
    about: 'A global professional services company with one of its largest workforces in India, across Pune, Bengaluru, Mumbai, Hyderabad and more.',
    recruiter: ['Vikram Joshi', 'campus'],
    sim: {
      slug: 'accenture-data-analytics',
      title: 'Data Analytics and Visualization',
      field: 'Data',
      level: 'BEGINNER',
      hours: 4,
      skills: ['Data cleaning', 'Data modelling', 'Data visualisation', 'Storytelling'],
      summary: 'Help a social media client find its five most popular content categories and present them to the client.',
      about: 'A fast-growing social media company wants to know what its users love. You will clean three datasets, model them together, find the top categories and present the answer to the client.',
      tasks: [
        t('Understand the brief', 'Read the client\'s request and decide what you need to answer it.', 'A short list of the questions and the data you will use.', 30,
          ['Turning a brief into questions', 'Choosing the data that answers them'],
          ['Read the client brief.', 'List what they actually want to know.', 'Match each question to a dataset.'],
          'They want the top five categories by popularity. That needs the content, reactions and reaction-type tables joined.'),
        t('Clean and model the data', 'Clean three datasets and join them into one you can analyse.', 'Your cleaned, joined sheet.', 90,
          ['Removing bad rows and fixing types', 'Joining tables correctly'],
          ['Remove rows with missing values.', 'Fix data types.', 'Join the three tables on their keys.'],
          'Removed 1,180 rows with missing content type. Joined on content ID and reaction type; 24,573 rows left.'),
        t('Find the top five', 'Score each category by popularity and find the top five.', 'A chart of the top five and one insight.', 60,
          ['Aggregating data', 'Picking the chart that fits'],
          ['Sum the reaction scores per category.', 'Rank the categories.', 'Chart the top five.'],
          'Animals, science, healthy eating, technology and food lead. Animals alone is 7% of all reactions.'),
        t('Present to the client', 'Put the answer in a short deck for the client.', 'A 5-slide deck.', 60,
          ['Presenting data to a non-technical client', 'Ending with next steps'],
          ['Open with the answer.', 'Show the chart.', 'Recommend what to do with it.'],
          'Five slides: the question, the method, the top five, one insight, and a recommendation to build a weekly animals feature.'),
      ],
    },
    internship: { role: 'Data Analyst Intern', about: 'Six months with the data and AI practice in Pune, working on client analytics projects.', workMode: 'HYBRID', city: 'Pune', months: 6, stipend: 30000 },
  },
  {
    key: 'tata',
    name: 'Tata Group',
    legalName: 'Tata Sons Private Limited',
    website: 'https://www.tata.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Conglomerate',
    headline: 'Data visualisation for business decisions',
    about: 'India\'s largest business group, with companies across technology, steel, automobiles, consumer goods and more.',
    recruiter: ['Meera Kulkarni', 'campus'],
    sim: {
      slug: 'tata-data-visualisation',
      title: 'Data Visualisation: Empowering Business with Effective Insights',
      field: 'Data',
      level: 'BEGINNER',
      hours: 3,
      skills: ['Data visualisation', 'Dashboards', 'Business insight'],
      summary: 'An online retailer\'s CEO and CMO need a dashboard that answers their questions about growth. Build it and tell the story.',
      about: 'A UK-based online retailer is planning its expansion. You will frame the leadership\'s questions, build the visuals that answer them and present the story to the CEO.',
      tasks: [
        t('Frame the business questions', 'Work out exactly what the CEO and CMO need to see.', 'Their questions, and the chart you would use for each.', 30,
          ['Designing for a specific reader', 'Choosing the right chart'],
          ['Read the leadership\'s requests.', 'Write each as one question.', 'Pick a chart for each.'],
          'Four questions: revenue trend by month, top ten countries, top customers, and demand by region. Line, bar, bar, map.'),
        t('Build the dashboard', 'Build the visuals that answer each question.', 'Screenshots or a link to your dashboard.', 90,
          ['Building a dashboard', 'Keeping it readable'],
          ['Clean the sales data.', 'Build each chart.', 'Put them on one page.'],
          'Built in Power BI: the monthly trend shows a November peak; the Netherlands is the top country after the UK.'),
        t('Tell the story', 'Record or write the walkthrough you would give the CEO.', 'A short script or recording.', 45,
          ['Data storytelling', 'Recommending from evidence'],
          ['Open with the headline.', 'Walk through two charts.', 'End with a recommendation.'],
          'Expand into the Netherlands and Germany first: they already buy more per order than any market except the UK.'),
      ],
    },
    internship: { role: 'Business Analytics Intern', about: 'Eight weeks with a Tata group company\'s analytics team.', workMode: 'OFFICE', city: 'Mumbai', months: 2, stipend: 25000 },
  },
  {
    key: 'mastercard',
    name: 'Mastercard',
    legalName: 'Mastercard India Services Private Limited',
    website: 'https://www.mastercard.co.in',
    city: 'Pune',
    state: 'Maharashtra',
    industry: 'Payments and technology',
    headline: 'Keeping payments safe',
    about: 'A global payments technology company with a large technology hub in Pune.',
    recruiter: ['Aditya Shah', 'campus'],
    sim: {
      slug: 'mastercard-cybersecurity',
      title: 'Cybersecurity',
      field: 'Cybersecurity',
      level: 'BEGINNER',
      hours: 2,
      skills: ['Phishing awareness', 'Security training', 'Data analysis'],
      summary: 'Join the security awareness team: design a phishing test, then decide which teams need training.',
      about: 'Most breaches start with one person clicking one link. You will design a realistic phishing email for a company-wide test, then read the results and decide where training is needed.',
      tasks: [
        t('Design a phishing email', 'Write a realistic phishing email for a company-wide awareness test.', 'Your email, and the three warning signs it hides.', 45,
          ['How phishing emails work', 'Designing a fair test'],
          ['Pick a believable pretext.', 'Write the email.', 'List the signs a careful reader would spot.'],
          'Pretext: an HR benefits update with a "confirm your details" link. Signs: an external sender address, urgency, and a mismatched link.'),
        t('Decide who needs training', 'From the test results, decide which teams need training and what kind.', 'Your recommendation with the data behind it.', 45,
          ['Reading test results', 'Targeting training where it matters'],
          ['Find click rates by team.', 'Compare against the company average.', 'Recommend training for the worst.'],
          'Finance and HR clicked at twice the company average. I recommend a 20-minute targeted session for both and a retest in six weeks.'),
      ],
    },
    internship: { role: 'Cybersecurity Intern', about: 'Twelve weeks with the security awareness team at the Pune tech hub.', workMode: 'OFFICE', city: 'Pune', months: 3, stipend: 40000 },
  },
  {
    key: 'deloitte',
    name: 'Deloitte',
    legalName: 'Deloitte Touche Tohmatsu India LLP',
    website: 'https://www2.deloitte.com/in',
    city: 'Hyderabad',
    state: 'Telangana',
    industry: 'Professional services',
    headline: 'Technology consulting',
    about: 'One of the Big Four professional services firms, with large consulting and technology teams in Hyderabad, Bengaluru, Mumbai and Pune.',
    recruiter: ['Rohit Verma', 'campus'],
    sim: {
      slug: 'deloitte-technology-consulting',
      title: 'Technology Consulting',
      field: 'Technology',
      level: 'BEGINNER',
      hours: 3,
      skills: ['Data analysis', 'Dashboards', 'Client communication'],
      summary: 'A manufacturing client\'s machines keep failing. Analyse the factory data and build the dashboard its managers need.',
      about: 'A manufacturer wants to know why its machines stop. You will analyse sensor data from its factories, build a dashboard for the operations managers and explain what they should do next.',
      tasks: [
        t('Analyse the factory data', 'Find which machines fail most and when.', 'Your findings in a short table.', 60,
          ['Working with sensor data', 'Finding patterns over time'],
          ['Load the sensor data.', 'Count failures by machine and shift.', 'Look for a pattern.'],
          'Two machines account for 60% of stoppages, almost all on the night shift. Their temperature readings climb an hour before each stop.'),
        t('Build the dashboard', 'Build a dashboard operations managers can check each morning.', 'A screenshot or link.', 75,
          ['Dashboards for daily decisions', 'Alerts that mean something'],
          ['Show stoppages by machine.', 'Show the temperature trend.', 'Add an alert threshold.'],
          'One page: stoppages this week, the two problem machines, and a red flag when temperature passes 78°C.'),
        t('Advise the client', 'Write the note to the operations director.', 'The note.', 30,
          ['Turning analysis into advice', 'Being specific about next steps'],
          ['State the finding.', 'Recommend one action.', 'Say how to measure it.'],
          'Service the two machines\' cooling units this month and watch night-shift stoppages; we expect them to halve.'),
      ],
    },
    internship: { role: 'Technology Consulting Intern', about: 'Eight weeks on a client delivery team in Hyderabad.', workMode: 'HYBRID', city: 'Hyderabad', months: 2, stipend: 35000 },
  },
  {
    key: 'jnj',
    name: 'Johnson & Johnson',
    legalName: 'Johnson & Johnson Private Limited',
    website: 'https://www.jnj.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Healthcare and medical technology',
    headline: 'Robotics and controls in MedTech',
    about: 'A global healthcare company whose MedTech teams build surgical and orthopaedic technology.',
    recruiter: ['Neha Pillai', 'campus'],
    sim: {
      slug: 'johnson-and-johnson-robotics-controls',
      title: 'Robotics and Controls',
      field: 'Engineering',
      level: 'INTERMEDIATE',
      hours: 3,
      skills: ['Control systems', 'Debugging', 'Testing', 'Technical documentation'],
      summary: 'A robotic surgical arm is drifting off its path. Diagnose the control code, test a fix and document it.',
      about: 'On a MedTech team, a surgical robot arm overshoots its target under load. You will read the control loop, find the cause, test a fix in simulation and document it for the safety review.',
      tasks: [
        t('Read the scenario', 'Understand the arm, its controller and what the surgeons reported.', 'Your summary of the problem in five lines.', 30,
          ['How a PID controller works', 'Reading an incident report'],
          ['Read the incident report.', 'Read the controller code.', 'Summarise the problem.'],
          'Under load the arm overshoots by 2–3 mm and oscillates before settling. The controller gains were tuned without load.'),
        t('Diagnose and fix the controller', 'Find the cause in the control code and fix it.', 'Your changed code and a before-and-after plot.', 90,
          ['Tuning a control loop', 'Testing in simulation'],
          ['Reproduce the overshoot in simulation.', 'Adjust the gains.', 'Plot before and after.'],
          'Reduced the proportional gain and added derivative action. Overshoot fell from 2.6 mm to 0.3 mm with no oscillation.'),
        t('Document for the safety review', 'Write up what you changed and why it is safe.', 'A one-page technical note.', 45,
          ['Technical writing for a review board', 'Stating limits honestly'],
          ['Describe the fault.', 'Describe the fix and the test.', 'State what was not tested.'],
          'Note covers the fault, the gain change, simulation results, and that it still needs testing on the physical arm.'),
      ],
    },
    internship: { role: 'Robotics Engineering Intern', about: 'Six months with the MedTech robotics team.', workMode: 'OFFICE', city: 'Mumbai', months: 6, stipend: 35000 },
  },
  {
    key: 'whitecase',
    name: 'White & Case',
    legalName: 'White & Case LLP',
    website: 'https://www.whitecase.com',
    city: 'Mumbai',
    state: 'Maharashtra',
    industry: 'Law',
    headline: 'Commercial law on cross-border deals',
    about: 'A global law firm advising on cross-border transactions, project finance and disputes.',
    recruiter: ['Ishita Kapoor', 'graduate'],
    sim: {
      slug: 'white-case-commercial-law',
      title: 'Commercial Law',
      field: 'Law',
      level: 'INTERMEDIATE',
      hours: 4,
      skills: ['Legal research', 'Transaction structuring', 'Client communication'],
      summary: 'Join a cross-border infrastructure deal as a trainee: map who is involved and brief the client\'s board.',
      about: 'A joint venture is financing a new port. You will map the parties, contracts and money flows, then explain the deal to a board that are not lawyers.',
      tasks: [
        t('Map the deal', 'Chart the parties, contracts and fund flows in the project finance structure.', 'Your structure chart.', 75,
          ['How project finance deals are structured', 'Who carries which risk'],
          ['List every party.', 'Draw the contracts between them.', 'Show where the money flows.'],
          'Seven parties: the JV, two sponsors, three lenders and the contractor. Lenders are repaid only from port revenue.'),
        t('Brief the board', 'Explain the deal and its risks to the client\'s board.', 'A one-page briefing note.', 60,
          ['Explaining law to non-lawyers', 'Leading with risk'],
          ['Explain the structure in plain words.', 'Name the three biggest risks.', 'Say what the board must decide.'],
          'The board must approve the sponsor guarantee. Biggest risk: construction delay, since lenders have no claim on the sponsors after completion.'),
      ],
    },
    internship: { role: 'Legal Intern', about: 'Four weeks with the projects and finance practice.', workMode: 'REMOTE', city: null, months: 1, stipend: 20000 },
  },
  {
    key: 'cbre',
    name: 'CBRE',
    legalName: 'CBRE South Asia Private Limited',
    website: 'https://www.cbre.co.in',
    city: 'Gurugram',
    state: 'Haryana',
    industry: 'Real estate services',
    headline: 'Project management for real buildings',
    about: 'The world\'s largest commercial real estate services firm, managing projects and properties across India.',
    recruiter: ['Saurabh Gupta', 'campus'],
    sim: {
      slug: 'cbre-project-management',
      title: 'Project Management',
      field: 'Operations',
      level: 'BEGINNER',
      hours: 1,
      skills: ['Project planning', 'Risk analysis', 'Excel'],
      summary: 'Plan a showroom build for a kitchen-appliance maker: check the plan, find the risks and fix the schedule.',
      about: 'A kitchen-appliance company wants a new showroom open before the festive season. You will review the project plan, check whether the dates hold and flag what could delay it.',
      tasks: [
        t('Review the plan', 'Check the initial project plan for missing steps and impossible dates.', 'A list of problems in the plan.', 30,
          ['Reading a project plan', 'Dependencies and the critical path'],
          ['List the tasks and their dependencies.', 'Find the critical path.', 'Mark dates that cannot work.'],
          'The fit-out starts before the permit is approved, and electrical work overlaps flooring. Both push the opening by three weeks.'),
        t('Fix the schedule', 'Re-plan so the showroom still opens on time.', 'Your revised schedule and the risks left.', 30,
          ['Re-planning under a deadline', 'Naming the risks you cannot remove'],
          ['Re-order the dependent tasks.', 'Find time you can recover.', 'List the remaining risks.'],
          'Applying for the permit two weeks earlier and running electrical before flooring recovers 16 days. Risk left: permit delay.'),
      ],
    },
    internship: { role: 'Project Management Intern', about: 'Eight weeks on a live office fit-out project.', workMode: 'OFFICE', city: 'Pune', months: 2, stipend: 20000 },
  },
  {
    key: 'ea',
    name: 'Electronic Arts',
    legalName: 'EA Digital Illusions CE India Private Limited',
    website: 'https://www.ea.com',
    city: 'Hyderabad',
    state: 'Telangana',
    industry: 'Video games',
    headline: 'Software engineering for games',
    about: 'One of the world\'s largest video game companies, with an engineering studio in Hyderabad.',
    recruiter: ['Arjun Reddy', 'campus'],
    sim: {
      slug: 'electronic-arts-software-engineering',
      title: 'Software Engineering',
      field: 'Software',
      level: 'INTERMEDIATE',
      hours: 4,
      skills: ['Feature design', 'Object-oriented design', 'C++', 'Data structures'],
      summary: 'Propose a feature for a game, design the classes behind it and fix a bug that slows the game down.',
      about: 'On a game team, you will pitch a new feature, design how it is built and then fix a performance bug in the inventory system.',
      tasks: [
        t('Propose a feature', 'Write a short proposal for a new feature in a sports game.', 'A one-page feature proposal.', 45,
          ['Writing a feature proposal', 'Thinking about the player'],
          ['Describe the feature for a player.', 'Say why it matters.', 'List what it needs from the code.'],
          'A "season story" mode that turns a player\'s season into short highlight chapters. It reuses the replay system.'),
        t('Design the classes', 'Design the classes and how they talk to each other.', 'A class diagram and header file.', 75,
          ['Object-oriented design', 'Keeping classes small'],
          ['Find the main objects.', 'Give each one job.', 'Draw how they connect.'],
          'Season, Chapter and Highlight classes; Season owns Chapters, Chapters reference Highlights from the replay store.'),
        t('Fix the slow inventory', 'Find why the inventory lookup is slow and fix it.', 'Your changed code and how much faster it is.', 75,
          ['Choosing a data structure', 'Measuring a speed-up'],
          ['Profile the lookup.', 'Replace the data structure.', 'Measure before and after.'],
          'Lookups scanned a list. Switching to an unordered_map keyed by item ID made lookups constant time: 40 ms down to under 1 ms.'),
      ],
    },
    internship: { role: 'Software Engineer Intern - Games', about: 'Six months on a game engineering team in Hyderabad.', workMode: 'OFFICE', city: 'Hyderabad', months: 6, stipend: 50000 },
  },
];

// ---------------------------------------------------------------------------
// Programmes and students
// ---------------------------------------------------------------------------

const FIRST = ['Aarav', 'Ananya', 'Ishaan', 'Diya', 'Vihaan', 'Saanvi', 'Arjun', 'Kavya', 'Reyansh', 'Isha', 'Aditya', 'Mira', 'Kabir', 'Riya', 'Omkar', 'Tanvi', 'Yash', 'Shruti', 'Pranav', 'Gauri', 'Siddharth', 'Nikita', 'Harsh', 'Pooja', 'Manas', 'Sakshi', 'Varun', 'Rutuja', 'Tejas', 'Mrunal'];
const FEMALE = ['Ananya', 'Diya', 'Saanvi', 'Kavya', 'Isha', 'Mira', 'Riya', 'Tanvi', 'Shruti', 'Gauri', 'Nikita', 'Pooja', 'Sakshi', 'Rutuja', 'Mrunal', 'Aditi', 'Prachi', 'Vaishnavi'];
const LAST = ['Joshi', 'Deshpande', 'Kulkarni', 'Patil', 'Gokhale', 'Bhosale', 'Shinde', 'Pawar', 'Jadhav', 'Kale', 'Gaikwad', 'Mane', 'Sathe', 'Chavan', 'Apte', 'Phadke', 'More', 'Naik', 'Sawant', 'Ranade'];
/** The academic year is 2026-27: final-year students pass out in 2027. */
const FINAL_YEAR = 2027;
const CITIES = ['Pune', 'Pune', 'Pune', 'Pimpri-Chinchwad', 'Nashik', 'Ahmednagar', 'Satara', 'Kolhapur', 'Solapur', 'Aurangabad'];

/** How long each course runs and at what level - the master list had some of these wrong. */
const COURSE_FACTS: Record<string, { level: 'UG' | 'PG'; years: number }> = {
  'B.Tech': { level: 'UG', years: 4 },
  'B.E.': { level: 'UG', years: 4 },
  'B.Sc': { level: 'UG', years: 3 },
  'B.Com': { level: 'UG', years: 3 },
  'M.Tech': { level: 'PG', years: 2 },
  MCA: { level: 'PG', years: 2 },
  MBA: { level: 'PG', years: 2 },
};

/** Which programmes each SPPU college runs (course / specialisation), with the yearly intake. */
const COLLEGE_PROGRAMMES: Record<string, [string, string, number][]> = {
  'Pune Institute of Computer Technology': [['B.Tech', 'Computer Science', 120], ['B.Tech', 'Information Technology', 120], ['B.Tech', 'Electronics and Telecommunication', 120]],
  'Vishwakarma Institute of Technology': [['B.Tech', 'Computer Science', 120], ['B.Tech', 'Mechanical Engineering', 120]],
  'Cummins College of Engineering for Women': [['B.Tech', 'Computer Science', 120], ['B.Tech', 'Information Technology', 60], ['B.Tech', 'Electronics and Telecommunication', 60], ['M.Tech', 'Computer Science', 18]],
  'AISSMS College of Engineering': [['B.Tech', 'Information Technology', 60], ['B.Tech', 'Computer Science', 120], ['B.Tech', 'Mechanical Engineering', 60], ['M.Tech', 'Data Science', 18]],
  'Sinhgad College of Engineering': [['B.Tech', 'Electronics and Telecommunication', 120], ['B.Tech', 'Computer Science', 120], ['B.Tech', 'Mechanical Engineering', 120], ['MCA', 'Computer Science', 60]],
  'PVG College of Engineering and Technology': [['B.Tech', 'Mechanical Engineering', 60], ['B.Tech', 'Computer Science', 120], ['B.Tech', 'Information Technology', 60], ['MBA', 'Finance', 60]],
  'Modern Education Society College of Engineering': [['B.Tech', 'Civil', 60], ['B.Tech', 'Computer Science', 120], ['B.Tech', 'Electronics and Telecommunication', 60], ['MBA', 'Marketing', 60]],
};

/** The short name a batch carries for a programme. */
const SHORT: Record<string, string> = {
  'B.Tech/Computer Science': 'CSE',
  'B.Tech/Information Technology': 'IT',
  'B.Tech/Electronics and Telecommunication': 'ENTC',
  'B.Tech/Mechanical Engineering': 'MECH',
  'B.Tech/Civil': 'CIVIL',
  'M.Tech/Computer Science': 'MTECH CSE',
  'M.Tech/Data Science': 'MTECH DS',
  'MCA/Computer Science': 'MCA',
  'MBA/Finance': 'MBA FIN',
  'MBA/Marketing': 'MBA MKT',
};

/** The work a student of each specialisation is most drawn to, for their interests and their simulations. */
const LEANS: Record<string, string[]> = {
  'Computer Science': ['Software', 'Data', 'Cybersecurity'],
  'Information Technology': ['Software', 'Cybersecurity', 'Data'],
  'Electronics and Telecommunication': ['Engineering', 'Technology', 'Software'],
  'Mechanical Engineering': ['Engineering', 'Operations', 'Technology'],
  Civil: ['Operations', 'Engineering', 'Consulting'],
  'Data Science': ['Data', 'Technology', 'Software'],
  Finance: ['Finance', 'Consulting', 'Data'],
  Marketing: ['Consulting', 'Data', 'Operations'],
};

interface Programme {
  id: string;
  collegeId: string;
  course: string;
  specialisation: string;
  level: 'UG' | 'PG';
  years: number;
}
interface Tidy {
  colleges: { id: string; name: string; code: string }[];
  programmes: Programme[];
}

/** Fix the course levels, and give every SPPU college the programmes it runs. */
async function tidyProgrammes(tenantId: string): Promise<Tidy> {
  for (const [name, f] of Object.entries(COURSE_FACTS)) {
    await prisma.course.updateMany({ where: { name }, data: { level: f.level, years: f.years } });
  }
  const colleges = await prisma.college.findMany({ where: { tenantId }, select: { id: true, name: true, code: true } });
  const programmes: Programme[] = [];
  for (const college of colleges) {
    for (const [courseName, specName, intake] of COLLEGE_PROGRAMMES[college.name] ?? []) {
      const course = await prisma.course.findUniqueOrThrow({ where: { name: courseName } });
      const spec = await prisma.specialisation.findFirstOrThrow({ where: { courseId: course.id, name: specName } });
      const existing = await prisma.collegeProgram.findFirst({ where: { collegeId: college.id, courseId: course.id, specialisationId: spec.id } });
      const row = existing
        ? await prisma.collegeProgram.update({ where: { id: existing.id }, data: { intake } })
        : await prisma.collegeProgram.create({ data: { collegeId: college.id, courseId: course.id, specialisationId: spec.id, intake } });
      // The university offers it too, so its own lists agree.
      await prisma.tenantProgram.upsert({
        where: { tenantId_courseId_specialisationId: { tenantId, courseId: course.id, specialisationId: spec.id } },
        create: { tenantId, courseId: course.id, specialisationId: spec.id },
        update: {},
      });
      const f = COURSE_FACTS[courseName]!;
      programmes.push({ id: row.id, collegeId: college.id, course: courseName, specialisation: specName, level: f.level, years: f.years });
    }
  }
  return { colleges, programmes };
}

/** The batch for one programme and passing year, made if it is not there. */
async function batchFor(tenantId: string, p: Programme, year: number) {
  const name = `${SHORT[`${p.course}/${p.specialisation}`] ?? p.specialisation} ${year}`;
  return prisma.batch.upsert({
    where: { collegeId_name: { collegeId: p.collegeId, name } },
    create: {
      collegeId: p.collegeId,
      tenantId,
      name,
      course: p.course,
      specialisation: p.specialisation,
      graduationYear: year,
      // In 2026-27 the final year passes out in 2027.
      studyYear: Math.min(p.years, Math.max(1, p.years - (year - FINAL_YEAR))),
    },
    update: { course: p.course, specialisation: p.specialisation, graduationYear: year },
  });
}

const demoPhone = () => `90000${String(between(10000, 99999))}`;
const leansFor = (spec: string | null) => LEANS[spec ?? ''] ?? ['Software', 'Data'];
function interestsFor(spec: string | null) {
  const l = leansFor(spec);
  return rnd() < 0.5 ? [l[0]!, l[1]!] : [l[0]!, l[2]!];
}

/** Students for the colleges that had none: in each programme, final-year and pre-final-year batches. */
async function addStudents(tenantId: string, passwordHash: string, tidy: Tidy) {
  let made = 0;
  for (const college of tidy.colleges) {
    const have = await prisma.candidate.count({ where: { collegeId: college.id, user: { email: { not: { endsWith: DOMAIN } } } } });
    if (have >= 5) continue;
    const code = college.code.toLowerCase().replace(/[^a-z0-9]/g, '');
    const women = /cummins/i.test(college.name);
    for (const prog of tidy.programmes.filter((p) => p.collegeId === college.id)) {
      // Final year and the year below: five and three on a B.Tech, four and two on a PG course.
      const plan: [number, number][] = prog.level === 'UG' ? [[FINAL_YEAR, 5], [FINAL_YEAR + 1, 3]] : [[FINAL_YEAR, 4], [FINAL_YEAR + 1, 2]];
      for (const [year, count] of plan) {
        const batch = await batchFor(tenantId, prog, year);
        for (let n = 0; n < count; n++) {
          const names = women ? FEMALE : FIRST;
          const first = names[(made * 7 + n) % names.length]!;
          const last = LAST[(made * 3 + n * 5) % LAST.length]!;
          const joined = between(5, 90);
          const user = await prisma.user.create({
            data: {
              email: `${first}.${last}${made}@${code}.${DOMAIN}`.toLowerCase(),
              fullName: `${first} ${last}`,
              passwordHash,
              role: Role.CANDIDATE,
              phone: demoPhone(),
              lastLoginAt: ago(between(0, 20)),
              createdAt: ago(joined),
            },
          });
          const candidate = await prisma.candidate.create({
            data: {
              userId: user.id,
              collegeId: college.id,
              collegeProgramId: prog.id,
              degreeLevel: prog.level,
              course: prog.course,
              specialisation: prog.specialisation,
              graduationYear: year,
              startYear: year - prog.years,
              city: pick(CITIES),
              phone: user.phone,
              gender: FEMALE.includes(first) ? 'Female' : 'Male',
              cgpa: (6.5 + rnd() * 3).toFixed(2),
              interests: interestsFor(prog.specialisation),
              createdAt: ago(joined),
            },
          });
          await prisma.batchMembership.create({
            data: { batchId: batch.id, candidateId: candidate.id, isFrozen: true, verifiedAt: ago(between(1, Math.max(2, joined - 1))) },
          });
          made++;
        }
      }
    }
  }
  return made;
}

/**
 * Every existing SPPU student made whole: in one of their college's
 * programmes and its batch, with a level, a start year, a city, a phone and
 * interests. Students whose recorded course their college does not run are
 * moved to the nearest programme it does. The 2025 batch, already graduated
 * by now, becomes the 2027 batch.
 */
async function tidyStudents(tenantId: string, tidy: Tidy) {
  // Batches that have already passed out are no use to a demo of current
  // students: the class of 2026 becomes the final year (2027), and 2025 the
  // year below (2028).
  for (const [from, to] of [[2026, FINAL_YEAR], [2025, FINAL_YEAR + 1]] as const) {
    for (const old of await prisma.batch.findMany({ where: { tenantId, graduationYear: from } })) {
      const name = old.name.replace(String(from), String(to));
      if (await prisma.batch.findFirst({ where: { collegeId: old.collegeId, name } })) continue;
      await prisma.batch.update({ where: { id: old.id }, data: { name, graduationYear: to, studyYear: 4 - (to - FINAL_YEAR) } });
    }
  }

  const students = await prisma.candidate.findMany({
    where: { collegeId: { in: tidy.colleges.map((c) => c.id) }, user: { email: { not: { endsWith: DOMAIN } } } },
    select: {
      id: true,
      collegeId: true,
      course: true,
      specialisation: true,
      graduationYear: true,
      phone: true,
      city: true,
      interests: true,
      gender: true,
      user: { select: { phone: true } },
      batchMemberships: { select: { id: true, batch: { select: { id: true, name: true, graduationYear: true, course: true, specialisation: true } } } },
    },
  });
  let fixed = 0;
  for (const s of students) {
    const mine = tidy.programmes.filter((p) => p.collegeId === s.collegeId);
    if (!mine.length) continue;
    const norm = (x: string | null) => (x ?? '').toLowerCase();
    const batch = s.batchMemberships[0]?.batch;
    // Their programme: the one they are recorded in, or the closest one the college runs.
    const prog =
      mine.find((p) => norm(p.course) === norm(s.course) && norm(p.specialisation) === norm(s.specialisation)) ??
      mine.find((p) => norm(s.course).includes('information technology') && p.specialisation === 'Information Technology') ??
      mine.find((p) => norm(s.course).includes('mechanical') && p.specialisation === 'Mechanical Engineering') ??
      mine.find((p) => p.course === 'B.Tech' && p.specialisation === 'Computer Science') ??
      mine[0]!;
    let year = batch?.graduationYear ?? s.graduationYear ?? FINAL_YEAR;
    if (year === 2026) year = FINAL_YEAR;
    if (year < 2026) year = FINAL_YEAR + 1;
    if (year > FINAL_YEAR + prog.years - 1) year = FINAL_YEAR + 1;
    const inRightBatch =
      batch && batch.name !== 'Unassigned' && batch.course === prog.course && batch.specialisation === prog.specialisation && batch.graduationYear === year;
    const target = inRightBatch ? batch : await batchFor(tenantId, prog, year);
    if (!inRightBatch) {
      if (s.batchMemberships[0]) {
        await prisma.batchMembership.update({ where: { id: s.batchMemberships[0].id }, data: { batchId: target.id, isFrozen: true, verifiedAt: ago(between(5, 40)) } });
      } else {
        await prisma.batchMembership.create({ data: { batchId: target.id, candidateId: s.id, isFrozen: true, verifiedAt: ago(between(5, 40)) } });
      }
    }
    const phone = s.phone ?? s.user.phone ?? demoPhone();
    await prisma.candidate.update({
      where: { id: s.id },
      data: {
        collegeProgramId: prog.id,
        degreeLevel: prog.level,
        course: prog.course,
        specialisation: prog.specialisation,
        graduationYear: year,
        startYear: year - prog.years,
        city: s.city ?? pick(CITIES),
        phone,
        interests: Array.isArray(s.interests) && (s.interests as unknown[]).length ? s.interests : interestsFor(prog.specialisation),
      },
    });
    fixed++;
  }

  // The two students who signed up on their own: complete their records too.
  for (const s of await prisma.candidate.findMany({ where: { collegeId: null, batchMemberships: { none: {} } }, select: { id: true, course: true } })) {
    await prisma.candidate.update({
      where: { id: s.id },
      data: { degreeLevel: 'UG', course: s.course ?? 'B.Sc', specialisation: 'Computer Science', startYear: 2025, graduationYear: 2028, city: 'Pune', interests: ['Software', 'Data'] },
    });
  }
  return fixed;
}

// ---------------------------------------------------------------------------

async function main() {
  const sppu = await prisma.tenant.findUnique({ where: { slug: 'sppu' }, select: { id: true, name: true } });
  if (!sppu) throw new Error('No tenant with slug "sppu". Run the main seed first.');

  // 1. Only SPPU.
  const others = await prisma.tenant.findMany({ where: { slug: { not: 'sppu' } }, select: { id: true, name: true } });
  for (const o of others) {
    await prisma.tenant.delete({ where: { id: o.id } });
    console.log(`removed institution: ${o.name}`);
  }

  // Clear what the last run of this script added.
  const names = COMPANIES.map((c) => c.name);
  await prisma.company.deleteMany({ where: { name: { in: names } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await prisma.batch.deleteMany({ where: { tenantId: sppu.id, course: 'B.E.', memberships: { none: {} } } });

  const passwordHash = await hashPassword(PASSWORD);
  const ownerRole = await prisma.platformRole.findUniqueOrThrow({ where: { key: 'company.owner' } });

  // 2. Companies, recruiters, simulations and interview processes.
  interface Built {
    def: CompanyDef;
    id: string;
    recruiterId: string;
    simId: string;
    tasks: { id: string; def: TaskDef }[];
    processId: string;
    rounds: { order: number; name: string }[];
  }
  const built: Built[] = [];
  const reviewer = await prisma.user.findFirst({ where: { role: Role.ADMIN }, select: { id: true } });

  for (const [i, c] of COMPANIES.entries()) {
    const company = await prisma.company.create({
      data: {
        name: c.name,
        legalName: c.legalName,
        website: c.website,
        careersUrl: c.website,
        industryOther: c.industry,
        sizeBand: 'ENTERPRISE',
        headline: c.headline,
        about: c.about,
        city: c.city,
        state: c.state,
        status: 'VERIFIED',
        reviewedAt: ago(120 - i),
        reviewedById: reviewer?.id ?? null,
        createdAt: ago(130 - i),
      },
    });
    const [fullName, box] = c.recruiter;
    const recruiter = await prisma.user.create({
      data: { email: `${box}@${c.key}.${DOMAIN}`, fullName, passwordHash, role: Role.COMPANY, lastLoginAt: ago(between(0, 3)) },
    });
    await prisma.companyMember.create({ data: { userId: recruiter.id, companyId: company.id, roleId: ownerRole.id } });

    const sim = await prisma.workSimulation.create({
      data: {
        slug: c.sim.slug,
        companyId: company.id,
        title: c.sim.title,
        summary: c.sim.summary,
        about: c.sim.about,
        field: c.sim.field,
        level: c.sim.level,
        hours: c.sim.hours,
        skills: c.sim.skills,
        status: WorkSimulationStatus.LIVE,
        submittedAt: ago(110 - i * 3),
        reviewedAt: ago(105 - i * 3),
        publishedAt: ago(100 - i * 3),
        createdById: recruiter.id,
      },
    });
    const tasks = [];
    for (const [pos, td] of c.sim.tasks.entries()) {
      const task = await prisma.workSimulationTask.create({
        data: {
          simulationId: sim.id,
          position: pos + 1,
          title: td.title,
          brief: td.brief,
          handIn: td.handIn,
          minutes: td.minutes,
          learn: td.learn,
          steps: td.steps,
        },
      });
      tasks.push({ id: task.id, def: td });
    }

    // Every company interviews the same way: a CV screen, a recorded
    // interview, then a live one with the team.
    const process = await prisma.interviewProcess.create({
      data: {
        companyId: company.id,
        createdById: recruiter.id,
        title: `${c.internship.role} - 2026`,
        description: `How ${c.name} interviews for the ${c.internship.role} role.`,
        processType: 'INTERNSHIP',
        status: 'ACTIVE',
      },
    });
    const roundDefs = [
      { order: 1, name: 'Profile and simulation review', type: 'RESUME_SCREEN', isElimination: true, durationMin: null as number | null },
      { order: 2, name: 'Recorded video interview', type: 'VIDEO_INTERVIEW', isElimination: false, durationMin: 20 },
      { order: 3, name: 'Live interview with the team', type: 'LIVE_INTERVIEW', isElimination: true, durationMin: 45 },
    ];
    for (const r of roundDefs) {
      const round = await prisma.interviewProcessRound.create({
        data: {
          processId: process.id,
          order: r.order,
          name: r.name,
          type: r.type,
          isElimination: r.isElimination,
          isOnline: true,
          durationMin: r.durationMin,
          meetingLink: r.type === 'LIVE_INTERVIEW' ? `https://meet.${DOMAIN}/${c.key}-interview` : null,
          questionTimeSec: r.type === 'VIDEO_INTERVIEW' ? 90 : null,
          prepTimeSec: r.type === 'VIDEO_INTERVIEW' ? 30 : null,
          simulationId: r.order === 1 ? sim.id : null,
          description:
            r.order === 1
              ? `We read your profile and your work on our ${c.sim.title} simulation.`
              : r.order === 2
                ? 'Three questions, recorded in your own time. Ninety seconds each.'
                : 'Forty-five minutes with two people from the team you would join.',
        },
      });
      if (r.type === 'VIDEO_INTERVIEW') {
        const qs = [
          `Walk us through one task from the ${c.sim.title} simulation and what you would do differently.`,
          'Tell us about a time you had to learn something quickly.',
          `Why ${c.name}, and why this role?`,
        ];
        for (const [qi, text] of qs.entries()) {
          await prisma.videoInterviewQuestion.create({
            data: { roundId: round.id, order: qi + 1, text, type: qi === 0 ? 'technical' : 'behavioural' },
          });
        }
      }
    }

    built.push({
      def: c,
      id: company.id,
      recruiterId: recruiter.id,
      simId: sim.id,
      tasks,
      processId: process.id,
      rounds: roundDefs.map((r) => ({ order: r.order, name: r.name })),
    });
  }
  console.log(`added ${built.length} companies, simulations and interview processes`);

  // 3. Programmes and students, so every student sits in a programme their
  //    college actually runs, in a batch for that programme and year.
  const tidy = await tidyProgrammes(sppu.id);
  const made = await addStudents(sppu.id, passwordHash, tidy);
  const fixed = await tidyStudents(sppu.id, tidy);
  console.log(`programmes set for ${tidy.colleges.length} colleges; added ${made} students; tidied ${fixed} existing students`);

  // A suspended or rejected company's simulations are not open to students,
  // and the test fixtures are not part of the demo.
  const retired = await prisma.workSimulation.updateMany({
    where: {
      status: WorkSimulationStatus.LIVE,
      OR: [{ company: { status: { not: 'VERIFIED' } } }, { title: { in: ['Every kind of question', 'Practice draft - edit me'] } }],
    },
    data: { status: WorkSimulationStatus.RETIRED },
  });
  const emptied = await prisma.batch.deleteMany({ where: { tenantId: sppu.id, name: 'Unassigned', memberships: { none: {} } } });
  console.log(`retired ${retired.count} simulations that should not be live; removed ${emptied.count} empty batches`);

  // 4. Students at every stage.
  const students = await prisma.candidate.findMany({
    where: {
      OR: [{ college: { tenantId: sppu.id } }, { collegeId: null, batchMemberships: { some: { batch: { tenantId: sppu.id } } } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, specialisation: true, user: { select: { email: true, fullName: true } } },
  });
  const by = (key: string) => built.find((b) => b.def.key === key)!;
  const usedCodes = new Set<string>();
  const code = () => {
    const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    do s = `APLI-${Array.from({ length: 4 }, () => pick([...a])).join('')}-${Array.from({ length: 4 }, () => pick([...a])).join('')}`;
    while (usedCodes.has(s));
    usedCodes.add(s);
    return s;
  };

  const counts = { runs: 0, certified: 0, offers: 0, invites: 0, notes: 0 };

  async function note(userId: string, type: string, title: string, body: string, link: string, when: Date) {
    await prisma.notification.create({ data: { userId, type, title, body, link, createdAt: when } });
    counts.notes++;
  }

  /** One student's go at one company's simulation, in the given state. */
  async function run(
    s: (typeof students)[number],
    b: Built,
    status: RunStatus,
    opts: { startedDaysAgo?: number; share?: boolean; rate?: boolean } = {},
  ) {
    const started = opts.startedDaysAgo ?? between(8, 70);
    const all = b.tasks.length;
    const handedIn = status === RunStatus.ACTIVE ? between(0, all - 1) : status === RunStatus.LEFT ? between(0, 1) : all;
    const submitted = status === RunStatus.IN_REVIEW || status === RunStatus.NEEDS_WORK || status === RunStatus.COMPLETED;
    const submittedDaysAgo = Math.max(1, Math.floor(started * 0.4));
    const reviewedDaysAgo = Math.max(0, submittedDaysAgo - between(1, 3));
    const lastActive = submitted ? submittedDaysAgo : status === RunStatus.LEFT ? Math.floor(started * 0.8) : between(0, Math.min(10, started));
    const startedAt = ago(started);
    const after = (d: Date) => (d < startedAt ? new Date(startedAt.getTime() + between(1, 6) * 3600 * 1000) : d);
    const lastActiveAt = after(ago(lastActive, between(1, 10)));
    const r = await prisma.workSimulationRun.create({
      data: {
        simulationId: b.simId,
        candidateId: s.id,
        status,
        startedAt,
        lastActiveAt,
        submittedAt: submitted ? ago(submittedDaysAgo) : null,
        explainHow: submitted
          ? `I started by reading the brief twice and listing what the ${b.def.sim.title.toLowerCase()} work had to answer. Then I worked task by task, checking each result against the one before.`
          : null,
        explainChange: submitted ? 'With more time I would test my answers against a second dataset and ask the team what they would have done differently.' : null,
        reviewedAt: status === RunStatus.COMPLETED || status === RunStatus.NEEDS_WORK ? ago(reviewedDaysAgo) : null,
        reviewedById: status === RunStatus.COMPLETED || status === RunStatus.NEEDS_WORK ? b.recruiterId : null,
        reviewNote:
          status === RunStatus.NEEDS_WORK
            ? pick([
                'Good start. Your last task needs the numbers behind the recommendation - add them and send it back.',
                'Your analysis is right but the hand-in for task 2 is missing the file. Please attach it.',
                'Clear writing. Show how you got to the final figure so we can check it.',
              ])
            : status === RunStatus.COMPLETED
              ? pick(['Excellent, well-structured work.', 'Clear and to the point - exactly what we look for.', 'Strong analysis and a confident recommendation.', null])
              : null,
        completedAt: status === RunStatus.COMPLETED ? ago(reviewedDaysAgo) : null,
        certificateCode: status === RunStatus.COMPLETED ? code() : null,
      },
    });
    for (const task of b.tasks.slice(0, handedIn)) {
      await prisma.workSimulationTaskDone.create({
        data: {
          runId: r.id,
          taskId: task.id,
          answer: task.def.answer,
          link: rnd() < 0.4 ? `https://docs.${DOMAIN}/${b.def.key}/${r.id.slice(-6)}` : null,
          doneAt: after(ago(lastActive, between(1, 20))),
        },
      });
    }
    counts.runs++;
    if (status === RunStatus.COMPLETED) {
      counts.certified++;
      await note(s.userId, 'SIMULATION_APPROVED', `Your work on ${b.def.sim.title} is approved`, 'Your certificate is ready to share.', '/student/certificates', ago(reviewedDaysAgo));
      if (opts.rate ?? rnd() < 0.6) {
        await prisma.workSimulationReview.create({
          data: { runId: r.id, stars: pick([4, 5, 5, 5, 4, 3]), comment: pick(['Felt like real work.', 'Hard but worth it.', 'Learned more than in a semester of theory.', null]) },
        });
      }
      if (opts.share ?? rnd() < 0.7) {
        await prisma.workSimulationShare.create({ data: { runId: r.id, companyId: b.id, createdAt: ago(Math.max(0, reviewedDaysAgo - 1)) } });
        // Some share with a second company too.
        if (rnd() < 0.3) {
          const other = pick(built.filter((x) => x.id !== b.id));
          await prisma.workSimulationShare.create({ data: { runId: r.id, companyId: other.id } });
        }
      }
    }
    if (status === RunStatus.NEEDS_WORK) {
      await note(s.userId, 'SIMULATION_CHANGES', `Changes asked on ${b.def.sim.title}`, 'Your reviewer left a note on what to fix.', `/student/simulations/${b.def.sim.slug}`, ago(reviewedDaysAgo));
    }
    return r;
  }

  /** An internship offer on the back of a certified run. */
  async function offer(s: (typeof students)[number], b: Built, runId: string, kind: 'open' | 'accepted' | 'declined' | 'withdrawn' | 'lapsed') {
    const i = b.def.internship;
    const sent = kind === 'open' ? between(1, 4) : between(10, 30);
    const status =
      kind === 'accepted' ? InternshipOfferStatus.ACCEPTED
        : kind === 'declined' ? InternshipOfferStatus.DECLINED
          : kind === 'withdrawn' ? InternshipOfferStatus.WITHDRAWN
            : InternshipOfferStatus.SENT;
    await prisma.workSimulationShare.upsert({
      where: { runId_companyId: { runId, companyId: b.id } },
      create: { runId, companyId: b.id },
      update: {},
    });
    await prisma.internshipOffer.create({
      data: {
        companyId: b.id,
        candidateId: s.id,
        runId,
        sentById: b.recruiterId,
        role: i.role,
        about: i.about,
        workMode: i.workMode,
        city: i.city,
        months: i.months,
        stipend: i.stipend,
        startsOn: ahead(between(30, 75)),
        respondBy: kind === 'lapsed' ? ago(between(2, 8)) : kind === 'open' ? ahead(between(4, 10)) : ago(sent - 5),
        noFeeAt: ago(sent),
        status,
        respondedAt: kind === 'accepted' || kind === 'declined' ? ago(sent - between(1, 4)) : null,
        studentNote: kind === 'declined' ? 'Thank you - I have accepted another internship for the same months.' : kind === 'accepted' ? 'Thank you, I am excited to join!' : null,
        createdAt: ago(sent),
      },
    });
    counts.offers++;
    await note(s.userId, 'INTERNSHIP_OFFER', `${b.def.name} offered you an internship`, `${i.role}, ${i.months} month${i.months === 1 ? '' : 's'}.`, '/student/jobs', ago(sent));
  }

  /** An interview invitation, stopped at the given point. */
  async function invite(
    s: (typeof students)[number],
    b: Built,
    kind: 'pending' | 'round1' | 'round2' | 'round3' | 'offered' | 'rejected' | 'declined',
  ) {
    const sent = kind === 'pending' ? between(0, 3) : between(6, 25);
    const status =
      kind === 'pending' ? 'PENDING'
        : kind === 'offered' ? 'OFFERED'
          : kind === 'rejected' ? 'REJECTED'
            : kind === 'declined' ? 'DECLINED'
              : 'ACCEPTED';
    const round = kind === 'round2' ? 2 : kind === 'round3' ? 3 : kind === 'offered' ? 3 : kind === 'rejected' ? between(1, 3) : 1;
    const inv = await prisma.interviewInvite.create({
      data: {
        companyId: b.id,
        candidateId: s.id,
        processId: b.processId,
        sentById: b.recruiterId,
        role: b.def.internship.role,
        message: `We liked your work on our ${b.def.sim.title} simulation and would like to interview you for ${b.def.internship.role}.`,
        status,
        currentRoundOrder: round,
        respondedAt: kind === 'pending' ? null : ago(sent - 1),
        createdAt: ago(sent),
        updatedAt: ago(Math.max(0, sent - between(1, 5))),
      },
    });
    // A verdict on every round they have finished.
    const passedUpTo = kind === 'offered' ? 3 : kind === 'rejected' ? round - 1 : status === 'ACCEPTED' ? round - 1 : 0;
    for (const r of b.rounds.filter((r) => r.order <= passedUpTo)) {
      await prisma.interviewRoundFeedback.create({
        data: {
          inviteId: inv.id,
          roundOrder: r.order,
          roundName: r.name,
          outcome: 'PASSED',
          score: between(70, 95),
          notes: pick(['Clear thinker, good communication.', 'Strong on the technical questions.', 'Well prepared; knew our work.', 'Good energy, asked sharp questions.']),
        },
      });
    }
    if (kind === 'rejected') {
      const r = b.rounds.find((x) => x.order === round)!;
      await prisma.interviewRoundFeedback.create({
        data: { inviteId: inv.id, roundOrder: r.order, roundName: r.name, outcome: 'FAILED', score: between(35, 55), notes: 'Not the right fit for this role right now.' },
      });
    }
    counts.invites++;
    await note(s.userId, 'INTERVIEW_INVITE', `${b.def.name} invited you to interview`, b.def.internship.role, '/student/interviews', ago(sent));
  }

  // The named demo logins: each one shows a different story.
  const named = (local: string) => students.find((s) => s.user.email.startsWith(`${local}@`));
  const story: [string, (s: (typeof students)[number]) => Promise<void>][] = [
    // Certified, sharing, with an offer to accept right now.
    ['karan.iyer5', async (s) => {
      const r = await run(s, by('jpmorgan'), RunStatus.COMPLETED, { startedDaysAgo: 30, share: true, rate: true });
      await offer(s, by('jpmorgan'), r.id, 'open');
      await run(s, by('accenture'), RunStatus.ACTIVE, { startedDaysAgo: 6 });
    }],
    // Accepted an internship.
    ['neha.nair6', async (s) => {
      const r = await run(s, by('bcg'), RunStatus.COMPLETED, { startedDaysAgo: 50, share: true, rate: true });
      await invite(s, by('bcg'), 'offered');
      await offer(s, by('bcg'), r.id, 'accepted');
      await run(s, by('tata'), RunStatus.COMPLETED, { startedDaysAgo: 40, share: true });
    }],
    // The busiest student: something in every state.
    ['atharva.wagh.21', async (s) => {
      const r = await run(s, by('goldman'), RunStatus.COMPLETED, { startedDaysAgo: 60, share: true });
      await offer(s, by('goldman'), r.id, 'declined');
      await run(s, by('bofa'), RunStatus.IN_REVIEW, { startedDaysAgo: 12 });
      const m = await run(s, by('mastercard'), RunStatus.COMPLETED, { startedDaysAgo: 35, share: true });
      void m;
      await invite(s, by('mastercard'), 'round2');
      await run(s, by('ea'), RunStatus.COMPLETED, { startedDaysAgo: 28, share: true });
      await invite(s, by('ea'), 'pending');
      await run(s, by('pwc'), RunStatus.ACTIVE, { startedDaysAgo: 4 });
    }],
    // Mid-interview, and asked to fix a hand-in.
    ['sneha.patil2', async (s) => {
      await run(s, by('accenture'), RunStatus.COMPLETED, { startedDaysAgo: 40, share: true });
      await invite(s, by('accenture'), 'round3');
      await run(s, by('pwc'), RunStatus.NEEDS_WORK, { startedDaysAgo: 15 });
    }],
    // Just started.
    ['rahul.kulkarni9', async (s) => {
      await run(s, by('jpmorgan'), RunStatus.ACTIVE, { startedDaysAgo: 1 });
    }],
    // Interviewed all the way through to an offer.
    ['aditi.rane0', async (s) => {
      await run(s, by('deloitte'), RunStatus.COMPLETED, { startedDaysAgo: 45, share: true });
      await invite(s, by('deloitte'), 'offered');
      await run(s, by('tata'), RunStatus.IN_REVIEW, { startedDaysAgo: 9 });
    }],
  ];
  const storied = new Set<string>();
  for (const [local, fn] of story) {
    const s = named(local);
    if (!s) {
      console.log(`  (no student ${local}; skipped their story)`);
      continue;
    }
    await fn(s);
    storied.add(s.id);
  }

  // Everyone else: a realistic spread.
  const offerKinds = ['open', 'accepted', 'accepted', 'declined', 'withdrawn', 'lapsed', 'open', 'accepted'] as const;
  const inviteKinds = ['pending', 'round1', 'round2', 'round3', 'offered', 'rejected', 'declined', 'round2', 'pending'] as const;
  let o = 0;
  let v = 0;
  for (const s of students) {
    if (storied.has(s.id)) continue;
    if (rnd() < 0.22) continue; // signed up, not started yet
    const howMany = rnd() < 0.55 ? 1 : rnd() < 0.75 ? 2 : 3;
    // Mostly simulations that suit what they study; now and then something else.
    const leans = leansFor(s.specialisation);
    const ranked = [...built].sort((x, y) => {
      const fit = (b: Built) => (leans.includes(b.def.sim.field) ? 0 : 1) + rnd() * 0.9;
      return fit(x) - fit(y);
    });
    const chosen = ranked.slice(0, howMany);
    for (const b of chosen) {
      const x = rnd();
      const status =
        x < 0.3 ? RunStatus.ACTIVE
          : x < 0.43 ? RunStatus.IN_REVIEW
            : x < 0.5 ? RunStatus.NEEDS_WORK
              : x < 0.95 ? RunStatus.COMPLETED
                : RunStatus.LEFT;
      const r = await run(s, b, status);
      if (status !== RunStatus.COMPLETED) continue;
      const y = rnd();
      if (y < 0.22) await offer(s, b, r.id, offerKinds[o++ % offerKinds.length]!);
      else if (y < 0.45) await invite(s, b, inviteKinds[v++ % inviteKinds.length]!);
    }
  }

  console.log(
    `student activity: ${counts.runs} simulation runs, ${counts.certified} certificates, ${counts.offers} internship offers, ${counts.invites} interview invitations, ${counts.notes} notifications`,
  );

  // The companies' jobs, posted to SPPU's open placement drives.
  const jobs = await addShowcaseJobs();
  console.log(`jobs: ${jobs.made}, posted to ${jobs.posted} placement drives`);

  // One notification per thing that happened, rebuilt from the data, so a
  // re-run never piles up copies; older than a week counts as already seen.
  const notes = await rebuildDemoNotifications();
  console.log(`notifications: ${notes.total} (${notes.unread} new from the last week)`);

  console.log('\nRecruiter logins (password ' + PASSWORD + '):');
  for (const b of built) console.log(`  ${b.def.recruiter[1]}@${b.def.key}.${DOMAIN}  -  ${b.def.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(disconnectPrisma);
