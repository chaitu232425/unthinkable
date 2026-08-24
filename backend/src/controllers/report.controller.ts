import type { Request, Response } from 'express';
import { bookingService } from '../services/booking.service.js';
import { eventService } from '../services/event.service.js';
import { notificationService } from '../services/notification.service.js';
import { reportService } from '../services/report.service.js';
import { pageParams } from '../utils/http.js';

export const reportController = {
  async eventSummary(req: Request, res: Response) {
    res.json(await reportService.eventSummary(req.params.id!, req.user!));
  },

  /** Ownership is asserted before the listing runs, so no cross-organiser leakage. */
  async eventBookings(req: Request, res: Response) {
    await eventService.assertOwnership(req.params.id!, req.user!);
    res.json(await bookingService.listForEvent(req.params.id!, pageParams(req.query)));
  },

  async revenue(req: Request, res: Response) {
    const q = req.query as { from?: string; to?: string };
    res.json(await reportService.organiserRevenue(req.user!.id, q));
  },

  async adminStats(_req: Request, res: Response) {
    res.json(await reportService.adminStats());
  },

  async notifications(req: Request, res: Response) {
    res.json({ notifications: await notificationService.listForUser(req.user!.id) });
  },
};
