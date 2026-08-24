import pino from 'pino';
import { env } from './env.js';

/**
 * Structured logging. In development the output is piped through pino-pretty when it
 * is installed; in production it stays newline-delimited JSON so Render can index it.
 *
 * `redact` matters here: this service handles passwords, JWTs and offer tokens, and
 * none of them should ever reach a log aggregator.
 */
const transport =
  env.isProduction || env.isTest
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      };

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'password_hash',
      'accessToken',
      'refreshToken',
      'token',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(transport ? { transport } : {}),
});

export type Logger = typeof logger;
