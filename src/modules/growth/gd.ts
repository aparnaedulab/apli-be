import { OFF_LIMITS, wordsOf, type Improvement } from '../mockInterview/feedback.js';

/**
 * The group discussion simulator, without AI.
 *
 * A GD is the round Indian campus hiring leans on most and the one a student
 * can least practise alone - you need a group. So the group is simulated: four
 * participants, each a type every student meets on the day (the one who talks
 * over everybody, the one who barely speaks, the one who wanders off the
 * topic, the one who wants numbers). Their lines come from a bank written per
 * topic, lightly templated so a discussion reads as a discussion. With an API
 * key, Claude plays them instead (see growthAi.ts); without one, this is it.
 *
 * Everything here is pure and seeded by the session id, so the same session
 * always plays out the same way - which is what lets it be tested.
 */

export type TopicType = 'TECH' | 'SOCIAL' | 'BUSINESS' | 'ABSTRACT';

export interface GdTopic {
  id: string;
  title: string;
  type: TopicType;
  /** Points that support one side, and the other - what participants argue. */
  pro: string[];
  con: string[];
  /** What evidence would settle it - the data-minded participant asks for these. */
  evidence: string[];
}

export const TOPICS: GdTopic[] = [
  {
    id: 'ai-jobs',
    title: 'Will AI create more jobs than it takes away?',
    type: 'TECH',
    pro: [
      'every big technology shift so far has ended up creating new kinds of work',
      'someone has to build, check and maintain these AI systems',
      'cheaper tools let small businesses grow and hire',
    ],
    con: [
      'routine office work is exactly what AI does well, and a lot of first jobs are routine',
      'the new jobs need skills the people who lose the old ones may not have',
      'companies may use AI to do the same work with fewer people rather than grow',
    ],
    evidence: ['how hiring for entry-level roles has changed in the last two years', 'which tasks inside a job AI actually takes over'],
  },
  {
    id: 'wfh',
    title: 'Should freshers start their careers working from home?',
    type: 'BUSINESS',
    pro: [
      'it saves hours of commuting that could go into learning',
      'companies can hire talent from smaller towns, not just metros',
      'focused work is often easier at home',
    ],
    con: [
      'a fresher learns a lot just by sitting next to experienced people',
      'it is harder to ask a small question when everyone is on a call',
      'new joiners can feel invisible and miss out on good projects',
    ],
    evidence: ['how quickly remote freshers get productive compared with office freshers', 'how many new joiners leave in the first year'],
  },
  {
    id: 'social-media-age',
    title: 'Should there be a minimum age for social media?',
    type: 'SOCIAL',
    pro: [
      'young teenagers are more vulnerable to comparison and bullying online',
      'it gives parents a clear rule to point to',
      'platforms already have age limits that are simply not enforced',
    ],
    con: [
      'a ban is easy to get around and pushes children to less safe corners of the internet',
      'social media is also where young people learn, create and find communities',
      'teaching safe use may work better than keeping them away',
    ],
    evidence: ['what happened in countries that have tried age checks', 'how young users actually spend their time online'],
  },
  {
    id: 'ev-india',
    title: 'Is India ready for electric vehicles?',
    type: 'TECH',
    pro: [
      'two- and three-wheelers are a natural fit for short city trips',
      'running costs per kilometre are much lower',
      'less city air pollution is a direct public-health gain',
    ],
    con: [
      'charging infrastructure is thin outside big cities',
      'the upfront price is still higher for most families',
      'if electricity comes from coal, the pollution just moves elsewhere',
    ],
    evidence: ['how charging stations are spread across towns', 'the total cost of owning an EV over five years'],
  },
  {
    id: 'degree-vs-skills',
    title: 'Do skills matter more than degrees now?',
    type: 'BUSINESS',
    pro: [
      'many companies now test what you can do rather than where you studied',
      'the tools change faster than any syllabus',
      'a strong project often says more than a marksheet',
    ],
    con: [
      'a degree still decides who gets shortlisted at many companies',
      'a degree teaches fundamentals that short courses skip',
      'it is hard to judge skills fairly at scale without some common standard',
    ],
    evidence: ['how many companies have dropped degree requirements in practice', 'how skills-first hires perform after a year'],
  },
  {
    id: 'cashless',
    title: 'Should India move towards a fully cashless economy?',
    type: 'BUSINESS',
    pro: [
      'digital payments leave a record, which makes tax evasion harder',
      'UPI has already made small payments fast and free',
      'it reduces the cost and risk of handling cash',
    ],
    con: [
      'not everyone has a smartphone, a signal or a bank account',
      'older people and small vendors may be left out',
      'a system outage or fraud hits much harder when there is no cash to fall back on',
    ],
    evidence: ['who still relies on cash and why', 'how often digital payment failures affect people'],
  },
  {
    id: 'exams-vs-projects',
    title: 'Should colleges replace exams with projects?',
    type: 'SOCIAL',
    pro: [
      'projects test whether you can apply knowledge, not just remember it',
      'work life is mostly projects, not exams',
      'students tend to care more about something they built',
    ],
    con: [
      'projects are harder to grade fairly and consistently',
      'group projects can hide who actually did the work',
      'some subjects need the discipline of a proper exam',
    ],
    evidence: ['how students assessed by projects do in their first job', 'how consistent project grading is between teachers'],
  },
  {
    id: 'startups-vs-mnc',
    title: 'Is a startup a better first job than a large company?',
    type: 'BUSINESS',
    pro: [
      'you get real responsibility much earlier',
      'you see how the whole business works, not just one small part',
      'you learn to work with less structure, which is a skill in itself',
    ],
    con: [
      'large companies offer structured training and mentoring',
      'a startup can shut down, leaving you job-hunting early',
      'a known brand on your CV opens doors later',
    ],
    evidence: ['where people who started at startups are five years later', 'how many early-stage startups survive three years'],
  },
  {
    id: 'four-day-week',
    title: 'Should India try a four-day working week?',
    type: 'BUSINESS',
    pro: [
      'rested people often get more done in fewer hours',
      'it could help with burnout and mental health',
      'it may reduce commuting and office costs',
    ],
    con: [
      'many jobs - hospitals, shops, factories - cannot simply close a day',
      'the same work squeezed into four days can mean longer, harder days',
      'small businesses may not be able to afford it',
    ],
    evidence: ['results from companies that trialled it', 'which industries could run it without extra staff'],
  },
  {
    id: 'online-learning',
    title: 'Can online learning replace the classroom?',
    type: 'TECH',
    pro: [
      'good teaching can reach students anywhere, at any time',
      'students can replay what they did not understand',
      'it costs far less to reach many more people',
    ],
    con: [
      'many students drop out of online courses without a teacher checking in',
      'labs, discussions and friendships are hard to do online',
      'not every student has a quiet space and a stable connection',
    ],
    evidence: ['completion rates of online courses', 'how online and classroom students score on the same test'],
  },
  {
    id: 'success-luck',
    title: 'Is success more about luck than hard work?',
    type: 'ABSTRACT',
    pro: [
      'where you are born and who you meet shapes a lot of your chances',
      'many hard-working people never get the break they deserve',
      'timing - being there when an opportunity opens - is hard to plan',
    ],
    con: [
      'hard work is what lets you use luck when it comes',
      'consistent effort compounds over years in a way luck does not',
      'believing it is all luck can make people stop trying',
    ],
    evidence: ['stories of people from similar backgrounds who ended up in different places', 'how much early advantages predict later outcomes'],
  },
  {
    id: 'leaders-born-made',
    title: 'Are leaders born or made?',
    type: 'ABSTRACT',
    pro: [
      'some people seem naturally confident and persuasive from a young age',
      'temperament does shape how people handle pressure',
      'not everyone wants to lead, and that is fine',
    ],
    con: [
      'most leadership skills - listening, deciding, delegating - can be learned',
      'many good leaders were quiet people who grew into the role',
      'situations make leaders; people rise when something needs doing',
    ],
    evidence: ['whether leadership training changes how teams rate their managers', 'how many leaders describe themselves as shy when young'],
  },
  {
    id: 'plastic-ban',
    title: 'Should single-use plastic be banned completely?',
    type: 'SOCIAL',
    pro: [
      'plastic waste is clogging drains, rivers and oceans',
      'alternatives like cloth, paper and steel already exist',
      'a clear ban is easier to follow than partial rules',
    ],
    con: [
      'some plastic, like in medical supplies, has no easy replacement yet',
      'small traders may struggle with costlier alternatives',
      'bans without enforcement or recycling systems do not work',
    ],
    evidence: ['what happened in states that already banned it', 'the full environmental cost of the alternatives'],
  },
  {
    id: 'gig-economy',
    title: 'Is the gig economy good for young people?',
    type: 'BUSINESS',
    pro: [
      'it lets students earn flexibly alongside studies',
      'anyone with a phone can start earning quickly',
      'it can be a stepping stone to a full-time job',
    ],
    con: [
      'most gig work has no health cover, leave or job security',
      'pay can drop suddenly when the platform changes its rules',
      'it rarely builds skills that lead to a career',
    ],
    evidence: ['how long people stay in gig work', 'what gig workers earn after costs'],
  },
  {
    id: 'screen-time',
    title: 'Is our generation too dependent on smartphones?',
    type: 'ABSTRACT',
    pro: [
      'many people check their phone hundreds of times a day without deciding to',
      'constant notifications make deep focus harder',
      'real-life conversations are being replaced by scrolling',
    ],
    con: [
      'the phone is also a bank, a library, a map and a classroom',
      'every generation has worried about new technology',
      'it is how people use it, not the phone itself, that matters',
    ],
    evidence: ['how screen time relates to sleep and focus', 'what people actually do on their phones most'],
  },
];

export function topicById(id: string): GdTopic | undefined {
  return TOPICS.find((t) => t.id === id);
}

/* -------------------------------------------------------------------------- */
/* The participants                                                            */
/* -------------------------------------------------------------------------- */

export type PersonaKey = 'dominant' | 'quiet' | 'offtopic' | 'data';

export interface Persona {
  key: PersonaKey;
  name: string;
  /** What the student sees next to the name, so the dynamics are clear. */
  trait: string;
  /** How Claude should play them, when a key is configured. */
  brief: string;
}

export const PERSONAS: Persona[] = [
  {
    key: 'dominant',
    name: 'Arjun',
    trait: 'Talks a lot, sure of himself',
    brief: 'Confident and forceful. Speaks first and often, states opinions as facts, sometimes cuts across others. Not rude, just loud.',
  },
  {
    key: 'quiet',
    name: 'Meera',
    trait: 'Has good ideas, rarely speaks',
    brief: 'Thoughtful but hesitant. Short contributions, often trails off or asks permission to speak. Her points are good when she makes them.',
  },
  {
    key: 'offtopic',
    name: 'Kabir',
    trait: 'Drifts off the topic',
    brief: 'Friendly and chatty. Often drifts to a related but different subject, a personal story or a tangent.',
  },
  {
    key: 'data',
    name: 'Zoya',
    trait: 'Wants evidence',
    brief: 'Analytical. Asks what evidence would settle a point and pushes for specifics. Never invents statistics; talks about what data we would need.',
  },
];

export const personaByKey = (k: string) => PERSONAS.find((p) => p.key === k);

/** Who speaks in turn: Arjun most, Meera least - the imbalance is the lesson. */
const ROTATION: PersonaKey[] = ['dominant', 'data', 'offtopic', 'dominant', 'quiet', 'data', 'dominant', 'offtopic', 'quiet', 'dominant', 'data', 'quiet'];

/* -------------------------------------------------------------------------- */
/* The discussion                                                              */
/* -------------------------------------------------------------------------- */

export interface Turn {
  /** 'moderator', 'you', or a persona key. */
  speaker: string;
  text: string;
  at: string;
  /** The student's closing summary is marked, so feedback can find it. */
  kind?: 'summary';
}

/** A small seeded random number generator - the same session always plays the same. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rnd: () => number, list: T[]): T => list[Math.floor(rnd() * list.length)]!;

/** Turns that are part of the discussion itself, not the moderator's framing. */
export const discussionTurns = (t: Turn[]) => t.filter((x) => x.speaker !== 'moderator');

/** The persona who speaks next, by position in the discussion. */
export function nextSpeaker(transcript: Turn[]): PersonaKey {
  const personaTurns = transcript.filter((t) => personaByKey(t.speaker)).length;
  return ROTATION[personaTurns % ROTATION.length]!;
}

/** A word from the student's last turn to pick up on - the longest one is usually the noun that matters. */
function hookFrom(text: string): string | null {
  const stop = new Set(['because', 'actually', 'something', 'everyone', 'basically', 'probably', 'important', 'different', 'themselves']);
  const words = (text.toLowerCase().match(/[a-z]{6,}/g) ?? []).filter((w) => !stop.has(w));
  if (words.length === 0) return null;
  return words.sort((a, b) => b.length - a.length)[0]!;
}

const TANGENTS: Record<TopicType, string[]> = {
  TECH: ['my cousin bought a new phone last week and the battery is terrible', 'I was watching a video about space rockets yesterday', 'honestly the Wi-Fi in our hostel is the real problem'],
  SOCIAL: ['my neighbour started a small bakery and it is doing really well', 'I saw a movie last weekend about village life', 'our college fest had a debate on something like this'],
  BUSINESS: ['my uncle runs a shop and he has his own views on everything', 'I read that some company launched a new product yesterday', 'cricket sponsorship money is crazy these days'],
  ABSTRACT: ['I was reading a biography of a sportsperson recently', 'my grandmother always says something about this', 'it is like that old story we read in school'],
};

/**
 * One participant's next line, from the bank. Uses what has already been
 * said so points are not repeated, and reacts to the student's last turn when
 * there is one - a group that ignored you would be poor practice.
 */
export function builtinTurn(topic: GdTopic, transcript: Turn[], seed: string, persona: PersonaKey): string {
  const rnd = seeded(`${seed}:${transcript.length}:${persona}`);
  const said = transcript.map((t) => t.text).join(' ');
  const fresh = (list: string[]) => {
    const unused = list.filter((p) => !said.includes(p));
    return pick(rnd, unused.length ? unused : list);
  };
  const lastYou = [...transcript].reverse().find((t) => t.speaker === 'you');
  const hook = lastYou && transcript[transcript.length - 1] === lastYou ? hookFrom(lastYou.text) : null;
  const side = rnd() < 0.5 ? 'pro' : 'con';
  const point = fresh(side === 'pro' ? topic.pro : topic.con);
  const other = fresh(side === 'pro' ? topic.con : topic.pro);

  switch (persona) {
    case 'dominant': {
      const openers = [
        'Look, I think the answer is obvious here -',
        'Let me be very clear on this:',
        'Okay, I will put it simply -',
        'No, no, the real point is that',
      ];
      const react = hook ? `I hear the point about ${hook}, but ` : '';
      return `${react}${pick(rnd, openers)} ${point}. And frankly, people who argue that ${other} are missing the bigger picture. We should not overcomplicate this.`;
    }
    case 'quiet': {
      const openers = ['Sorry, can I add something?', 'I just wanted to say…', 'Maybe this is small, but', 'Um, if I may -'];
      const react = hook ? ` I liked what you said about ${hook}.` : '';
      return `${pick(rnd, openers)}${react} I feel ${point}… but I am not fully sure.`;
    }
    case 'offtopic': {
      const react = hook ? `Talking of ${hook}, ` : 'This reminds me - ';
      return `${react}${pick(rnd, TANGENTS[topic.type])}. Anyway, where was I - yes, I guess ${point}.`;
    }
    case 'data': {
      const ask = fresh(topic.evidence);
      const react = hook ? `On your point about ${hook} - ` : '';
      return `${react}I think we are all giving opinions. What would actually settle this is looking at ${ask}. Until then, the strongest argument I have heard is that ${point}.`;
    }
  }
}

/** How the moderator opens and closes the room. */
export function openingLine(topic: GdTopic): string {
  return `Good morning, everyone. Your topic is: "${topic.title}" You have about ten minutes. Anyone may begin.`;
}

export const SUMMARY_PROMPT =
  'Time is nearly up. Would one of you like to summarise the discussion for the panel?';

/** After this many discussion turns, the moderator asks for a summary. */
export const TURNS_BEFORE_SUMMARY = 10;

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export interface GdFeedback {
  source: 'builtin' | 'ai';
  fellBack?: boolean;
  score: number;
  strengths: string[];
  /** At most two. */
  improvements: Improvement[];
  metrics: {
    contributions: number;
    avgWords: number;
    /** Share of all words in the discussion that were yours, 0-100. */
    share: number;
    /** 1-based position of your first contribution among discussion turns; null if you never spoke. */
    enteredAt: number | null;
    referencedOthers: number;
    broughtBackOnTopic: boolean;
    usedExamples: boolean;
    summarised: boolean;
  };
}

const REFERENCE =
  /\b(building on|to build on|adding to|to add to|as (arjun|meera|kabir|zoya|you|he|she) (said|mentioned|pointed out)|i agree with|i (respectfully )?disagree|good point|fair point|i see what (you|arjun|meera|kabir|zoya) mean|(arjun|meera|kabir|zoya)(,| makes| raised| has))\b/i;
const BACK_ON_TOPIC = /\b(back to (the|our) (topic|question|point)|coming back to|let'?s (focus|come back|get back)|stay on (the )?topic|the (real )?question (here )?is)\b/i;
const EXAMPLE = /\b(for example|for instance|e\.g\.|such as|like in|in my (college|town|city|internship|experience)|\d+)/i;
const SUMMARY_CUE = /\b(to (summari[sz]e|sum up|conclude)|in summary|overall|so (we|the group)|we (discussed|agreed|heard)|both sides)\b/i;

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Feedback on how the student took part. Strengths first, at most two
 * improvements, and nothing about how they speak - only what they did in the
 * room: when they came in, whether they listened and built on others, kept
 * it on topic, backed points up, and pulled it together at the end.
 */
export function gdFeedback(transcript: Turn[]): GdFeedback {
  const turns = discussionTurns(transcript);
  const mine = turns.filter((t) => t.speaker === 'you');
  const totalWords = turns.reduce((n, t) => n + wordsOf(t.text).length, 0);
  const myWords = mine.reduce((n, t) => n + wordsOf(t.text).length, 0);
  const share = totalWords ? Math.round((myWords / totalWords) * 100) : 0;
  const firstIdx = turns.findIndex((t) => t.speaker === 'you');
  const enteredAt = firstIdx === -1 ? null : firstIdx + 1;
  const referencedOthers = mine.filter((t) => REFERENCE.test(t.text)).length;
  const broughtBackOnTopic = mine.some((t) => BACK_ON_TOPIC.test(t.text));
  const usedExamples = mine.some((t) => EXAMPLE.test(t.text));
  const summary = mine.find((t) => t.kind === 'summary');
  const summarised = Boolean(summary && wordsOf(summary.text).length >= 25) || mine.slice(-1).some((t) => SUMMARY_CUE.test(t.text) && wordsOf(t.text).length >= 25);
  const avgWords = mine.length ? Math.round(myWords / mine.length) : 0;

  let score = 40;
  // Weighted, so the three shown are the ones a panel values most.
  const ranked: [number, string][] = [];
  const strengths = { push: (text: string, weight = 1) => ranked.push([weight, text]) };
  const issues: Improvement[] = [];

  if (mine.length === 0) {
    return {
      source: 'builtin',
      score: 10,
      strengths: ['You stayed with the discussion to the end - next time, try getting one point in early. The first one is the hardest.'],
      improvements: [
        { title: 'Get in early', tip: 'Have one opening point ready before the topic is read out, and say it in the first two or three turns.' },
      ],
      metrics: { contributions: 0, avgWords: 0, share: 0, enteredAt, referencedOthers, broughtBackOnTopic, usedExamples, summarised },
    };
  }

  // Coming in.
  if (enteredAt !== null && enteredAt <= 3) {
    score += 10;
    strengths.push('You came in early, before the discussion settled into a pattern - panels notice that.', 2);
  } else if (enteredAt !== null && enteredAt > 6) {
    score -= 5;
    issues.push({ title: 'Come in earlier', tip: 'Aim to speak within the first three turns. A short, clear point is enough to establish yourself.' });
  }

  // How much.
  if (mine.length >= 3 && share <= 40) {
    score += 10;
    strengths.push(`You contributed ${mine.length} times without taking over - a good balance.`, 3);
  } else if (share > 45) {
    score -= 8;
    issues.push({
      title: 'Leave room for others',
      tip: 'You spoke for a large share of the time. Make your point, then invite someone quieter in - "Meera, what do you think?" scores well.',
    });
  } else if (mine.length < 2) {
    issues.push({ title: 'Speak a little more', tip: 'Two or three well-timed points are better than one. Add a second after someone else speaks.' });
  }

  // Listening.
  if (referencedOthers >= 1) {
    score += 12;
    strengths.push('You built on what others said instead of only giving your own view - that is exactly what panels look for.', 5);
  } else {
    issues.push({
      title: 'Build on others',
      tip: 'Start a point by linking it to someone else\'s: "Building on Zoya\'s point…" or "I see it differently from Arjun because…".',
    });
  }

  // Keeping it on track.
  if (broughtBackOnTopic) {
    score += 8;
    strengths.push('You brought the group back to the topic when it drifted - a quiet sign of leadership.', 4);
  }

  // Backing it up.
  if (usedExamples) {
    score += 8;
    strengths.push('You backed a point with an example or a detail, which makes it stick.', 3);
  } else {
    issues.push({ title: 'Add an example', tip: 'One real example - from your town, college or an internship - makes a point far more convincing than a general claim.' });
  }

  // Closing.
  if (summarised) {
    score += 12;
    strengths.push('You summarised the discussion at the end. Taking the summary is one of the strongest moves in a GD.', 6);
  } else {
    issues.push({
      title: 'Offer the summary',
      tip: 'When the moderator asks, volunteer: give both sides in a sentence each, then where the group landed.',
    });
  }

  // Length of each point.
  if (avgWords > 90) {
    issues.push({ title: 'Shorter points', tip: 'Keep each contribution to about 30-60 words so others can respond. Long speeches lose the room.' });
  } else if (avgWords > 0 && avgWords < 12) {
    issues.push({ title: 'Develop each point', tip: 'Give a reason with each point - "because…" - so it adds something to the discussion.' });
  }

  if (ranked.length === 0) strengths.push('You took part and held your own in a busy room - that is the hardest part of a GD.');

  return {
    source: 'builtin',
    score: clamp(score),
    strengths: ranked.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, text]) => text),
    improvements: issues.slice(0, 2),
    metrics: { contributions: mine.length, avgWords, share, enteredAt, referencedOthers, broughtBackOnTopic, usedExamples, summarised },
  };
}

/** A safety net for any feedback text: nothing about accent, grammar or the person. */
export function isAcceptableFeedback(parts: string[]): boolean {
  return !OFF_LIMITS.test(parts.join(' '));
}
