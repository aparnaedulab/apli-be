import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { z } from 'zod';

// Expanded, not just loaded: DATABASE_URL is composed from the MYSQL_* values,
// so the database is configured in one place rather than two that can drift.
dotenvExpand.expand(dotenv.config());

/**
 * Environment is validated once, at boot. If a required variable is missing or
 * malformed the process exits immediately with a readable message, rather than
 * failing later at the first request that happens to need it.
 */
/**
 * A setting that is allowed to be absent.
 *
 * `.env` files spell "not set" as `SMTP_HOST=` far more often than by leaving
 * the line out, and an empty string must mean the same thing as a missing one.
 * Without this the portal refuses to boot the moment somebody adds the mail
 * block and leaves it blank - which is exactly how it ships.
 */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /*
   * The database, as five plain fields.
   *
   * These are the source of truth. DATABASE_URL used to be, composed in the
   * .env file itself with ${...} interpolation - which meant the connection
   * was configured in two places that had to agree, and a password with a #
   * or an @ in it silently truncated the URL and came back as "credentials
   * are not valid". Building the URL here instead means a password is
   * escaped properly because code does it, not because somebody remembered.
   */
  MYSQL_HOST: z.string().trim().min(1).default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_USER: z.string().trim().min(1).default('apli'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().trim().min(1).default('apli'),

  /**
   * A complete connection string, when the five fields above cannot express
   * it - a managed host that hands you a URL, a socket path, TLS parameters.
   * Given, it wins outright and the fields are ignored.
   */
  DATABASE_URL: optional(z.string().trim().min(1)),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters - generate a random one'),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),

  /**
   * Whether the session cookie carries the `secure` flag.
   *
   * Unset, it follows NODE_ENV: secure in production, not in development -
   * which is right for every deployment that has TLS. A browser silently
   * drops a `secure` cookie sent over plain http, so a production portal
   * reached by bare IP would accept a password and then behave as though
   * nobody had logged in. Setting this to false makes that deployment work;
   * it should be set back to true the moment there is a certificate.
   */
  COOKIE_SECURE: optional(z.enum(['true', 'false']).transform((v) => v === 'true')),

  /**
   * Where the built client is, for serving it from this process.
   *
   * Unset - the default - means something else serves it: nginx in front,
   * or Vite in development. Set it and Node serves the bundle itself, which
   * puts the site and the API on one origin and one port.
   *
   * That is not a convenience. The client fetches a relative `/api`, so on
   * two ports it would ask the port it was served from and find nothing
   * there; and the session cookie is `sameSite: lax`, which a second origin
   * complicates for no gain. One port removes both problems.
   */
  CLIENT_DIST: optional(z.string().trim().min(1)),

  /**
   * The university this portal belongs to.
   *
   * It is a setting rather than a constant because it appears in three places
   * that must agree - the affiliation toggle on the college form, the Yes/No
   * column in the bulk-upload spreadsheet, and the value written to the
   * database - and because the eventual multi-tenant version needs it to vary.
   */
  HOME_UNIVERSITY: z.string().trim().min(2).default('Savitribai Phule Pune University'),

  /**
   * Sending mail. All optional: a deployment with none of this set still runs,
   * and every screen that offers to send an email says plainly that it cannot.
   *
   * Either give a whole SMTP_URL, or the pieces. The URL wins if both are set.
   */
  SMTP_URL: optional(z.string().trim().min(1)),
  SMTP_HOST: optional(z.string().trim().min(1)),
  SMTP_PORT: z.preprocess(
    (v) => (v === '' || v === undefined ? 587 : v),
    z.coerce.number().int().positive(),
  ),
  SMTP_USER: optional(z.string().trim().min(1)),
  SMTP_PASSWORD: optional(z.string()),
  SMTP_SECURE: optional(z.enum(['true', 'false']).transform((v) => v === 'true')),

  /** What recipients see in the From line. */
  MAIL_FROM: z.preprocess(
    (v) => (v === '' || v === undefined ? 'Apli.ai <no-reply@apli.local>' : v),
    z.string().trim().min(3),
  ),

  /** Named in the sign-off, so a recipient knows who to ask about it. */
  MAIL_REPLY_TO: optional(z.string().trim().email()),

  /**
   * Where uploaded images (institution logos and favicons) are kept. Relative
   * paths are read from the server folder. Back this directory up with the
   * database - the rows point at files in it.
   */
  UPLOAD_DIR: z.string().trim().min(1).default('uploads'),

  /**
   * Optional. With a key, mock-interview answers also get AI feedback from
   * Claude; without one the built-in feedback is used, and nothing else about
   * the portal changes.
   */
  ANTHROPIC_API_KEY: optional(z.string().trim().min(1)),
  /** The model that reviews mock-interview answers, when a key is set. */
  MOCK_INTERVIEW_MODEL: z.preprocess(
    (v) => (v === '' || v === undefined ? 'claude-opus-5' : v),
    z.string().trim().min(1),
  ),

  /**
   * WhatsApp Cloud API (channel.whatsapp). All optional: with the token and
   * phone-number id missing, WhatsApp messages are logged as "not set up" and
   * nothing is sent - the in-app notifications carry on exactly as before.
   */
  WHATSAPP_TOKEN: optional(z.string().trim().min(1)),
  WHATSAPP_PHONE_NUMBER_ID: optional(z.string().trim().min(1)),
  /** The language code the approved templates were registered in. */
  WHATSAPP_TEMPLATE_LANG: z.preprocess((v) => (v === '' || v === undefined ? 'en' : v), z.string().trim().min(2)),
  /** The Graph API version the Cloud API calls go to. */
  WHATSAPP_API_VERSION: z.preprocess((v) => (v === '' || v === undefined ? 'v21.0' : v), z.string().trim().min(2)),
  /**
   * JSON: notification type -> approved template name, e.g.
   * {"application.offered":"apli_offer_made"}. Types left out use the default
   * names listed in modules/whatsapp/templates.ts.
   */
  WHATSAPP_TEMPLATES: optional(z.string().trim().min(2)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';

/**
 * The connection string, built from the fields unless one was given whole.
 *
 * `encodeURIComponent` on the user and password is the point: a password of
 * `Apli#2026#db` is perfectly legal in MySQL and cuts a hand-written URL in
 * half, because `#` starts a fragment. Escaping it here means no one has to
 * know that.
 *
 * Exported onto process.env as well, because Prisma's CLI - `migrate deploy`,
 * `db seed` - reads DATABASE_URL from the environment and never sees this
 * module. One definition, whichever way the database is reached.
 */
export const databaseUrl: string =
  env.DATABASE_URL ??
  `mysql://${encodeURIComponent(env.MYSQL_USER)}:${encodeURIComponent(env.MYSQL_PASSWORD)}` +
    `@${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DATABASE}`;

process.env.DATABASE_URL = databaseUrl;

/**
 * The same database, as discrete fields.
 *
 * Prisma takes the URL, but the session store wants host/user/password
 * separately - so it is parsed once here rather than in both places.
 */
export function databaseConnection() {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}
