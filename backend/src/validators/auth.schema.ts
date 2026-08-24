import { z } from 'zod';
import { uuid } from './common.js';

/**
 * Password policy: length beats complexity rules for real-world resistance, so the
 * requirement is a minimum of 10 characters rather than a symbol-and-digit maze.
 */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That password is too long');

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Tell us your name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  password,
  // ADMIN is intentionally absent: administrator accounts are seeded, never self-served.
  role: z.enum(['CUSTOMER', 'ORGANISER']).default('CUSTOMER'),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export const verifyEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

/**
 * Self-service reset is offered to CUSTOMER and ORGANISER accounts only. ADMIN accounts
 * are provisioned out of band (the seed script) and are never resettable through this
 * endpoint — `authService.forgotPassword` silently no-ops for them rather than telling
 * the caller so, for the same reason a login failure never says which part was wrong:
 * the response must not reveal anything about the account behind an email address.
 */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

/** Dedicated resend for a registration already in flight — same shape as forgotPassword's email step. */
export const resendVerificationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

export const verifyResetOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

/**
 * `resetToken` is the short-lived authorisation `verify-reset-otp` issues — never the
 * emailed code itself, which is already spent by the time this call is made.
 */
export const resetPasswordSchema = z.object({
  resetId: uuid,
  resetToken: z.string().min(20).max(200),
  password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
