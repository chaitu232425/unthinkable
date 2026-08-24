/**
 * Contracts shared by the API and the web client.
 *
 * This file is the single definition of every enum and payload that crosses the
 * network boundary. Both workspaces import it through the `@shared/*` path alias,
 * so a change to a seat status or an error code is a compile error on both sides
 * rather than a runtime surprise.
 */

/* ------------------------------------------------------------------ enums */

export const USER_ROLES = ['CUSTOMER', 'ORGANISER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const EVENT_TYPES = ['MOVIE', 'CONCERT'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The three states the assignment names, as stored on `event_seats.status`. */
export const SEAT_STATUSES = ['AVAILABLE', 'HELD', 'BOOKED'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

/**
 * What the client actually renders. SELECTED is a purely client-side state: seats
 * the user has clicked but not yet sent to the server. It never exists in the database.
 */
export type SeatRenderStatus = SeatStatus | 'SELECTED';

export const HOLD_STATUSES = ['ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const HOLD_SOURCES = ['CHECKOUT', 'WAITLIST_OFFER'] as const;
export type HoldSource = (typeof HOLD_SOURCES)[number];

export const BOOKING_STATUSES = ['CONFIRMED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const WAITLIST_STATUSES = [
  'ACTIVE',
  'OFFERED',
  'FULFILLED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const OFFER_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/* ----------------------------------------------------------- error codes */

/**
 * Stable, machine-readable error codes. The client switches on these, never on
 * the human-readable message.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'CONFLICT',
  'SEATS_UNAVAILABLE',
  'SEAT_NOT_IN_EVENT',
  'HOLD_EXPIRED',
  'NOT_HOLD_OWNER',
  'BOOKING_CONFLICT',
  'ALREADY_CANCELLED',
  'CANCEL_WINDOW_CLOSED',
  'EVENT_NOT_PUBLISHED',
  'ALREADY_PUBLISHED',
  'IMMUTABLE_AFTER_PUBLISH',
  'MISSING_CATEGORY_PRICE',
  'ALREADY_WAITLISTED',
  'SEATS_STILL_AVAILABLE',
  'OFFER_EXPIRED',
  'INVALID_RESET_TOKEN',
  'INVALID_VERIFICATION_CODE',
  'ALREADY_CHECKED_IN',
  'INVALID_TICKET',
  'SEAT_IN_USE',
  'LOCK_TIMEOUT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation issues, or the seat labels that caused a 409. */
    details?: unknown;
    requestId?: string;
  };
}

/* ---------------------------------------------------------------- models */

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/**
 * `POST /api/auth/register` no longer creates the account directly — it sends a 6-digit
 * code to the given email and waits. The account is only created, and a session only
 * issued, once that code is confirmed via `POST /api/auth/verify-email`.
 */
export interface RegistrationPendingResponse {
  email: string;
  /** Seconds until the code expires and registration must be restarted. */
  expiresInSeconds: number;
}

/**
 * `POST /api/auth/verify-reset-otp` confirms the 6-digit code and, on success, issues a
 * short-lived, single-use authorisation for the actual `POST /api/auth/reset-password`
 * call — the code itself is never accepted as that authorisation.
 */
export interface ResetAuthorizationResponse {
  resetId: string;
  resetToken: string;
  /** Seconds until this authorisation expires and the code must be re-verified. */
  expiresInSeconds: number;
}

export interface SeatCategory {
  id: string;
  venueId: string;
  name: string;
  displayOrder: number;
  colorHex: string;
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  city: string;
  isActive: boolean;
  createdAt: string;
  seatCount?: number;
  categories?: SeatCategory[];
}

export interface VenueSeat {
  id: string;
  venueId: string;
  categoryId: string;
  rowLabel: string;
  seatNumber: number;
  label: string;
  gridRow: number;
  gridCol: number;
  isActive: boolean;
}

export interface EventPrice {
  categoryId: string;
  categoryName?: string;
  priceCents: number;
}

export interface CategoryAvailability {
  categoryId: string;
  categoryName: string;
  priceCents: number;
  total: number;
  available: number;
  held: number;
  booked: number;
  /** True when `available === 0` — the condition for joining the waitlist. */
  soldOut: boolean;
}

export interface EventSummary {
  id: string;
  title: string;
  type: EventType;
  status: EventStatus;
  description: string | null;
  posterUrl: string | null;
  startsAt: string;
  endsAt: string;
  currency: string;
  venue: { id: string; name: string; city: string; address?: string };
  organiser?: { id: string; fullName: string };
  minPriceCents: number | null;
  maxPriceCents: number | null;
  totalSeats: number;
  availableSeats: number;
}

export interface EventDetail extends EventSummary {
  holdTtlSeconds: number;
  offerTtlSeconds: number;
  seatMapRevision: number;
  prices: EventPrice[];
  availability: CategoryAvailability[];
}

/** One cell of the visual seat map. */
export interface SeatMapSeat {
  id: string;
  label: string;
  rowLabel: string;
  seatNumber: number;
  gridRow: number;
  gridCol: number;
  categoryId: string;
  categoryName: string;
  colorHex: string;
  priceCents: number;
  status: SeatStatus;
  /** Present only while `status === 'HELD'`. ISO-8601, server clock. */
  holdExpiresAt: string | null;
  /** True when the current user owns the hold on this seat. */
  heldByMe: boolean;
}

export interface SeatMapResponse {
  eventId: string;
  revision: number;
  rows: number;
  cols: number;
  seats: SeatMapSeat[];
  categories: SeatCategory[];
  /** Server time when this snapshot was taken — the client clock is not trusted. */
  serverTime: string;
}

export interface HoldResponse {
  holdId: string;
  eventId: string;
  expiresAt: string;
  ttlSeconds: number;
  serverTime: string;
  seats: Array<{ id: string; label: string; priceCents: number; categoryName: string }>;
  totalCents: number;
}

export interface BookingItem {
  id: string;
  eventSeatId: string;
  seatLabel: string;
  categoryId: string;
  categoryName: string;
  priceCents: number;
  status: 'ACTIVE' | 'CANCELLED';
}

export interface Booking {
  id: string;
  reference: string;
  status: BookingStatus;
  seatCount: number;
  totalCents: number;
  currency: string;
  createdAt: string;
  cancelledAt: string | null;
  checkedInAt: string | null;
  event: {
    id: string;
    title: string;
    type: EventType;
    startsAt: string;
    venueName: string;
    venueCity: string;
  };
  items: BookingItem[];
  /** PNG data URI. Only returned on the booking-detail endpoint. */
  qrDataUrl?: string;
  cancellable?: boolean;
}

export interface WaitlistEntry {
  id: string;
  eventId: string;
  categoryId: string;
  categoryName: string;
  seatsRequested: number;
  status: WaitlistStatus;
  /** 1-based position among ACTIVE entries; null once the entry leaves the queue. */
  position: number | null;
  queueLength: number;
  createdAt: string;
  activeOffer: WaitlistOfferSummary | null;
}

export interface WaitlistOfferSummary {
  id: string;
  status: OfferStatus;
  expiresAt: string;
  seatLabel: string;
  priceCents: number;
}

export interface WaitlistOfferDetail {
  id: string;
  status: OfferStatus;
  expiresAt: string;
  serverTime: string;
  seat: { id: string; label: string; categoryName: string; priceCents: number };
  event: { id: string; title: string; startsAt: string; venueName: string; currency: string };
}

export interface EventReport {
  eventId: string;
  title: string;
  startsAt: string;
  currency: string;
  totals: {
    seats: number;
    available: number;
    held: number;
    booked: number;
    grossRevenueCents: number;
    refundedCents: number;
    netRevenueCents: number;
    bookings: number;
    cancellations: number;
    waitlistDepth: number;
  };
  byCategory: Array<{
    categoryId: string;
    categoryName: string;
    priceCents: number;
    total: number;
    available: number;
    held: number;
    booked: number;
    grossRevenueCents: number;
    waitlistDepth: number;
  }>;
}

export interface OrganiserRevenue {
  currency: string;
  grossRevenueCents: number;
  netRevenueCents: number;
  refundedCents: number;
  bookings: number;
  cancellations: number;
  seatsSold: number;
  events: Array<{
    eventId: string;
    title: string;
    startsAt: string;
    seatsSold: number;
    grossRevenueCents: number;
    netRevenueCents: number;
  }>;
}

export interface AdminStats {
  users: Record<UserRole, number>;
  venues: number;
  events: Record<EventStatus, number>;
  bookings: { confirmed: number; cancelled: number };
  seats: Record<SeatStatus, number>;
  waitlist: { active: number; offered: number };
  outbox: { pending: number; sent: number; failed: number };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/* ------------------------------------------------------------ socket API */

export const SOCKET_EVENTS = {
  /** client → server */
  JOIN_EVENT: 'event:join',
  LEAVE_EVENT: 'event:leave',
  /** server → room `event:<id>` */
  SEAT_UPDATED: 'seat:updated',
  AVAILABILITY_UPDATED: 'availability:updated',
  /** server → room `user:<id>` */
  HOLD_EXPIRED: 'hold:expired',
  OFFER_CREATED: 'offer:created',
  OFFER_EXPIRED: 'offer:expired',
} as const;

export interface SeatUpdatedPayload {
  eventId: string;
  revision: number;
  seats: Array<{
    id: string;
    label: string;
    status: SeatStatus;
    holdExpiresAt: string | null;
    holdId: string | null;
  }>;
  at: string;
}

export interface AvailabilityUpdatedPayload {
  eventId: string;
  revision: number;
  byCategory: Array<{ categoryId: string; available: number; soldOut: boolean }>;
}

export interface HoldExpiredPayload {
  holdId: string;
  eventId: string;
  seatLabels: string[];
}

export interface OfferCreatedPayload {
  offerId: string;
  eventId: string;
  eventTitle: string;
  seatLabel: string;
  expiresAt: string;
}

/* ---------------------------------------------------------------- helpers */

/** Money is stored and transported as integer minor units. Never floats. */
export function formatMoney(cents: number, currency = 'INR', locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function seatSortKey(seat: { gridRow: number; gridCol: number }): number {
  return seat.gridRow * 10_000 + seat.gridCol;
}
