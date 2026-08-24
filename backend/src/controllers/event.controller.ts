import type { Request, Response } from 'express';
import { eventService } from '../services/event.service.js';
import { holdService } from '../services/hold.service.js';
import { waitlistService } from '../services/waitlist.service.js';
import { pageParams } from '../utils/http.js';

export const eventController = {
  async create(req: Request, res: Response) {
    res.status(201).json(await eventService.create({ ...req.body, organiserId: req.user!.id }));
  },

  async publish(req: Request, res: Response) {
    res.json(await eventService.publish(req.params.id!, req.user!));
  },

  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | number | undefined>;
    res.json(
      await eventService.list(
        {
          ...(q.q ? { q: String(q.q) } : {}),
          ...(q.type ? { type: q.type as 'MOVIE' | 'CONCERT' } : {}),
          ...(q.city ? { city: String(q.city) } : {}),
          ...(q.venueId ? { venueId: String(q.venueId) } : {}),
          ...(q.dateFrom ? { dateFrom: String(q.dateFrom) } : {}),
          ...(q.dateTo ? { dateTo: String(q.dateTo) } : {}),
          ...(q.minPrice !== undefined ? { minPrice: Number(q.minPrice) } : {}),
          ...(q.maxPrice !== undefined ? { maxPrice: Number(q.maxPrice) } : {}),
          ...(q.sort ? { sort: q.sort as 'soonest' } : {}),
        },
        pageParams(req.query),
      ),
    );
  },

  async mine(req: Request, res: Response) {
    const status = (req.query as { status?: 'DRAFT' }).status;
    res.json(await eventService.listForOrganiser(req.user!.id, status, pageParams(req.query)));
  },

  async detail(req: Request, res: Response) {
    res.json(await eventService.detail(req.params.id!));
  },

  /** Public. `optionalAuth` upstream lets a signed-in caller see which seats are theirs. */
  async seatMap(req: Request, res: Response) {
    res.json(await eventService.seatMap(req.params.id!, req.user?.id));
  },

  async availability(req: Request, res: Response) {
    res.json({ availability: await eventService.availability(req.params.id!) });
  },

  async update(req: Request, res: Response) {
    res.json(await eventService.update(req.params.id!, req.user!, req.body));
  },

  async cancel(req: Request, res: Response) {
    res.json(await eventService.cancel(req.params.id!, req.user!));
  },

  /** POST /api/events/:eventId/holds — the concurrency-critical endpoint. */
  async createHold(req: Request, res: Response) {
    const hold = await holdService.create({
      eventId: req.params.eventId!,
      userId: req.user!.id,
      seatIds: req.body.seatIds,
    });
    res.status(201).json(hold);
  },

  async joinWaitlist(req: Request, res: Response) {
    const entry = await waitlistService.join({
      eventId: req.params.eventId!,
      userId: req.user!.id,
      categoryId: req.body.categoryId,
      seatsRequested: req.body.seatsRequested,
    });
    res.status(201).json(entry);
  },

  async myWaitlist(req: Request, res: Response) {
    res.json({ entries: await waitlistService.listMine(req.user!.id, req.params.eventId!) });
  },
};
