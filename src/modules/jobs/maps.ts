import { badRequest } from '../../lib/errors.js';

/**
 * The two map links a company pastes, checked before they are kept.
 *
 * The embed URL ends up as the `src` of an iframe on a page students open, so
 * it is the one piece of company-supplied text that the browser will go and
 * execute something from. Anything at all would be accepted by an input box;
 * only a maps embed is accepted here.
 *
 * Links are pasted rather than looked up on purpose. A geocoder guesses from
 * text and is sometimes confidently wrong - "Balewadi High Street" landed on a
 * restaurant rather than the office park next to it - while a link copied off
 * the map is the exact pin a person chose while looking at it.
 */

/** Hosts an embedded map may come from. Nothing else may be framed. */
const EMBED_HOSTS = new Set([
  'www.google.com',
  'google.com',
  'maps.google.com',
  'www.openstreetmap.org',
  'openstreetmap.org',
]);

/** Hosts a "open in maps" link may point at. */
const LINK_HOSTS = new Set([
  'www.google.com',
  'google.com',
  'maps.google.com',
  'maps.app.goo.gl',
  'goo.gl',
  'www.openstreetmap.org',
  'openstreetmap.org',
]);

function parse(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw badRequest('That does not look like a link. Paste the whole thing, including https://.');
  }
}

/**
 * Takes what somebody pasted and returns the URL to frame.
 *
 * Google's Share → Embed a map gives you a whole `<iframe …>` snippet, and
 * asking a person to cut the src out of it by hand is asking for a mistake,
 * so the snippet is accepted and the src taken from it.
 */
export function embedUrlFrom(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const fromIframe = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  const candidate = (fromIframe?.[1] ?? raw).trim();

  const url = parse(candidate);

  if (url.protocol !== 'https:') {
    throw badRequest('The map link has to be https.');
  }

  if (!EMBED_HOSTS.has(url.hostname)) {
    // The specific refusal matters: somebody who pasted the share link by
    // mistake needs to know which of the two they have.
    throw badRequest(
      `A map can only be embedded from Google Maps or OpenStreetMap, not ${url.hostname}.`,
    );
  }

  const isEmbed =
    url.pathname.startsWith('/maps/embed') || url.pathname.startsWith('/export/embed');

  if (!isEmbed) {
    throw badRequest(
      'That is the share link, not the embed one. On Google Maps use Share → Embed a map, then copy the HTML.',
    );
  }

  return url.toString();
}

/** The link behind "open in maps", which opens in a tab rather than a frame. */
export function mapsLinkFrom(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const url = parse(raw);

  if (url.protocol !== 'https:') throw badRequest('The map link has to be https.');

  if (!LINK_HOSTS.has(url.hostname)) {
    throw badRequest(`A maps link should come from Google Maps or OpenStreetMap, not ${url.hostname}.`);
  }

  return url.toString();
}
