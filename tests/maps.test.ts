import { describe, expect, it } from 'vitest';
import { embedUrlFrom, mapsLinkFrom } from '../src/modules/jobs/maps.js';

/**
 * What may be pasted into a map field.
 *
 * The embed URL becomes the `src` of an iframe on a page students open, which
 * makes it the one piece of company-supplied text a student's browser goes and
 * loads something from. Everything here is about what must not get through.
 */

describe('the embed link', () => {
  it('takes the src out of the snippet Google actually gives you', () => {
    const pasted =
      '<iframe src="https://www.google.com/maps/embed?pb=!1m18!2sen" width="600" height="450" style="border:0;" allowfullscreen loading="lazy"></iframe>';

    // Asking somebody to cut the src out by hand is asking for a mistake, so
    // the whole snippet is accepted and the link taken from it.
    expect(embedUrlFrom(pasted)).toBe('https://www.google.com/maps/embed?pb=!1m18!2sen');
  });

  it('takes a bare embed URL too', () => {
    const url = 'https://www.google.com/maps/embed?pb=!1m18';
    expect(embedUrlFrom(url)).toBe(url);
  });

  it('takes an OpenStreetMap embed', () => {
    const url = 'https://www.openstreetmap.org/export/embed.html?bbox=73.7,18.5,73.8,18.6';
    expect(embedUrlFrom(url)).toBe(url);
  });

  it('refuses a frame from anywhere else', () => {
    // The whole point: an input box would accept this, and a student's
    // browser would then load it inside the portal.
    expect(() => embedUrlFrom('<iframe src="https://evil.example/pretend-map"></iframe>')).toThrow(
      /only be embedded from/i,
    );
    expect(() => embedUrlFrom('https://maps.evil.example/embed?pb=1')).toThrow(
      /only be embedded from/i,
    );
  });

  it('refuses a maps URL that is not an embed', () => {
    // Framing an ordinary Google Maps page mostly renders a refusal, and the
    // person pasting it has almost certainly grabbed the wrong one of the two.
    expect(() => embedUrlFrom('https://www.google.com/maps/place/Pune')).toThrow(
      /share link, not the embed/i,
    );
  });

  it('refuses anything that is not https', () => {
    expect(() => embedUrlFrom('http://www.google.com/maps/embed?pb=1')).toThrow(/https/i);
    expect(() => embedUrlFrom('javascript:alert(1)')).toThrow();
    expect(() => embedUrlFrom('<iframe src="javascript:alert(1)"></iframe>')).toThrow();
  });

  it('treats an empty field as nothing rather than as an error', () => {
    expect(embedUrlFrom('')).toBeNull();
    expect(embedUrlFrom('   ')).toBeNull();
  });

  it('refuses something that is not a link at all', () => {
    expect(() => embedUrlFrom('the office on Balewadi High Street')).toThrow(/does not look like/i);
  });
});

describe('the share link', () => {
  it('takes what Share gives you, long or short', () => {
    const short = 'https://maps.app.goo.gl/AbCdEf123';
    const long = 'https://www.google.com/maps/place/Pune/@18.52,73.85,12z';

    expect(mapsLinkFrom(short)).toBe(short);
    expect(mapsLinkFrom(long)).toBe(long);
  });

  it('does not demand the embed shape, since it opens in a tab', () => {
    // This one is never framed, so an ordinary maps page is exactly right.
    expect(mapsLinkFrom('https://www.google.com/maps/place/Pune')).toContain('/maps/place/Pune');
  });

  it('refuses a link somewhere else entirely', () => {
    expect(() => mapsLinkFrom('https://evil.example/directions')).toThrow(/should come from/i);
  });

  it('treats an empty field as nothing', () => {
    expect(mapsLinkFrom('')).toBeNull();
  });
});
