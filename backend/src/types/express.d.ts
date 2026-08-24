import type { UserRole } from '@shared';

declare global {
  namespace Express {
    interface Request {
      /** Populated by the `authenticate` middleware. */
      user?: { id: string; role: UserRole; email: string };
      /** Correlation id attached to every log line and error response. */
      requestId: string;
    }
  }
}

export {};
