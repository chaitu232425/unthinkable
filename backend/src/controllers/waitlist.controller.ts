import type { Request, Response } from 'express';
import { waitlistService } from '../services/waitlist.service.js';

export const waitlistController = {
  async listMine(req: Request, res: Response) {
    res.json({ entries: await waitlistService.listMine(req.user!.id) });
  },

  async leave(req: Request, res: Response) {
    await waitlistService.leave(req.params.entryId!, req.user!.id);
    res.status(204).send();
  },

  /**
   * Both the token and the signed-in identity are checked. A leaked or forwarded email
   * cannot claim a seat, because the reader would also need to be signed in as the
   * offered customer.
   */
  async getOffer(req: Request, res: Response) {
    const token = (req.query as { t: string }).t;
    res.json({ offer: await waitlistService.getOffer(req.params.offerId!, token, req.user!.id) });
  },

  async accept(req: Request, res: Response) {
    const token = (req.query as { t: string }).t;
    const { booking, replayed } = await waitlistService.accept(
      req.params.offerId!,
      token,
      req.user!.id,
    );
    res.status(replayed ? 200 : 201).json({ booking, replayed });
  },

  async decline(req: Request, res: Response) {
    const token = (req.query as { t: string }).t;
    await waitlistService.decline(req.params.offerId!, token, req.user!.id);
    res.status(204).send();
  },
};
