import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SOCKET_EVENTS,
  type SeatMapResponse,
  type SeatMapSeat,
  type SeatUpdatedPayload,
} from '@shared';
import { api } from '@/lib/api';
import { useSocket } from '@/context/SocketContext';

/**
 * Live seat map.
 *
 * The reconciliation rule, in three lines:
 *   • REST gives the authoritative snapshot and its `revision`;
 *   • socket deltas are applied only when their revision is newer;
 *   • a gap, a reconnect, or any doubt triggers a refetch.
 *
 * A dropped socket therefore costs responsiveness, never correctness. The server would
 * reject a stale click regardless of what this component happens to be showing.
 */
export function useSeatMap(eventId: string | undefined) {
  const { socket, connected } = useSocket();
  const [data, setData] = useState<SeatMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(-1);

  const refetch = useCallback(async () => {
    if (!eventId) return;
    try {
      const map = await api.get<SeatMapResponse>(`/api/events/${eventId}/seats`);
      revisionRef.current = map.revision;
      setData(map);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the seat map');
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    setLoading(true);
    revisionRef.current = -1;
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!socket || !eventId) return undefined;

    socket.emit(SOCKET_EVENTS.JOIN_EVENT, { eventId });

    const onSeatUpdate = (payload: SeatUpdatedPayload) => {
      if (payload.eventId !== eventId) return;

      // An empty delta (an event-level change) or a jump of more than one revision
      // means we may have missed something — go back to the source of truth.
      if (payload.seats.length === 0 || payload.revision > revisionRef.current + 1) {
        void refetch();
        return;
      }
      if (payload.revision <= revisionRef.current) return;

      revisionRef.current = payload.revision;
      setData((prev) => {
        if (!prev) return prev;
        const patch = new Map(payload.seats.map((s) => [s.id, s]));
        return {
          ...prev,
          revision: payload.revision,
          seats: prev.seats.map((seat): SeatMapSeat => {
            const update = patch.get(seat.id);
            if (!update) return seat;
            return {
              ...seat,
              status: update.status,
              holdExpiresAt: update.holdExpiresAt,
              // Ownership cannot be derived from a broadcast — it is deliberately not
              // in the payload, since that would leak who holds what. Refetch decides.
              heldByMe: update.status === 'HELD' ? seat.heldByMe : false,
            };
          }),
        };
      });
    };

    socket.on(SOCKET_EVENTS.SEAT_UPDATED, onSeatUpdate);
    // Any reconnect discards local state and repairs from REST.
    socket.on('connect', () => {
      socket.emit(SOCKET_EVENTS.JOIN_EVENT, { eventId });
      void refetch();
    });

    return () => {
      socket.emit(SOCKET_EVENTS.LEAVE_EVENT, { eventId });
      socket.off(SOCKET_EVENTS.SEAT_UPDATED, onSeatUpdate);
    };
  }, [socket, eventId, refetch]);

  return { seatMap: data, loading, error, refetch, live: connected };
}
