import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SeatStatus } from '@shared';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-ink-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-brand-600" />
      {label}…
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-seat-booked/30 bg-seat-bookedBg px-4 py-3 text-sm text-seat-booked">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-14 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="max-w-sm text-sm text-ink-500">{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <p className="kicker mb-1">{kicker}</p>}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="kicker">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

const STATUS_STYLES: Record<SeatStatus | 'SELECTED', string> = {
  AVAILABLE: 'bg-seat-availableBg text-seat-available border-seat-available/40',
  HELD: 'bg-seat-heldBg text-seat-held border-seat-held/40',
  BOOKED: 'bg-seat-bookedBg text-seat-booked border-seat-booked/40',
  SELECTED: 'bg-brand-600 text-white border-brand-600',
};

export function StatusPill({ status }: { status: SeatStatus | 'SELECTED' }) {
  return <span className={`badge border ${STATUS_STYLES[status]}`}>{status}</span>;
}

export function SeatLegend() {
  const items: Array<[SeatStatus | 'SELECTED', string]> = [
    ['AVAILABLE', 'Free to pick'],
    ['SELECTED', 'In your selection'],
    ['HELD', "Someone's checkout timer is running"],
    ['BOOKED', 'Sold'],
  ];
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-3">
      {items.map(([status, hint]) => (
        <li key={status} className="flex items-center gap-2">
          <span className={`h-6 w-7 rounded-t-md rounded-b-sm border-2 ${STATUS_STYLES[status]}`} />
          <span className="text-xs">
            <span className="block font-mono font-semibold">{status}</span>
            <span className="text-ink-500">{hint}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Breadcrumb({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav className="mb-4 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
      {items.map((item, i) => (
        <span key={item.label} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden>/</span>}
          {item.to ? (
            <Link to={item.to} className="hover:text-brand-700 hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-ink-700">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
