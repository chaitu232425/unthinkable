import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { SeatCategory, Venue, VenueSeat } from '@shared';
import { api } from '@/lib/api';
import { useApi, useMutation } from '@/hooks/useApi';
import { Breadcrumb, ErrorBanner, PageHeader, Spinner } from '@/components/ui';

type VenueDetail = Venue & { categories: SeatCategory[]; seats: VenueSeat[] };

interface RowDraft {
  rowLabel: string;
  categoryId: string;
  count: number;
}

/**
 * Seat layout management.
 *
 * Rows are described, not drawn seat by seat: `{ rowLabel: 'A', categoryId, count: 12 }`
 * becomes A1..A12 in a single transaction on the server. Building a 500-seat auditorium
 * from 500 individual requests would be slow, non-atomic, and would leave a half-built
 * layout behind if the tab closed halfway.
 */
export function VenueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, reload } = useApi<VenueDetail>(
    (signal) => api.get(`/api/venues/${id}`, signal),
    [id],
  );

  const [catName, setCatName] = useState('');
  const [catColor, setCatColor] = useState('#0F6FA8');
  const [rows, setRows] = useState<RowDraft[]>([]);

  const addCategory = useMutation(async () => {
    const created = await api.post<SeatCategory>(`/api/venues/${id}/categories`, {
      name: catName.trim(),
      displayOrder: data?.categories.length ?? 0,
      colorHex: catColor,
    });
    setCatName('');
    reload();
    return created;
  });

  const generate = useMutation(async () => {
    const result = await api.post<{ created: number; totalSeats: number }>(
      `/api/venues/${id}/seats/bulk`,
      { rows: rows.map((r) => ({ rowLabel: r.rowLabel.trim().toUpperCase(), categoryId: r.categoryId, count: r.count })) },
    );
    setRows([]);
    reload();
    return result;
  });

  const seatsByRow = useMemo(() => {
    const map = new Map<number, VenueSeat[]>();
    for (const seat of data?.seats ?? []) {
      const list = map.get(seat.gridRow) ?? [];
      list.push(seat);
      map.set(seat.gridRow, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.gridCol - b.gridCol);
    return [...map.entries()].sort(([a], [b]) => a - b);
  }, [data?.seats]);

  const colorOf = (categoryId: string) =>
    data?.categories.find((c) => c.id === categoryId)?.colorHex ?? '#94A3B8';

  if (loading) return <Spinner label="Loading the venue" />;
  if (error) return <ErrorBanner message={error.message} onRetry={reload} />;
  if (!data) return null;

  return (
    <div>
      <Breadcrumb
        items={[
          { label: 'Admin', to: '/admin' },
          { label: 'Venues', to: '/admin/venues' },
          { label: data.name },
        ]}
      />
      <PageHeader
        kicker="Venue"
        title={data.name}
        subtitle={`${data.address}, ${data.city} · ${data.seats.length} seats`}
      />

      <div className="grid gap-6 lg:grid-cols-[340px_1fr] lg:items-start">
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="text-sm font-semibold">Seat categories</h2>
            <ul className="mt-3 space-y-2">
              {data.categories.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm">
                  <span
                    className="h-3.5 w-3.5 rounded-sm border border-black/10"
                    style={{ background: c.colorHex }}
                  />
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-auto font-mono text-xs text-ink-500">
                    {data.seats.filter((s) => s.categoryId === c.id).length} seats
                  </span>
                </li>
              ))}
              {data.categories.length === 0 && (
                <li className="text-sm text-ink-500">None yet — add one below.</li>
              )}
            </ul>

            <form
              className="mt-4 space-y-3 border-t border-ink-200 pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void addCategory.run();
              }}
            >
              <div>
                <label className="label" htmlFor="cat-name">
                  New category
                </label>
                <input
                  id="cat-name"
                  className="field"
                  placeholder="Premium"
                  required
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="cat-color">
                  Colour
                </label>
                <input
                  id="cat-color"
                  type="color"
                  className="h-9 w-full cursor-pointer rounded-lg border border-ink-200"
                  value={catColor}
                  onChange={(e) => setCatColor(e.target.value)}
                />
              </div>
              {addCategory.error && <ErrorBanner message={addCategory.error.message} />}
              <button type="submit" className="btn-secondary w-full" disabled={addCategory.pending}>
                Add category
              </button>
            </form>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold">Generate rows</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Describe rows and the whole layout is created in one transaction.
            </p>

            <div className="mt-3 space-y-2">
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className="field w-14 text-center font-mono uppercase"
                    maxLength={2}
                    value={row.rowLabel}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, i) => (i === index ? { ...r, rowLabel: e.target.value } : r)),
                      )
                    }
                  />
                  <select
                    className="field flex-1"
                    value={row.categoryId}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, i) => (i === index ? { ...r, categoryId: e.target.value } : r)),
                      )
                    }
                  >
                    {data.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="field w-20 text-center font-mono"
                    value={row.count}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, i) =>
                          i === index ? { ...r, count: Number(e.target.value) } : r,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    aria-label={`Remove row ${row.rowLabel}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={data.categories.length === 0}
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    {
                      rowLabel: String.fromCharCode(
                        65 + (data.seats.length > 0 ? seatsByRow.length : 0) + prev.length,
                      ),
                      categoryId: data.categories[0]!.id,
                      count: 12,
                    },
                  ])
                }
              >
                Add a row
              </button>
              <button
                type="button"
                className="btn-primary btn-sm flex-1"
                disabled={rows.length === 0 || generate.pending}
                onClick={() => void generate.run()}
              >
                {generate.pending
                  ? 'Generating…'
                  : `Create ${rows.reduce((s, r) => s + r.count, 0)} seats`}
              </button>
            </div>
            {generate.error && (
              <div className="mt-3">
                <ErrorBanner message={generate.error.message} />
              </div>
            )}
          </div>
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Layout preview</h2>
          {data.seats.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-500">
              No seats yet. Add a category, then generate some rows.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="mx-auto mb-5 w-3/4 min-w-max rounded-t-[100%] border-t-2 border-ink-300 pt-2 text-center">
                <span className="kicker">Screen / Stage</span>
              </div>
              <div className="flex min-w-max flex-col gap-1.5">
                {seatsByRow.map(([gridRow, seats]) => (
                  <div key={gridRow} className="flex items-center gap-2">
                    <span className="w-6 shrink-0 text-right font-mono text-[11px] text-ink-400">
                      {seats[0]?.rowLabel}
                    </span>
                    <div className="flex gap-1.5">
                      {seats.map((seat) => (
                        <span
                          key={seat.id}
                          title={`${seat.label}`}
                          className="grid h-7 w-8 place-items-center rounded-t-md rounded-b-sm border-2 font-mono text-[10px] font-semibold"
                          style={{
                            borderColor: colorOf(seat.categoryId),
                            color: colorOf(seat.categoryId),
                            background: `${colorOf(seat.categoryId)}14`,
                          }}
                        >
                          {seat.seatNumber}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
