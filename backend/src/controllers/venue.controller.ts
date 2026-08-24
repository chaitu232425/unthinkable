import type { Request, Response } from 'express';
import { venueService } from '../services/venue.service.js';
import { pageParams } from '../utils/http.js';

export const venueController = {
  async create(req: Request, res: Response) {
    res.status(201).json(await venueService.create({ ...req.body, adminId: req.user!.id }));
  },

  async list(req: Request, res: Response) {
    const q = req.query as { city?: string; includeInactive?: boolean };
    res.json(
      await venueService.list(
        {
          ...(q.city ? { city: q.city } : {}),
          ...(q.includeInactive !== undefined ? { includeInactive: q.includeInactive } : {}),
        },
        pageParams(req.query),
      ),
    );
  },

  async detail(req: Request, res: Response) {
    res.json(await venueService.detail(req.params.id!));
  },

  async update(req: Request, res: Response) {
    res.json(await venueService.update(req.params.id!, req.body));
  },

  async deactivate(req: Request, res: Response) {
    res.json(await venueService.deactivate(req.params.id!));
  },

  async listCategories(req: Request, res: Response) {
    res.json({ categories: await venueService.listCategories(req.params.id!) });
  },

  async addCategory(req: Request, res: Response) {
    res.status(201).json(await venueService.addCategory(req.params.id!, req.body));
  },

  async updateCategory(req: Request, res: Response) {
    res.json(await venueService.updateCategory(req.params.id!, req.params.categoryId!, req.body));
  },

  async bulkSeats(req: Request, res: Response) {
    res.status(201).json(await venueService.bulkCreateSeats(req.params.id!, req.body.rows));
  },

  async listSeats(req: Request, res: Response) {
    res.json({ seats: await venueService.listSeats(req.params.id!) });
  },

  async deleteSeat(req: Request, res: Response) {
    await venueService.deleteSeat(req.params.id!, req.params.seatId!);
    res.status(204).send();
  },
};
