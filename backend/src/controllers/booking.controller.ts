import type { Request, Response } from 'express';
import { bookingService } from '../services/booking.service.js';
import { holdService } from '../services/hold.service.js';
import { ticketService } from '../services/ticket.service.js';
import { pageParams } from '../utils/http.js';

export const bookingController = {
  /**
   * A replayed confirm answers 200 with the existing booking; a genuinely new one
   * answers 201. Both return the same body, so a client that double-submits sees
   * exactly one booking either way.
   */
  async confirm(req: Request, res: Response) {
    const { booking, replayed } = await bookingService.confirm({
      holdId: req.body.holdId,
      userId: req.user!.id,
    });
    res.status(replayed ? 200 : 201).json({ booking, replayed });
  },

  async listMine(req: Request, res: Response) {
    const status = (req.query as { status?: 'CONFIRMED' | 'CANCELLED' }).status;
    res.json(await bookingService.listMine(req.user!.id, status, pageParams(req.query)));
  },

  async detail(req: Request, res: Response) {
    res.json({ booking: await bookingService.detail(req.params.id!, req.user!) });
  },

  async cancel(req: Request, res: Response) {
    const { itemIds } = req.body as { itemIds?: string[] };
    res.json({ booking: await bookingService.cancel(req.params.id!, req.user!, itemIds) });
  },

  /** PNG of the ticket QR, for download or printing. */
  async qr(req: Request, res: Response) {
    const booking = await bookingService.detail(req.params.id!, req.user!);
    const payload = ticketService.buildPayload(booking.reference, booking.event.id);
    const png = await ticketService.toPngBuffer(payload);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${booking.reference}.png"`);
    res.send(png);
  },

  async verifyTicket(req: Request, res: Response) {
    res.json(await ticketService.verify(req.body.payload, req.user!));
  },

  /* ------------------------------------------------------------------ holds */

  async holdDetail(req: Request, res: Response) {
    res.json(await holdService.detail(req.params.holdId!, req.user!.id));
  },

  async releaseHold(req: Request, res: Response) {
    await holdService.release(req.params.holdId!, req.user!.id);
    res.status(204).send();
  },

  async myHolds(req: Request, res: Response) {
    res.json({ holds: await holdService.listMine(req.user!.id) });
  },
};
