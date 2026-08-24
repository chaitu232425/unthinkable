import { env } from '../config/env.js';

/**
 * OpenAPI 3.0 description of the API.
 *
 * Hand-written rather than generated, and kept honest by `tests/unit/openapi.test.ts`,
 * which walks the live Express router stack and fails if any route is missing from this
 * document (or documented but not mounted). That test is what stops the spec rotting.
 */

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const json = (ref: string, description = 'Success') => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const bearer = [{ bearerAuth: [] }];

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path' as const,
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description,
});

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Ticket Booking System API',
    version: '1.0.0',
    description: [
      'Ticket booking platform for movies and concerts.',
      '',
      '**Concurrency contract.** Seat holds and bookings are serialised by MongoDB',
      'multi-document transactions: a guarded, count-asserting update claims the requested',
      'seats, and a transaction that loses a write-conflict race is automatically replayed',
      'against the winner\'s committed state. When two customers request the same seat',
      'simultaneously exactly one receives `201`; the other receives `409',
      'SEATS_UNAVAILABLE`. Double booking is additionally made unstorable by a partial',
      'unique index on `booking_items(event_seat_id)` scoped to `status: \'ACTIVE\'`.',
      '',
      '**Seat hold TTL.** Holds carry an absolute `expiresAt`. A hold past its expiry is',
      'treated as available by every read and every write immediately — a background',
      'sweeper tidies rows and pushes updates, but correctness never depends on it having',
      'run.',
      '',
      '**Idempotency.** `bookings.hold_id` is UNIQUE, so confirming the same hold twice',
      'returns the original booking with `200` instead of creating a second one.',
    ].join('\n'),
  },
  servers: [{ url: env.API_URL, description: 'This deployment' }],
  tags: [
    { name: 'Auth', description: 'Registration, login, rotating refresh tokens' },
    { name: 'Venues', description: 'Admin-only venue geometry and seat layouts' },
    { name: 'Events', description: 'Listings, seat maps, availability' },
    { name: 'Holds', description: 'Seat holds with configurable TTL' },
    { name: 'Bookings', description: 'Confirmation, history, cancellation' },
    { name: 'Waitlist', description: 'FIFO queue and time-limited offers' },
    { name: 'Tickets', description: 'QR verification at the gate' },
    { name: 'Reports', description: 'Organiser summaries and revenue' },
    { name: 'System', description: 'Health and documentation' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                example: 'SEATS_UNAVAILABLE',
                description: 'Stable machine-readable code. Switch on this, not the message.',
              },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      PublicUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          fullName: { type: 'string' },
          role: { type: 'string', enum: ['CUSTOMER', 'ORGANISER', 'ADMIN'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/PublicUser' },
          accessToken: { type: 'string' },
          expiresIn: { type: 'integer', example: 900 },
        },
      },
      RegistrationPendingResponse: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          expiresInSeconds: { type: 'integer', example: 900 },
        },
      },
      ResetAuthorizationResponse: {
        type: 'object',
        properties: {
          resetId: { type: 'string', format: 'uuid' },
          resetToken: {
            type: 'string',
            description: 'Short-lived, single-use authorisation. Not the emailed code — pass this to /api/auth/reset-password.',
          },
          expiresInSeconds: { type: 'integer', example: 600 },
        },
      },
      Venue: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          address: { type: 'string' },
          city: { type: 'string' },
          isActive: { type: 'boolean' },
          seatCount: { type: 'integer' },
        },
      },
      SeatCategory: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          venueId: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Premium' },
          displayOrder: { type: 'integer' },
          colorHex: { type: 'string', example: '#0F6FA8' },
        },
      },
      EventSummary: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          type: { type: 'string', enum: ['MOVIE', 'CONCERT'] },
          status: { type: 'string', enum: ['DRAFT', 'PUBLISHED', 'CANCELLED', 'COMPLETED'] },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          currency: { type: 'string', example: 'INR' },
          totalSeats: { type: 'integer' },
          availableSeats: { type: 'integer' },
          minPriceCents: { type: 'integer', nullable: true },
          maxPriceCents: { type: 'integer', nullable: true },
        },
      },
      SeatMapResponse: {
        type: 'object',
        properties: {
          eventId: { type: 'string', format: 'uuid' },
          revision: {
            type: 'integer',
            description:
              'Monotonic per-event counter. Socket deltas carry the same value; a gap means the client must refetch this endpoint.',
          },
          rows: { type: 'integer' },
          cols: { type: 'integer' },
          serverTime: {
            type: 'string',
            format: 'date-time',
            description: 'Countdowns must be computed against this, not the browser clock.',
          },
          categories: { type: 'array', items: { $ref: '#/components/schemas/SeatCategory' } },
          seats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                label: { type: 'string', example: 'A12' },
                gridRow: { type: 'integer' },
                gridCol: { type: 'integer' },
                categoryId: { type: 'string', format: 'uuid' },
                categoryName: { type: 'string' },
                priceCents: { type: 'integer' },
                status: { type: 'string', enum: ['AVAILABLE', 'HELD', 'BOOKED'] },
                holdExpiresAt: { type: 'string', format: 'date-time', nullable: true },
                heldByMe: { type: 'boolean' },
              },
            },
          },
        },
      },
      HoldResponse: {
        type: 'object',
        properties: {
          holdId: { type: 'string', format: 'uuid' },
          eventId: { type: 'string', format: 'uuid' },
          expiresAt: { type: 'string', format: 'date-time' },
          ttlSeconds: { type: 'integer', example: 600 },
          serverTime: { type: 'string', format: 'date-time' },
          totalCents: { type: 'integer' },
          seats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                label: { type: 'string' },
                priceCents: { type: 'integer' },
                categoryName: { type: 'string' },
              },
            },
          },
        },
      },
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference: { type: 'string', example: 'BK-7F3K2M9Q' },
          status: { type: 'string', enum: ['CONFIRMED', 'CANCELLED'] },
          seatCount: { type: 'integer' },
          totalCents: { type: 'integer' },
          currency: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          cancellable: { type: 'boolean' },
          qrDataUrl: {
            type: 'string',
            description: 'PNG data URI encoding the signed ticket payload.',
          },
          items: { type: 'array', items: { type: 'object' } },
        },
      },
      WaitlistEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          categoryName: { type: 'string' },
          status: {
            type: 'string',
            enum: ['ACTIVE', 'OFFERED', 'FULFILLED', 'CANCELLED', 'EXPIRED'],
          },
          position: { type: 'integer', nullable: true, description: '1-based FIFO position.' },
          queueLength: { type: 'integer' },
          activeOffer: { type: 'object', nullable: true },
        },
      },
      WaitlistOfferDetail: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED'] },
          expiresAt: { type: 'string', format: 'date-time' },
          serverTime: { type: 'string', format: 'date-time' },
          seat: { type: 'object' },
          event: { type: 'object' },
        },
      },
      EventReport: { type: 'object' },
      OrganiserRevenue: { type: 'object' },
      AdminStats: { type: 'object' },
      Paginated: {
        type: 'object',
        properties: {
          items: { type: 'array', items: {} },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
    },
  },
  paths: {
    /* ------------------------------------------------------------------ auth */
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Start creating a customer or organiser account',
        description: [
          "Step 1 of 2. Doesn't create the account yet — stages it and emails a 6-digit",
          'code to the given address. Call `/api/auth/verify-email` with that code to',
          'actually create the account and receive a session. ADMIN accounts cannot be',
          'self-registered; they are provisioned by the seed script.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fullName', 'email', 'password'],
                properties: {
                  fullName: { type: 'string', minLength: 2 },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 10 },
                  role: { type: 'string', enum: ['CUSTOMER', 'ORGANISER'], default: 'CUSTOMER' },
                },
              },
            },
          },
        },
        responses: {
          200: json('RegistrationPendingResponse', 'Code emailed; no session yet'),
          409: err('EMAIL_TAKEN'),
          422: err('VALIDATION_ERROR'),
          429: err('RATE_LIMITED'),
        },
      },
    },
    '/api/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Complete registration with the emailed code',
        description:
          'Step 2 of 2. Creates the account and issues a session, but only once — the code is consumed on success, and after a few wrong guesses (or once it expires) registration must be restarted from `/api/auth/register`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'code'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  code: { type: 'string', pattern: '^[0-9]{6}$' },
                },
              },
            },
          },
        },
        responses: {
          201: json('AuthResponse', 'Account created; refresh token set as an httpOnly cookie'),
          409: err('EMAIL_TAKEN — someone else claimed the address before this code was confirmed'),
          410: err('INVALID_VERIFICATION_CODE — wrong, expired, or out of attempts'),
          422: err('VALIDATION_ERROR'),
          429: err('RATE_LIMITED'),
        },
      },
    },
    '/api/auth/verify-email/resend': {
      post: {
        tags: ['Auth'],
        summary: 'Resend the registration verification code',
        description: [
          'For a registration already in flight (a pending, unverified `/api/auth/register`',
          'call) — reuses the name/password/role already supplied and sends a fresh code.',
          `Limited to one send per address per OTP_RESEND_COOLDOWN_SECONDS.`,
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
            },
          },
        },
        responses: {
          200: json('RegistrationPendingResponse', 'A new code was emailed'),
          404: err('NOT_FOUND — no pending registration for that email'),
          422: err('VALIDATION_ERROR'),
          429: err('RATE_LIMITED — either the blanket IP limit or the per-email resend cooldown'),
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: json('AuthResponse'),
          401: err('INVALID_CREDENTIALS'),
          429: err('RATE_LIMITED'),
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token',
        description:
          'Consumes the presented token and issues a new one. Presenting an already-rotated token is treated as theft and revokes every session for that user.',
        responses: { 200: json('AuthResponse'), 401: err('UNAUTHORIZED') },
      },
    },
    '/api/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke the refresh token', responses: { 204: { description: 'Signed out' } } },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user',
        security: bearer,
        responses: { 200: json('PublicUser'), 401: err('UNAUTHORIZED') },
      },
    },
    '/api/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password-reset code (step 1 of 3)',
        description: [
          'Always responds 204, whatever happened internally. Self-service reset is',
          'offered to CUSTOMER and ORGANISER accounts only — the response is identical',
          'whether the address is unregistered, deactivated, belongs to an ADMIN',
          '(provisioned out of band), or is inside its resend cooldown, so nothing about',
          'the account is ever revealed. If a reset was actually possible, a 6-digit code',
          'is emailed; confirm it with `/api/auth/verify-reset-otp`.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
            },
          },
        },
        responses: { 204: { description: 'A reset code was sent, if that was possible' }, 429: err('RATE_LIMITED') },
      },
    },
    '/api/auth/verify-reset-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm the password-reset code (step 2 of 3)',
        description: [
          'Does not change the password. On success, issues a short-lived, single-use',
          '`resetToken` that `/api/auth/reset-password` requires — the emailed code itself',
          'is never accepted there, so it cannot be replayed as that authorisation.',
        ].join('\n'),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'code'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  code: { type: 'string', pattern: '^[0-9]{6}$' },
                },
              },
            },
          },
        },
        responses: {
          200: json('ResetAuthorizationResponse'),
          410: err('INVALID_VERIFICATION_CODE — wrong, expired, or out of attempts'),
          422: err('VALIDATION_ERROR'),
          429: err('RATE_LIMITED'),
        },
      },
    },
    '/api/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Complete a password reset (step 3 of 3)',
        description:
          'Requires the resetToken issued by /api/auth/verify-reset-otp, which works once and expires after PASSWORD_RESET_AUTHORIZATION_TTL_MINUTES. Succeeding revokes every existing session for the account, so anyone but the owner is locked out too.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['resetId', 'resetToken', 'password'],
                properties: {
                  resetId: { type: 'string', format: 'uuid', description: 'From verify-reset-otp' },
                  resetToken: { type: 'string', description: 'The authorisation from verify-reset-otp — not the emailed code' },
                  password: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: {
          204: { description: 'Password changed; every session for the account was revoked' },
          410: err('INVALID_RESET_TOKEN — the authorisation is unknown, already used, or expired'),
          422: err('VALIDATION_ERROR'),
          429: err('RATE_LIMITED'),
        },
      },
    },

    /* ---------------------------------------------------------------- venues */
    '/api/venues': {
      get: {
        tags: ['Venues'],
        summary: 'List venues',
        security: bearer,
        parameters: [
          { name: 'city', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: json('Paginated'), 401: err('UNAUTHORIZED') },
      },
      post: {
        tags: ['Venues'],
        summary: 'Create a venue',
        security: bearer,
        description: 'ADMIN only.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'address', 'city'],
                properties: {
                  name: { type: 'string' },
                  address: { type: 'string' },
                  city: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: json('Venue'), 403: err('FORBIDDEN') },
      },
    },
    '/api/venues/{id}': {
      get: {
        tags: ['Venues'],
        summary: 'Venue with categories and seat layout',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 200: json('Venue'), 404: err('NOT_FOUND') },
      },
      patch: {
        tags: ['Venues'],
        summary: 'Update venue metadata',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 200: json('Venue'), 403: err('FORBIDDEN') },
      },
      delete: {
        tags: ['Venues'],
        summary: 'Deactivate a venue',
        description: 'Refused with SEAT_IN_USE while published events reference it.',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 200: json('Venue'), 409: err('SEAT_IN_USE') },
      },
    },
    '/api/venues/{id}/categories': {
      get: {
        tags: ['Venues'],
        summary: 'List seat categories',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 200: { description: 'Categories' } },
      },
      post: {
        tags: ['Venues'],
        summary: 'Add a seat category',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 201: json('SeatCategory'), 409: err('CONFLICT') },
      },
    },
    '/api/venues/{id}/categories/{categoryId}': {
      patch: {
        tags: ['Venues'],
        summary: 'Update a seat category',
        security: bearer,
        parameters: [pathParam('id', 'Venue id'), pathParam('categoryId', 'Category id')],
        responses: { 200: json('SeatCategory'), 404: err('NOT_FOUND') },
      },
    },
    '/api/venues/{id}/seats': {
      get: {
        tags: ['Venues'],
        summary: 'Physical seat layout',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 200: { description: 'Seats' } },
      },
    },
    '/api/venues/{id}/seats/bulk': {
      post: {
        tags: ['Venues'],
        summary: 'Generate a seat layout from a row specification',
        description:
          'One transaction. `{ rows: [{ rowLabel: "A", categoryId, count: 12 }] }` creates A1..A12.',
        security: bearer,
        parameters: [pathParam('id', 'Venue id')],
        responses: { 201: { description: 'Seats created' }, 409: err('CONFLICT') },
      },
    },
    '/api/venues/{id}/seats/{seatId}': {
      delete: {
        tags: ['Venues'],
        summary: 'Remove a seat',
        security: bearer,
        parameters: [pathParam('id', 'Venue id'), pathParam('seatId', 'Seat id')],
        responses: { 204: { description: 'Removed' }, 409: err('SEAT_IN_USE') },
      },
    },

    /* ---------------------------------------------------------------- events */
    '/api/events': {
      get: {
        tags: ['Events'],
        summary: 'Browse published events',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['MOVIE', 'CONCERT'] } },
          { name: 'city', in: 'query', schema: { type: 'string' } },
          { name: 'venueId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'dateFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'dateTo', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'minPrice', in: 'query', schema: { type: 'integer' } },
          { name: 'maxPrice', in: 'query', schema: { type: 'integer' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['soonest', 'latest', 'price_asc', 'price_desc', 'title'] } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: json('Paginated') },
      },
      post: {
        tags: ['Events'],
        summary: 'Create an event (DRAFT)',
        security: bearer,
        responses: { 201: json('EventSummary'), 403: err('FORBIDDEN'), 422: err('VALIDATION_ERROR') },
      },
    },
    '/api/events/mine': {
      get: {
        tags: ['Events'],
        summary: "The organiser's own events",
        security: bearer,
        responses: { 200: json('Paginated') },
      },
    },
    '/api/events/{id}': {
      get: {
        tags: ['Events'],
        summary: 'Event detail with per-category availability',
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('EventSummary'), 404: err('NOT_FOUND') },
      },
      patch: {
        tags: ['Events'],
        summary: 'Update an event',
        description:
          'Once published, venue, pricing, start time and type are frozen and return 409 IMMUTABLE_AFTER_PUBLISH.',
        security: bearer,
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('EventSummary'), 409: err('IMMUTABLE_AFTER_PUBLISH') },
      },
    },
    '/api/events/{id}/publish': {
      post: {
        tags: ['Events'],
        summary: 'Publish and materialise seat inventory',
        description: 'Idempotent. Requires a price for every seat category used by the venue.',
        security: bearer,
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('EventSummary'), 422: err('MISSING_CATEGORY_PRICE') },
      },
    },
    '/api/events/{id}/cancel': {
      post: {
        tags: ['Events'],
        summary: 'Cancel an event',
        description: 'Expires every hold and pending offer, closes waitlists, notifies bookers.',
        security: bearer,
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('EventSummary'), 409: err('CONFLICT') },
      },
    },
    '/api/events/{id}/seats': {
      get: {
        tags: ['Events'],
        summary: 'The seat map',
        description:
          'The authoritative seat state and the repair endpoint for socket clients. Expired holds are already reported as AVAILABLE.',
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('SeatMapResponse'), 409: err('EVENT_NOT_PUBLISHED') },
      },
    },
    '/api/events/{id}/availability': {
      get: {
        tags: ['Events'],
        summary: 'Per-category availability',
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: { description: 'Availability by category' } },
      },
    },

    /* ----------------------------------------------------------------- holds */
    '/api/events/{eventId}/holds': {
      post: {
        tags: ['Holds'],
        summary: 'Hold seats (all-or-nothing)',
        description: [
          'Opens a transaction, re-checks availability against the current snapshot, then',
          'claims the requested seats with a guarded update and a modified-count assertion.',
          'A transaction that loses a write-conflict race to another request is retried',
          'automatically against the winner\'s committed state.',
          '',
          'When two customers request the same seat simultaneously, exactly one receives 201.',
          'The other receives 409 with the conflicting seats.',
        ].join('\n'),
        security: bearer,
        parameters: [pathParam('eventId', 'Event id')],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['seatIds'],
                properties: {
                  seatIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
        },
        responses: {
          201: json('HoldResponse'),
          404: err('SEAT_NOT_IN_EVENT — one or more seats do not belong to this event'),
          409: err('SEATS_UNAVAILABLE — details.conflicts lists the seats that were taken'),
          429: err('RATE_LIMITED'),
          503: err('LOCK_TIMEOUT — the rows were locked for longer than lock_timeout'),
        },
      },
    },
    '/api/holds': {
      get: {
        tags: ['Holds'],
        summary: 'Active holds for the current customer',
        security: bearer,
        responses: { 200: { description: 'Holds' } },
      },
    },
    '/api/holds/{holdId}': {
      get: {
        tags: ['Holds'],
        summary: 'Hold detail with remaining TTL',
        security: bearer,
        parameters: [pathParam('holdId', 'Hold id')],
        responses: { 200: json('HoldResponse'), 410: err('HOLD_EXPIRED'), 404: err('NOT_FOUND') },
      },
      delete: {
        tags: ['Holds'],
        summary: 'Release a hold early',
        security: bearer,
        parameters: [pathParam('holdId', 'Hold id')],
        responses: { 204: { description: 'Released' }, 403: err('FORBIDDEN') },
      },
    },

    /* -------------------------------------------------------------- bookings */
    '/api/bookings': {
      post: {
        tags: ['Bookings'],
        summary: 'Confirm a hold into a booking',
        description:
          'Idempotent through `UNIQUE(bookings.hold_id)` — a repeated confirm returns the original booking with 200 rather than creating a second.',
        security: bearer,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['holdId'],
                properties: {
                  holdId: { type: 'string', format: 'uuid' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: json('Booking', 'Booking created'),
          200: json('Booking', 'Replay of an earlier confirm'),
          403: err('NOT_HOLD_OWNER'),
          409: err('BOOKING_CONFLICT'),
          410: err('HOLD_EXPIRED'),
        },
      },
      get: {
        tags: ['Bookings'],
        summary: 'Booking history for the current customer',
        security: bearer,
        responses: { 200: json('Paginated') },
      },
    },
    '/api/bookings/{id}': {
      get: {
        tags: ['Bookings'],
        summary: 'Booking detail with QR',
        description:
          'Visible to the owning customer, the organiser of that event, and admins. Everyone else receives 404 rather than 403.',
        security: bearer,
        parameters: [pathParam('id', 'Booking id')],
        responses: { 200: json('Booking'), 404: err('NOT_FOUND') },
      },
    },
    '/api/bookings/{id}/qr.png': {
      get: {
        tags: ['Bookings'],
        summary: 'Ticket QR as PNG',
        security: bearer,
        parameters: [pathParam('id', 'Booking id')],
        responses: { 200: { description: 'image/png' }, 404: err('NOT_FOUND') },
      },
    },
    '/api/bookings/{id}/cancel': {
      post: {
        tags: ['Bookings'],
        summary: 'Cancel a booking, in full or in part',
        description: [
          'Releases the seats and enqueues a waitlist-assignment job. The offer itself is',
          'made asynchronously so a busy queue can never slow down or fail a cancellation.',
          '',
          'Pass `itemIds` to cancel only some of the booking\'s seats — the rest stay',
          'CONFIRMED. Omit it (or list every still-active item) to cancel the whole',
          'booking; the booking itself only transitions to CANCELLED once its last active',
          'seat has been given back, so repeated partial cancellations converge on the',
          'same end state a single full cancellation would reach.',
        ].join('\n'),
        security: bearer,
        parameters: [pathParam('id', 'Booking id')],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  itemIds: {
                    type: 'array',
                    items: { type: 'string', format: 'uuid' },
                    description: 'Booking item ids to cancel. Omit to cancel the whole booking.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: json('Booking'),
          409: err('ALREADY_CANCELLED or CANCEL_WINDOW_CLOSED'),
          404: err('NOT_FOUND'),
          422: err('VALIDATION_ERROR — an itemId does not belong to this booking or is already cancelled'),
        },
      },
    },

    /* -------------------------------------------------------------- waitlist */
    '/api/events/{eventId}/waitlist': {
      post: {
        tags: ['Waitlist'],
        summary: 'Join the queue for one seat category',
        description: 'Allowed only when that category has zero effectively-available seats.',
        security: bearer,
        parameters: [pathParam('eventId', 'Event id')],
        responses: {
          201: json('WaitlistEntry'),
          409: err('ALREADY_WAITLISTED or SEATS_STILL_AVAILABLE'),
        },
      },
    },
    '/api/events/{eventId}/waitlist/me': {
      get: {
        tags: ['Waitlist'],
        summary: 'My queue places for this event',
        security: bearer,
        parameters: [pathParam('eventId', 'Event id')],
        responses: { 200: { description: 'Entries with live FIFO positions' } },
      },
    },
    '/api/waitlist': {
      get: {
        tags: ['Waitlist'],
        summary: 'All my queue places',
        security: bearer,
        responses: { 200: { description: 'Entries' } },
      },
    },
    '/api/waitlist/{entryId}': {
      delete: {
        tags: ['Waitlist'],
        summary: 'Leave the queue',
        description: 'If an offer is pending it is declined and cascaded to the next person immediately.',
        security: bearer,
        parameters: [pathParam('entryId', 'Waitlist entry id')],
        responses: { 204: { description: 'Left the queue' }, 404: err('NOT_FOUND') },
      },
    },
    '/api/waitlist/offers/{offerId}': {
      get: {
        tags: ['Waitlist'],
        summary: 'Read a time-limited offer',
        description:
          'Requires both the opaque token from the email link and an authenticated session belonging to the offered customer.',
        security: bearer,
        parameters: [
          pathParam('offerId', 'Offer id'),
          { name: 't', in: 'query', required: true, schema: { type: 'string' }, description: 'Opaque single-use token' },
        ],
        responses: { 200: json('WaitlistOfferDetail'), 410: err('OFFER_EXPIRED'), 404: err('NOT_FOUND') },
      },
    },
    '/api/waitlist/offers/{offerId}/accept': {
      post: {
        tags: ['Waitlist'],
        summary: 'Accept an offer',
        description: "Converts the offer's backing hold into a booking through the normal booking path.",
        security: bearer,
        parameters: [
          pathParam('offerId', 'Offer id'),
          { name: 't', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { 201: json('Booking'), 200: json('Booking', 'Replay'), 410: err('OFFER_EXPIRED') },
      },
    },
    '/api/waitlist/offers/{offerId}/decline': {
      post: {
        tags: ['Waitlist'],
        summary: 'Decline an offer',
        description: 'Releases the seat immediately and offers it to the next person in line.',
        security: bearer,
        parameters: [
          pathParam('offerId', 'Offer id'),
          { name: 't', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Declined' } },
      },
    },

    /* --------------------------------------------------------------- tickets */
    '/api/tickets/verify': {
      post: {
        tags: ['Tickets'],
        summary: 'Verify a scanned QR at the gate',
        description:
          'Checks the HMAC signature before touching the database, then the booking state. A ticket may be scanned once; a second scan returns 409 ALREADY_CHECKED_IN.',
        security: bearer,
        responses: {
          200: { description: 'Valid — the booking is now checked in' },
          409: err('ALREADY_CHECKED_IN or INVALID_TICKET'),
          422: err('VALIDATION_ERROR — signature did not verify'),
        },
      },
    },

    /* --------------------------------------------------------------- reports */
    '/api/organiser/events/{id}/summary': {
      get: {
        tags: ['Reports'],
        summary: 'Seats sold/held/available and revenue for one event',
        security: bearer,
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('EventReport'), 404: err('NOT_FOUND') },
      },
    },
    '/api/organiser/events/{id}/bookings': {
      get: {
        tags: ['Reports'],
        summary: 'Bookings for one event',
        security: bearer,
        parameters: [pathParam('id', 'Event id')],
        responses: { 200: json('Paginated') },
      },
    },
    '/api/organiser/revenue': {
      get: {
        tags: ['Reports'],
        summary: "Revenue across the organiser's own events",
        security: bearer,
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: json('OrganiserRevenue') },
      },
    },
    '/api/admin/stats': {
      get: {
        tags: ['Reports'],
        summary: 'System-wide counts',
        security: bearer,
        responses: { 200: json('AdminStats'), 403: err('FORBIDDEN') },
      },
    },
    '/api/notifications': {
      get: {
        tags: ['Reports'],
        summary: 'My notification history',
        security: bearer,
        responses: { 200: { description: 'Notifications' } },
      },
    },

    /* ---------------------------------------------------------------- system */
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness and database check',
        description: 'Runs a real `SELECT 1`; also reports when each background job last ran.',
        responses: {
          200: { description: 'Healthy' },
          503: { description: 'Database unreachable' },
        },
      },
    },
  },
} as const;

export type OpenApiDocument = typeof openApiDocument;
