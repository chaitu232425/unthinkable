import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment parsing. The process refuses to start with an invalid configuration
 * rather than failing later at the first request — a misconfigured JWT secret should
 * be a boot error, not a 500 at 2am.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /* ---------------------------------------------------------------- database */
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  /** Database name. Split out from the URI so tests can override it per worker. */
  MONGODB_DB_NAME: z.string().min(1).default('ticket_booking'),
  MONGO_POOL_MAX: int(30, 2, 200),
  /** How long a session-scoped job lock (sweeper, outbox worker) is leased for. */
  JOB_LOCK_TTL_MS: int(60_000, 1000, 600_000),

  /* -------------------------------------------------------------------- auth */
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  /** HMAC key that signs QR ticket payloads. */
  TICKET_SECRET: z.string().min(16, 'TICKET_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL_SECONDS: int(900, 60, 86_400),
  REFRESH_TOKEN_TTL_DAYS: int(7, 1, 90),
  BCRYPT_ROUNDS: int(12, 4, 15),
  /** How long a password-reset code stays valid. Self-service reset is CUSTOMER/ORGANISER only. */
  PASSWORD_RESET_TTL_MINUTES: int(10, 5, 1440),
  /**
   * How long the one-time authorisation issued by `verify-reset-otp` stays valid — a
   * short window to actually submit the new password after the code itself has already
   * been confirmed, kept separate so the code can't be replayed as that authorisation.
   */
  PASSWORD_RESET_AUTHORIZATION_TTL_MINUTES: int(10, 2, 60),
  /** How long a registration's emailed code stays valid before signup must restart. */
  EMAIL_VERIFICATION_TTL_MINUTES: int(10, 5, 120),
  /** Wrong-code guesses allowed before that code is dead and a fresh one must be requested. */
  EMAIL_VERIFICATION_MAX_ATTEMPTS: int(5, 3, 20),
  /** Minimum gap between two OTP emails (registration or password reset) to the same address. */
  OTP_RESEND_COOLDOWN_SECONDS: int(60, 10, 600),

  /* --------------------------------------------------------------- business */
  /** Default seat-hold TTL in seconds. Overridable per event. */
  DEFAULT_HOLD_TTL: int(600, 60, 3600),
  /** Default waitlist-offer TTL in seconds. */
  DEFAULT_OFFER_TTL: int(900, 120, 86_400),
  /** Bookings can no longer be cancelled this many minutes before the event starts. */
  CANCEL_CUTOFF_MINUTES: int(120, 0, 20_160),
  MAX_SEATS_PER_HOLD: int(10, 1, 50),
  MAX_VENUE_SEATS: int(2000, 1, 20_000),
  /** How many offers a single waitlist run may create. */
  MAX_OFFERS_PER_RUN: int(20, 1, 200),

  /* ------------------------------------------------------------------- jobs */
  JOBS_ENABLED: bool(true),
  SWEEPER_INTERVAL_SECONDS: int(15, 1, 3600),
  OUTBOX_INTERVAL_SECONDS: int(10, 1, 3600),

  /* ------------------------------------------------------------------ email */
  /**
   * `resend` sends over HTTPS but, with no verified sending domain, only actually
   * delivers to the address the Resend account was signed up with — a real, confirmed
   * restriction, not something this app can configure around. `brevo` is the
   * arbitrary-recipient alternative: also HTTPS (unlike `smtp`, which was confirmed
   * blocked both locally and from Render's network), free tier, and only needs a single
   * verified sender email — no domain. Its one gap is no inline-image (CID) support, so
   * the QR ticket arrives as a regular attachment through this provider rather than
   * embedded in the email body. `smtp` remains available for whichever network actually
   * permits it. `file` writes .html files to disk; `memory` is for tests. Business logic
   * (registration, password reset, tickets, waitlist) never imports a provider SDK
   * directly — it only calls `getTransport().send()`, so this is the only place a
   * provider swap has to happen.
   */
  EMAIL_TRANSPORT: z.enum(['resend', 'brevo', 'smtp', 'file', 'memory']).default('file'),
  RESEND_API_KEY: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Ticket Booking <onboarding@resend.dev>'),
  MAIL_OUTBOX_DIR: z.string().default('.mail-outbox'),

  /** Optional development-only provider — see EMAIL_TRANSPORT above. Unused unless EMAIL_TRANSPORT=smtp. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  SMTP_SECURE: bool(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  /* ------------------------------------------------------------------- urls */
  /** Public URL of the SPA. Used to build waitlist-offer links in emails. */
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),
  /** Comma-separated CORS allowlist. Defaults to CLIENT_URL when unset. */
  CORS_ORIGINS: z.string().optional(),

  /* ------------------------------------------------------------ rate limits */
  RATE_LIMIT_WINDOW_SECONDS: int(60, 1, 3600),
  RATE_LIMIT_MAX: int(300, 1, 100_000),
  AUTH_RATE_LIMIT_MAX: int(15, 1, 10_000),
  HOLD_RATE_LIMIT_MAX: int(30, 1, 10_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately console, not the logger: the logger itself depends on this module.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the required values.\n');
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: (raw.CORS_ORIGINS ?? raw.CLIENT_URL)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;
