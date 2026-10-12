import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from './setup.js';
import { makeCollege } from './factories.js';

/**
 * "City you live in" suggestions: the cities Apli.ai knows first, then
 * OpenStreetMap - here a stand-in, so no test reaches the real service.
 */

let photon: Server;
let calls: string[] = [];
let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: { features: [] } });
let mod: typeof import('../src/modules/students/cities.js');

const feature = (name: string, state: string, countrycode = 'IN') => ({ properties: { name, state, countrycode } });

beforeAll(async () => {
  photon = createServer((req, res) => {
    calls.push(req.url ?? '');
    const { status, body } = answer();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }).listen(0);
  process.env.CITY_LOOKUP_URL = `http://127.0.0.1:${(photon.address() as AddressInfo).port}/api/`;
  mod = await import('../src/modules/students/cities.js');
});

afterAll(() => {
  photon.close();
});

beforeEach(() => {
  calls = [];
  mod.clearCityCache();
});

describe('city suggestions', () => {
  it('puts known cities first and fills in the rest of India', async () => {
    await makeCollege('Sample Demo College');
    await db.college.updateMany({ data: { city: 'Nashik', state: 'Maharashtra' } });
    answer = () => ({
      status: 200,
      body: {
        features: [
          feature('Nashik', 'Maharashtra'),
          feature('Nasirabad', 'Rajasthan'),
          feature('Naserpur', 'Sindh', 'PK'),
        ],
      },
    });

    const cities = await mod.suggestCities('Nas');
    expect(cities).toEqual([
      { name: 'Nashik', state: 'Maharashtra' },
      { name: 'Nasirabad', state: 'Rajasthan' },
    ]);
    // Only Indian places are asked for, and only cities and towns.
    expect(calls[0]).toContain('bbox=');
    expect(calls[0]).toContain('osm_tag=place%3Acity');
  });

  it('asks the outside service once for the same letters', async () => {
    answer = () => ({ status: 200, body: { features: [feature('Pune', 'Maharashtra')] } });
    await mod.suggestCities('Pun');
    await mod.suggestCities('pun');
    expect(calls).toHaveLength(1);
  });

  it('still answers with known cities when the outside service fails', async () => {
    await db.refValue.create({ data: { kind: 'CITY', value: 'Panaji' } });
    answer = () => ({ status: 503, body: {} });
    expect(await mod.suggestCities('Pan')).toEqual([{ name: 'Panaji', state: null }]);
  });

  it('does not search on one letter', async () => {
    expect(await mod.suggestCities('P')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
