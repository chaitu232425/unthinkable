import { useMemo } from 'react';
import type { SeatMapResponse, SeatMapSeat } from '@shared';
import { formatMoney } from '@/lib/format';

interface Props {
  seatMap: SeatMapResponse;
  selected: Set<string>;
  onToggle: (seat: SeatMapSeat) => void;
  maxSelectable: number;
  currency: string;
  disabled?: boolean;
}

/**
 * The visual seat map: a CSS grid keyed on `grid_row` / `grid_col` from `event_seats`.
 *
 * Disabling a HELD or BOOKED seat here is a usability affordance and nothing more. The
 * server re-checks availability inside a locked transaction, so a caller with curl and
 * a valid token gets exactly the same answer as this component does.
 */
export function SeatMap({ seatMap, selected, onToggle, maxSelectable, currency, disabled }: Props) {
  const byRow = useMemo(() => {
    const rows = new Map<number, SeatMapSeat[]>();
    for (const seat of seatMap.seats) {
      const list = rows.get(seat.gridRow) ?? [];
      list.push(seat);
      rows.set(seat.gridRow, list);
    }
    for (const list of rows.values()) list.sort((a, b) => a.gridCol - b.gridCol);
    return [...rows.entries()].sort(([a], [b]) => a - b);
  }, [seatMap.seats]);

  const atLimit = selected.size >= maxSelectable;

  return (
    <div className="overflow-x-auto">
      <div className="mx-auto min-w-max px-2">
        <div className="mx-auto mb-6 w-3/4 rounded-t-[100%] border-t-2 border-ink-300 pt-2 text-center">
          <span className="kicker">Screen / Stage</span>
        </div>

        <div className="flex flex-col gap-1.5">
          {byRow.map(([gridRow, seats]) => (
            <div key={gridRow} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right font-mono text-[11px] text-ink-400">
                {seats[0]?.rowLabel}
              </span>
              <div className="flex gap-1.5">
                {seats.map((seat) => {
                  const isSelected = selected.has(seat.id);
                  const selectable =
                    !disabled &&
                    (seat.status === 'AVAILABLE' || seat.heldByMe) &&
                    (isSelected || !atLimit);

                  const style = isSelected
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : seat.heldByMe
                      ? 'bg-brand-50 border-brand-500 text-brand-700'
                      : seat.status === 'AVAILABLE'
                        ? 'bg-seat-availableBg border-seat-available/50 text-seat-available hover:border-seat-available'
                        : seat.status === 'HELD'
                          ? 'bg-seat-heldBg border-seat-held/50 text-seat-held'
                          : 'bg-seat-bookedBg border-seat-booked/50 text-seat-booked';

                  return (
                    <button
                      key={seat.id}
                      type="button"
                      disabled={!selectable}
                      aria-pressed={isSelected}
                      aria-label={`Seat ${seat.label}, ${seat.categoryName}, ${formatMoney(
                        seat.priceCents,
                        currency,
                      )}, ${isSelected ? 'selected' : seat.status.toLowerCase()}`}
                      title={`${seat.label} · ${seat.categoryName} · ${formatMoney(seat.priceCents, currency)}`}
                      onClick={() => onToggle(seat)}
                      className={`h-8 w-9 rounded-t-md rounded-b-sm border-2 font-mono text-[10px] font-semibold
                                  transition-colors ${style}
                                  ${selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'}`}
                    >
                      {seat.seatNumber}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap justify-center gap-4 border-t border-ink-200 pt-4">
          {seatMap.categories.map((c) => {
            const seats = seatMap.seats.filter((s) => s.categoryId === c.id);
            const price = seats[0]?.priceCents ?? 0;
            const free = seats.filter((s) => s.status === 'AVAILABLE').length;
            return (
              <div key={c.id} className="flex items-center gap-2 text-xs">
                <span
                  className="h-3 w-3 rounded-sm border"
                  style={{ background: c.colorHex, borderColor: c.colorHex }}
                />
                <span className="font-medium">{c.name}</span>
                <span className="font-mono tabular-nums text-ink-500">
                  {formatMoney(price, currency)} · {free} left
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
