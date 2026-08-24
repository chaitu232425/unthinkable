import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { authService } from '../services/auth.service.js';
import { unauthorized } from '../utils/errors.js';

const REFRESH_COOKIE = 'tbs_refresh';

/**
 * The refresh token lives in an httpOnly cookie so client-side JavaScript — and
 * therefore any XSS payload — cannot read it. The short-lived access token is returned
 * in the body and kept in memory by the SPA.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    // The SPA is on a different origin in production, so the cookie must be
    // cross-site; 'lax' would silently drop it on the refresh XHR.
    sameSite: env.isProduction ? 'none' : 'lax',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

export const authController = {
  /** Stages the account and emails a code — no session yet, see `verifyEmail`. */
  async register(req: Request, res: Response) {
    res.status(200).json(await authService.register(req.body));
  },

  async verifyEmail(req: Request, res: Response) {
    const { refreshToken, ...session } = await authService.verifyEmail(
      req.body.email,
      req.body.code,
      req.header('user-agent') ?? undefined,
    );
    setRefreshCookie(res, refreshToken);
    res.status(201).json(session);
  },

  /** Reissues a code for a registration still in progress — no session, same shape as `register`. */
  async resendVerificationCode(req: Request, res: Response) {
    res.status(200).json(await authService.resendVerificationCode(req.body.email));
  },

  async login(req: Request, res: Response) {
    const { refreshToken, ...session } = await authService.login({
      ...req.body,
      userAgent: req.header('user-agent') ?? undefined,
    });
    setRefreshCookie(res, refreshToken);
    res.status(200).json(session);
  },

  async refresh(req: Request, res: Response) {
    // Accept the token from the cookie, or from the body for non-browser clients.
    const token: string | undefined =
      req.cookies?.[REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken;
    if (!token) throw unauthorized('No session to refresh.');

    const { refreshToken, ...session } = await authService.refresh(
      token,
      req.header('user-agent') ?? undefined,
    );
    setRefreshCookie(res, refreshToken);
    res.status(200).json(session);
  },

  async logout(req: Request, res: Response) {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    res.status(204).send();
  },

  async me(req: Request, res: Response) {
    res.json({ user: await authService.me(req.user!.id) });
  },

  /**
   * Always 204, whatever happened internally — the response must not reveal whether
   * the address is registered, deactivated, or belongs to an admin.
   */
  async forgotPassword(req: Request, res: Response) {
    await authService.forgotPassword(req.body.email);
    res.status(204).send();
  },

  /** Confirms the emailed code and issues the short-lived authorisation `resetPassword` needs. */
  async verifyResetOtp(req: Request, res: Response) {
    res.status(200).json(await authService.verifyResetOtp(req.body.email, req.body.code));
  },

  async resetPassword(req: Request, res: Response) {
    await authService.resetPassword(req.body.resetId, req.body.resetToken, req.body.password);
    res.status(204).send();
  },
};
