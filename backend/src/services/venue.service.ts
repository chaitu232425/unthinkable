import type { SeatCategory, Venue, VenueSeat } from '@shared';
import { isDuplicateKeyError, pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import {
  categoryRepo,
  toCategory,
  toVenue,
  toVenueSeat,
  venueRepo,
  venueSeatRepo,
} from '../repositories/venue.repo.js';
import { conflict, notFound, validationError } from '../utils/errors.js';
import { paginate, type PageParams } from '../utils/http.js';

export interface RowSpec {
  rowLabel: string;
  categoryId: string;
  count: number;
  startNumber?: number;
  gridRow?: number;
  startCol?: number;
}

export const venueService = {
  async create(input: { name: string; address: string; city: string; adminId: string }): Promise<Venue> {
    const row = await venueRepo.create(pool, { ...input, createdBy: input.adminId });
    return toVenue(row);
  },

  async list(filters: { city?: string; includeInactive?: boolean }, page: PageParams) {
    const { rows, total } = await venueRepo.list(pool, {
      ...filters,
      limit: page.limit,
      offset: page.offset,
    });
    return paginate(rows.map(toVenue), total, page);
  },

  async detail(id: string): Promise<Venue & { categories: SeatCategory[]; seats: VenueSeat[] }> {
    const row = await venueRepo.findById(pool, id);
    if (!row) throw notFound('Venue');
    const [categories, seats] = await Promise.all([
      categoryRepo.listByVenue(pool, id),
      venueSeatRepo.listByVenue(pool, id),
    ]);
    return {
      ...toVenue(row),
      categories: categories.map(toCategory),
      seats: seats.map(toVenueSeat),
    };
  },

  async update(
    id: string,
    patch: { name?: string; address?: string; city?: string; isActive?: boolean },
  ): Promise<Venue> {
    const row = await venueRepo.update(pool, id, patch);
    if (!row) throw notFound('Venue');
    return toVenue(row);
  },

  /**
   * Deactivation rather than deletion. A venue referenced by a published event has
   * seats materialised into `event_seats`, and deleting it would orphan real bookings —
   * the foreign keys use ON DELETE RESTRICT precisely so that cannot happen quietly.
   */
  async deactivate(id: string): Promise<Venue> {
    const published = await venueRepo.countPublishedEvents(pool, id);
    if (published > 0) {
      throw conflict(
        'SEAT_IN_USE',
        `This venue hosts ${published} published event(s) and cannot be removed. It has been kept active.`,
      );
    }
    const row = await venueRepo.update(pool, id, { isActive: false });
    if (!row) throw notFound('Venue');
    return toVenue(row);
  },

  /* ------------------------------------------------------------ categories */

  async addCategory(
    venueId: string,
    input: { name: string; displayOrder: number; colorHex: string },
  ): Promise<SeatCategory> {
    const venue = await venueRepo.findById(pool, venueId);
    if (!venue) throw notFound('Venue');
    try {
      const row = await categoryRepo.create(pool, { venueId, ...input });
      return toCategory(row);
    } catch (err) {
      if (isDuplicateKeyError(err, 'uq_category_name')) {
        throw conflict('CONFLICT', `This venue already has a "${input.name}" category.`);
      }
      throw err;
    }
  },

  async updateCategory(
    venueId: string,
    categoryId: string,
    patch: { name?: string; displayOrder?: number; colorHex?: string },
  ): Promise<SeatCategory> {
    const existing = await categoryRepo.findById(pool, categoryId);
    if (!existing || existing.venue_id !== venueId) throw notFound('Seat category');
    const row = await categoryRepo.update(pool, categoryId, patch);
    if (!row) throw notFound('Seat category');
    return toCategory(row);
  },

  async listCategories(venueId: string): Promise<SeatCategory[]> {
    const rows = await categoryRepo.listByVenue(pool, venueId);
    return rows.map(toCategory);
  },

  /* ----------------------------------------------------------------- seats */

  /**
   * Bulk seat generation from a row specification.
   *
   * The admin UI sends `{ rows: [{ rowLabel: 'A', categoryId, count: 12 }, ...] }` and
   * the whole auditorium is created in one transaction. Building a 500-seat venue with
   * 500 individual POSTs would be slow, non-atomic, and would leave a half-built layout
   * behind if the browser closed halfway through.
   */
  async bulkCreateSeats(
    venueId: string,
    rowsSpec: RowSpec[],
  ): Promise<{ created: number; totalSeats: number }> {
    const venue = await venueRepo.findById(pool, venueId);
    if (!venue) throw notFound('Venue');

    const categories = await categoryRepo.listByVenue(pool, venueId);
    const categoryIds = new Set(categories.map((c) => c.id));

    const seats: Array<{
      categoryId: string;
      rowLabel: string;
      seatNumber: number;
      gridRow: number;
      gridCol: number;
    }> = [];

    const existing = await venueSeatRepo.countByVenue(pool, venueId);
    // Auto-assigned rows continue after whatever grid rows this venue already has —
    // starting back at 0 every request collided new rows onto row 1's existing seats
    // (same grid_row, same grid_col) the moment a venue already had any seats.
    let autoGridRow = await venueSeatRepo.maxGridRow(pool, venueId);
    const usedRowLabels = new Set<string>();

    for (const spec of rowsSpec) {
      if (!categoryIds.has(spec.categoryId)) {
        throw validationError(`Category ${spec.categoryId} does not belong to this venue.`);
      }
      if (usedRowLabels.has(spec.rowLabel)) {
        throw validationError(`Row "${spec.rowLabel}" appears twice in the request.`);
      }
      usedRowLabels.add(spec.rowLabel);

      autoGridRow += 1;
      const gridRow = spec.gridRow ?? autoGridRow;
      const startNumber = spec.startNumber ?? 1;
      const startCol = spec.startCol ?? 1;

      for (let i = 0; i < spec.count; i += 1) {
        seats.push({
          categoryId: spec.categoryId,
          rowLabel: spec.rowLabel,
          seatNumber: startNumber + i,
          gridRow,
          gridCol: startCol + i,
        });
      }
    }

    if (existing + seats.length > env.MAX_VENUE_SEATS) {
      throw validationError(
        `A venue is limited to ${env.MAX_VENUE_SEATS} seats. This request would bring the total to ${
          existing + seats.length
        }.`,
      );
    }

    return withTransaction(async (tx) => {
      let created: number;
      try {
        created = await venueSeatRepo.bulkInsert(tx, venueId, seats);
      } catch (err) {
        if (isDuplicateKeyError(err, 'uq_venue_seat') || isDuplicateKeyError(err, 'uq_venue_grid')) {
          throw conflict(
            'CONFLICT',
            'Some of those seats already exist in this venue (duplicate row/number or grid position).',
          );
        }
        throw err;
      }
      const totalSeats = await venueSeatRepo.countByVenue(tx, venueId);
      return { created, totalSeats };
    }, { label: 'venue.bulkSeats' });
  },

  async listSeats(venueId: string): Promise<VenueSeat[]> {
    const rows = await venueSeatRepo.listByVenue(pool, venueId);
    return rows.map(toVenueSeat);
  },

  async deleteSeat(venueId: string, seatId: string): Promise<void> {
    if (await venueSeatRepo.isUsedByEvent(pool, seatId)) {
      throw conflict('SEAT_IN_USE', 'This seat is part of a published event and cannot be removed.');
    }
    const deleted = await venueSeatRepo.delete(pool, venueId, seatId);
    if (!deleted) throw notFound('Seat');
  },
};
