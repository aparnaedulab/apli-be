import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * Uploaded files: an institution's logo and favicon, a company's logo, cover,
 * photographs, and the pictures and videos inside its posts.
 *
 * Stored on disk under UPLOAD_DIR with a random name, and served back from
 * /api/files/<name>. Three rules keep an upload from becoming an attack:
 *
 *   The type is decided by the bytes, not by the file name or the browser's
 *   claim. A ".png" that is really HTML is refused.
 *
 *   The stored name is ours - random hex plus the extension we chose - so
 *   nothing a person uploads can pick a path.
 *
 *   SVG, the one image format that can carry script, is refused if it holds
 *   any, and every file is served under a sandboxing content policy, so even
 *   one that slipped through could not run when opened directly.
 */

export const ASSET_ROUTE = '/api/files';

export type AssetKind = 'logo' | 'favicon' | 'cover' | 'photo' | 'video' | 'resume';

/*
 * A cover and a photograph are photographs rather than marks, so they are
 * allowed more room than a logo - but only enough for a reasonable JPEG, not
 * enough for whatever came off a camera untouched.
 */
const LIMITS: Record<AssetKind, number> = {
  logo: 2 * 1024 * 1024,
  favicon: 512 * 1024,
  cover: 4 * 1024 * 1024,
  photo: 4 * 1024 * 1024,
  // A minute of phone footage, and no more: we store these ourselves, and a
  // company page is not a video host.
  video: 50 * 1024 * 1024,
  // A resume is two pages of text. Anything much larger is a scan of a
  // scan, which is the thing a recruiter cannot read anyway.
  resume: 5 * 1024 * 1024,
};

interface Sniffed {
  ext: string;
  mime: string;
}

/** What the bytes are, if they are an image we accept. */
export function sniffImage(buf: Buffer): Sniffed | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (starts(0x00, 0x00, 0x01, 0x00)) return { ext: 'ico', mime: 'image/x-icon' };

  // SVG is text. Look at the start for the root element, ignoring an XML
  // declaration, comments and a doctype.
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return { ext: 'svg', mime: 'image/svg+xml' };
  }
  return null;
}

/**
 * What the bytes are, if they are a document we accept.
 *
 * PDF only, and deliberately. A resume is read by a recruiter on whatever
 * they happen to have open, and a .docx renders differently in every one of
 * them - which is how a student's careful layout arrives as three ragged
 * pages. PDF is also the one document format we can serve safely, because it
 * is opened under the same sandboxing policy as everything else here.
 */
export function sniffDocument(buf: Buffer): Sniffed | null {
  // "%PDF-", which every PDF starts with.
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { ext: 'pdf', mime: 'application/pdf' };
  }
  return null;
}

/**
 * What the bytes are, if they are a video we accept.
 *
 * The same rule as images: the container is read out of the file, never taken
 * from the name or the browser's claim. MP4 and WebM are what every browser
 * plays; a QuickTime file is an MP4 container with a different brand, so it is
 * kept as itself rather than renamed and hoped for.
 */
export function sniffVideo(buf: Buffer): Sniffed | null {
  if (buf.length < 12) return null;

  // Matroska and WebM share this header; WebM is the subset browsers play.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { ext: 'webm', mime: 'video/webm' };
  }

  // ISO base media: a size, then "ftyp", then the brand it was written as.
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand.startsWith('qt')) return { ext: 'mov', mime: 'video/quicktime' };
    return { ext: 'mp4', mime: 'video/mp4' };
  }
  return null;
}

/** Anything in an SVG that could execute or reach out when it is rendered. */
function svgIsUnsafe(text: string): boolean {
  return (
    /<script[\s>]/i.test(text) ||
    /\son[a-z]+\s*=/i.test(text) ||
    /(?:href|src)\s*=\s*["']?\s*(?:javascript|data:text\/html)/i.test(text) ||
    /<foreignObject[\s>]/i.test(text) ||
    /<!ENTITY/i.test(text)
  );
}

export function uploadDir(): string {
  return path.resolve(env.UPLOAD_DIR);
}

/** Checks and stores a file; returns the path the browser loads it from. */
export async function saveTenantAsset(kind: AssetKind, buf: Buffer): Promise<string> {
  if (buf.length === 0) throw badRequest('That file is empty.');
  if (buf.length > LIMITS[kind]) {
    // Kilobytes for pictures, which is how their limits are usually talked
    // about; megabytes for video, where "51200 KB" tells a person nothing.
    const limit = LIMITS[kind];
    throw badRequest(
      kind === 'video'
        ? `Keep the video under ${Math.round(limit / (1024 * 1024))} MB.`
        : `Keep the ${kind} under ${Math.round(limit / 1024)} KB.`,
    );
  }

  if (kind === 'video') {
    const video = sniffVideo(buf);
    if (!video) throw badRequest('Upload an MP4, WebM or MOV video.');
    return store(kind, video, buf);
  }

  if (kind === 'resume') {
    const doc = sniffDocument(buf);
    if (!doc) {
      throw badRequest(
        'Upload a PDF. A Word file looks different in every reader, which is not what you want a recruiter opening.',
      );
    }
    return store(kind, doc, buf);
  }

  const type = sniffImage(buf);
  if (!type) throw badRequest('Upload a PNG, JPG, WebP, GIF, SVG or ICO image.');
  if (kind !== 'favicon' && type.ext === 'ico') {
    throw badRequest('An .ico file is for favicons. Use PNG or JPG here.');
  }
  if (type.ext === 'svg' && svgIsUnsafe(buf.toString('utf8'))) {
    throw badRequest('That SVG contains scripts or links, which are not allowed. Export it again as a plain image.');
  }

  return store(kind, type, buf);
}

/** The name is ours - random hex and an extension we chose, never theirs. */
async function store(kind: AssetKind, type: Sniffed, buf: Buffer): Promise<string> {
  const name = `${kind}-${randomBytes(12).toString('hex')}.${type.ext}`;
  await mkdir(uploadDir(), { recursive: true });
  await writeFile(path.join(uploadDir(), name), buf, { flag: 'wx' });
  return `${ASSET_ROUTE}/${name}`;
}

/**
 * Removes a file we stored, given the address we handed out.
 *
 * Only ever ours: the address is checked against the shape this module mints
 * before anything is unlinked, so nothing outside the upload directory can be
 * named. A file already gone is not an error - the caller wanted it gone.
 */
export async function removeAsset(url: string): Promise<void> {
  if (!isAssetRef(url)) return;
  const name = url.slice(`${ASSET_ROUTE}/`.length);
  await rm(path.join(uploadDir(), name), { force: true });
}

/** One of our own uploads - the shape this module mints, and nothing else. */
export function isAssetRef(value: string): boolean {
  return /^\/api\/files\/(?:logo|favicon|cover|photo|video|resume)-[a-f0-9]{24}\.(?:png|jpg|webp|gif|svg|ico|mp4|webm|mov|pdf)$/.test(
    value,
  );
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/**
 * GET /api/files/:name - public, because a login page shows the logo before
 * anybody has signed in. Only names we minted match; everything else is 404.
 */
export const filesRouter = Router();

filesRouter.get('/:name', (req, res, next) => {
  const name = req.params.name ?? '';
  if (!isAssetRef(`${ASSET_ROUTE}/${name}`)) {
    next(notFound());
    return;
  }
  const ext = name.split('.').pop()!;
  res.setHeader('Content-Type', MIME[ext]!);

  /*
   * A PDF is shown; everything else is inert.
   *
   * The sandbox directive is what stops an image or an SVG doing anything
   * when opened on its own - but it also stops a browser rendering a PDF at
   * all, which turned a resume into a file that silently downloaded and
   * looked broken. So a PDF is served without it and shown in place, while
   * `default-src 'none'` still means the document cannot fetch anything and
   * `nosniff` means it is read as a PDF or not at all.
   */
  res.setHeader(
    'Content-Security-Policy',
    ext === 'pdf'
      ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
      : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  /*
   * Shown in the tab, unless asked for as a file.
   *
   * A student checking what they just built wants to look at it; a recruiter
   * collecting applications wants to save it. `?download` is what the second
   * one asks with, so neither has to put up with the other's answer.
   */
  if (ext === 'pdf') {
    const asFile = req.query.download !== undefined;
    res.setHeader('Content-Disposition', `${asFile ? 'attachment' : 'inline'}; filename="${name}"`);
  }

  // Names are random and never reused, so a file can be cached for good.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(uploadDir(), name), (err) => {
    if (err && !res.headersSent) next(notFound());
  });
});
