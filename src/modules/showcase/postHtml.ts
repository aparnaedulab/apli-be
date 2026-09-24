import sanitizeHtml from 'sanitize-html';
import { badRequest } from '../../lib/errors.js';

/**
 * What a company writes, made safe to render.
 *
 * A post is the one place on this platform where one account's HTML is put in
 * front of another account's browser, so it is the one place worth being
 * strict: an allowlist of tags, no attributes worth attacking through, and
 * links that can only be https or mailto. Everything else is discarded rather
 * than escaped - a student reading a post should never see the markup that was
 * stripped out of it.
 *
 * This runs on the way in, not on the way out. The column then holds exactly
 * what a browser will render, so a reader cannot be harmed by a bug in some
 * future screen that forgets to sanitise.
 */

/** Longer than any update anybody writes, short enough to bound a page. */
export const MAX_BODY = 20_000;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'h3', 'blockquote', 'ul', 'ol', 'li', 'a'],
  // Only the one attribute the editor can produce. No style, no class, no id:
  // a post cannot reposition itself over the page around it.
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['https', 'mailto'],
  // A link with a scheme we do not allow loses its href rather than the whole
  // anchor, so the words survive and only the danger goes.
  allowedSchemesAppliedToAttributes: ['href'],
  disallowedTagsMode: 'discard',
  transformTags: {
    // The editor produces whichever of these the browser felt like; stored as
    // one so two posts written the same way read the same way.
    b: 'strong',
    i: 'em',
    div: 'p',
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...(attribs.href ? { href: attribs.href } : {}),
        // Someone else's page, opened from ours: no opener, no endorsement.
        rel: 'nofollow noopener noreferrer',
        target: '_blank',
      },
    }),
  },
};

/** The words inside, with the markup taken away - what "empty" is judged on. */
export function textOf(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cleans a post body, or refuses it.
 *
 * Length is measured after cleaning, because the measure that matters is what
 * will be stored - a body padded with markup that is about to be discarded is
 * not a long post.
 */
export function cleanPostHtml(raw: string): string {
  const clean = sanitizeHtml(raw, OPTIONS).trim();

  if (!textOf(clean)) throw badRequest('Write something before posting.');
  if (clean.length > MAX_BODY) {
    throw badRequest('That post is too long. Keep it under 20,000 characters.');
  }
  return clean;
}
