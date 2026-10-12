import { RefKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * "City you live in" suggestions, as the student types.
 *
 * Two sources, in this order:
 *
 *   1. The cities Apli.ai already knows - the platform's city list and the
 *      cities of colleges on it. Instant, and spelt the way the rest of the
 *      portal spells them.
 *   2. OpenStreetMap, through Photon, for every other city and town in
 *      India. The call is made here rather than from the browser so a
 *      student's typing and address never reach the outside service, and
 *      answers are cached so the same few letters are asked once.
 *
 * The outside service is free and shared, with no promise it is up. It gets
 * a short time limit, and when it fails the student gets the known cities
 * and can still type their own: a suggestion box is a help, never a gate.
 */

export interface CitySuggestion {
  name: string;
  state: string | null;
}

const PHOTON_URL = process.env.CITY_LOOKUP_URL ?? 'https://photon.komoot.io/api/';
/** West, south, east, north: India, so "Pun" is Pune and not Punakha. */
const INDIA_BBOX = '68.1,6.5,97.5,35.7';
const TIMEOUT_MS = 2500;
const LIMIT = 8;

/** Lower-cased query -> what OpenStreetMap said, for a day. */
const cache = new Map<string, { at: number; cities: CitySuggestion[] }>();
const CACHE_MS = 24 * 60 * 60 * 1000;
const CACHE_SIZE = 2000;

const keyOf = (c: CitySuggestion) => `${c.name.toLowerCase()}|${(c.state ?? '').toLowerCase()}`;

/** Cities Apli.ai already has, starting with what was typed. */
async function knownCities(q: string): Promise<CitySuggestion[]> {
  const [listed, colleges] = await Promise.all([
    prisma.refValue.findMany({
      where: { kind: RefKind.CITY, isActive: true, value: { startsWith: q } },
      orderBy: { value: 'asc' },
      take: LIMIT,
      select: { value: true },
    }),
    prisma.college.findMany({
      where: { city: { startsWith: q } },
      distinct: ['city'],
      orderBy: { city: 'asc' },
      take: LIMIT,
      select: { city: true, state: true },
    }),
  ]);
  return [
    ...colleges.map((c) => ({ name: c.city, state: c.state ?? null })),
    ...listed.map((r) => ({ name: r.value, state: null })),
  ];
}

/** Cities and towns in India from OpenStreetMap. Empty when it does not answer. */
async function openStreetMap(q: string): Promise<CitySuggestion[]> {
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cities;

  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '15');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('bbox', INDIA_BBOX);
  url.searchParams.append('osm_tag', 'place:city');
  url.searchParams.append('osm_tag', 'place:town');

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Apli.ai student sign-up (city suggestions)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      features?: { properties?: { name?: string; state?: string; countrycode?: string } }[];
    };
    // The box is square, so it takes in some of the neighbours too.
    const cities = (body.features ?? [])
      .map((f) => f.properties ?? {})
      .filter((p) => p.countrycode === 'IN' && p.name)
      .map((p) => ({ name: p.name!, state: p.state ?? null }));

    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), cities });
    return cities;
  } catch {
    return [];
  }
}

export async function suggestCities(raw: string): Promise<CitySuggestion[]> {
  const q = raw.trim().slice(0, 60);
  if (q.length < 2) return [];

  const [known, osm] = await Promise.all([knownCities(q), openStreetMap(q)]);

  // A city known without its state takes the state OpenStreetMap gives it.
  const stateOf = new Map(osm.map((c) => [c.name.toLowerCase(), c.state]));
  const seen = new Set<string>();
  const out: CitySuggestion[] = [];
  for (const c of [...known, ...osm]) {
    const city = { name: c.name, state: c.state ?? stateOf.get(c.name.toLowerCase()) ?? null };
    const k = keyOf(city);
    // "Pune" from the list and "Pune, Maharashtra" from the map are one city.
    const bare = `${city.name.toLowerCase()}|`;
    if (seen.has(k) || seen.has(bare)) continue;
    seen.add(k);
    seen.add(bare);
    out.push(city);
    if (out.length >= LIMIT) break;
  }
  return out;
}

/** For tests. */
export function clearCityCache(): void {
  cache.clear();
}
