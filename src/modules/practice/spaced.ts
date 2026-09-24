/**
 * Spaced repetition, kept deliberately simple.
 *
 * Two things decide what comes back first: how often a topic goes wrong, and
 * how long since it was last practised. Weak and stale beats weak alone,
 * which beats stale alone - the classic finding is that recall fades on a
 * curve, so a topic you got right a month ago is due again too.
 *
 * Pure functions over attempt rows, so the ordering can be tested exactly.
 */

export interface AttemptRow {
  questionId: string;
  topic: string;
  section: string;
  correct: boolean;
  createdAt: Date;
}

export interface TopicStat {
  topic: string;
  section: string;
  attempts: number;
  correct: number;
  accuracy: number;
  lastAt: Date;
  /** Higher means practise sooner. */
  priority: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Days until a topic is "due" again at a given accuracy: shaky topics come
 * back after a day, solid ones after a fortnight.
 */
function interval(accuracy: number): number {
  if (accuracy < 0.5) return 1;
  if (accuracy < 0.7) return 3;
  if (accuracy < 0.85) return 7;
  return 14;
}

export function topicStats(rows: AttemptRow[], now = new Date()): TopicStat[] {
  const byTopic = new Map<string, { section: string; attempts: number; correct: number; lastAt: Date }>();
  for (const r of rows) {
    const cur = byTopic.get(r.topic) ?? { section: r.section, attempts: 0, correct: 0, lastAt: r.createdAt };
    cur.attempts++;
    if (r.correct) cur.correct++;
    if (r.createdAt > cur.lastAt) cur.lastAt = r.createdAt;
    byTopic.set(r.topic, cur);
  }

  return [...byTopic.entries()]
    .map(([topic, s]) => {
      const accuracy = s.correct / s.attempts;
      const daysSince = (now.getTime() - s.lastAt.getTime()) / DAY;
      // Overdue by how many intervals, plus how wrong it goes. A topic never
      // wrong and recently seen sits near zero.
      const priority = (1 - accuracy) * 2 + Math.max(0, daysSince / interval(accuracy) - 1);
      return { topic, section: s.section, attempts: s.attempts, correct: s.correct, accuracy, lastAt: s.lastAt, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.accuracy - b.accuracy || a.topic.localeCompare(b.topic));
}

/**
 * Questions whose most recent answer was wrong, most recent mistake first.
 * These resurface ahead of fresh questions in review - getting it right the
 * second time is the point.
 */
export function wrongToRetry(rows: AttemptRow[]): string[] {
  const latest = new Map<string, AttemptRow>();
  for (const r of rows) {
    const cur = latest.get(r.questionId);
    if (!cur || r.createdAt > cur.createdAt) latest.set(r.questionId, r);
  }
  return [...latest.values()]
    .filter((r) => !r.correct)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => r.questionId);
}
