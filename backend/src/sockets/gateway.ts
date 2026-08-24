import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  type AvailabilityUpdatedPayload,
  type HoldExpiredPayload,
  type OfferCreatedPayload,
  type SeatUpdatedPayload,
} from '@shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { verifyAccessToken } from '../utils/jwt.js';

/**
 * Real-time seat updates.
 *
 * The contract with the rest of the system: sockets ACCELERATE, REST DECIDES. Every
 * payload carries the event's monotonic `revision`; a client that sees a gap throws
 * away its local map and refetches `GET /events/:id/seats`. Nothing here is ever the
 * source of truth, which is why a dropped connection degrades responsiveness and
 * never correctness.
 */

let io: SocketServer | null = null;

export const eventRoom = (eventId: string) => `event:${eventId}`;
export const userRoom = (userId: string) => `user:${userId}`;

export function initSockets(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    // Long enough to survive a laptop lid closing briefly, short enough to free rooms.
    pingTimeout: 25_000,
  });

  /**
   * The handshake authenticates with the same access token the REST API uses.
   * Anonymous connections are allowed — the seat map is public — but only an
   * authenticated socket joins its private user room, so hold-expiry and offer
   * notifications cannot be received by someone else.
   */
  io.use((socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer /i, '');
    if (!token) return next();
    try {
      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
    } catch {
      // Expired token: continue as anonymous rather than refusing the connection.
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string | undefined;
    if (userId) void socket.join(userRoom(userId));

    socket.on(SOCKET_EVENTS.JOIN_EVENT, (payload: { eventId?: string }, ack?: (r: unknown) => void) => {
      const eventId = payload?.eventId;
      if (typeof eventId !== 'string' || eventId.length === 0) {
        ack?.({ ok: false, error: 'eventId is required' });
        return;
      }
      void socket.join(eventRoom(eventId));
      ack?.({ ok: true, room: eventRoom(eventId) });
    });

    socket.on(SOCKET_EVENTS.LEAVE_EVENT, (payload: { eventId?: string }) => {
      if (typeof payload?.eventId === 'string') void socket.leave(eventRoom(payload.eventId));
    });

    socket.on('error', (err) => logger.warn({ err }, 'socket error'));
  });

  logger.info('socket.io gateway ready');
  return io;
}

export function getIo(): SocketServer | null {
  return io;
}

export async function closeSockets(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}

/* ------------------------------------------------------------------ emitters */
/*
 * Every emitter is a no-op when the gateway is not initialised, so services and jobs
 * can be exercised in tests without booting an HTTP server.
 *
 * These are only ever called from a transaction's `afterCommit` hook.
 */

export function emitSeatUpdate(payload: SeatUpdatedPayload): void {
  io?.to(eventRoom(payload.eventId)).emit(SOCKET_EVENTS.SEAT_UPDATED, payload);
}

export function emitAvailability(payload: AvailabilityUpdatedPayload): void {
  io?.to(eventRoom(payload.eventId)).emit(SOCKET_EVENTS.AVAILABILITY_UPDATED, payload);
}

export function emitHoldExpired(userId: string, payload: HoldExpiredPayload): void {
  io?.to(userRoom(userId)).emit(SOCKET_EVENTS.HOLD_EXPIRED, payload);
}

export function emitOfferCreated(userId: string, payload: OfferCreatedPayload): void {
  io?.to(userRoom(userId)).emit(SOCKET_EVENTS.OFFER_CREATED, payload);
}

export function emitOfferExpired(userId: string, payload: { offerId: string; eventId: string }): void {
  io?.to(userRoom(userId)).emit(SOCKET_EVENTS.OFFER_EXPIRED, payload);
}
