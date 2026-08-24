import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/http.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  verifyResetOtpSchema,
} from '../validators/auth.schema.js';

export const authRoutes = Router();

authRoutes.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(authController.register),
);
authRoutes.post(
  '/verify-email',
  authLimiter,
  validate({ body: verifyEmailSchema }),
  asyncHandler(authController.verifyEmail),
);
authRoutes.post(
  '/verify-email/resend',
  authLimiter,
  validate({ body: resendVerificationSchema }),
  asyncHandler(authController.resendVerificationCode),
);

authRoutes.post('/login', authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

authRoutes.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(authController.forgotPassword),
);
authRoutes.post(
  '/verify-reset-otp',
  authLimiter,
  validate({ body: verifyResetOtpSchema }),
  asyncHandler(authController.verifyResetOtp),
);
authRoutes.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(authController.resetPassword),
);

authRoutes.post('/refresh', asyncHandler(authController.refresh));
authRoutes.post('/logout', asyncHandler(authController.logout));
authRoutes.get('/me', authenticate, asyncHandler(authController.me));
