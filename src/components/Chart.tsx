import type { DailyPoint } from '../lib/types';
import { formatMoney, formatNumber } from '../lib/metrics';

type MetricKey = 'spend' | 'leads' | 'customers' | 'revenue' | 'clicks';

interface Props {
  points: DailyPoint[];
  metric: MetricKey;
  currency: string;
}

const ACCESSOR: Record<MetricKey, (p: DailyPoint) => number> = {
  spend: (p) => p.spendMinor,
  revenue: (p) => p.salesMinor,
  leads: (p) => p.leads,
  customers: (p) => p.customers,
  clicks: (p) => p.clicks,
};

const W = 640;
const H = 150;
const PAD = 6;

export default function Chart({ points, metric, currency }: Props) {
  if (points.length < 2) return <p className="text-sm text-muted">Not enough days to plot yet.</p>;

  const values = points.map(ACCESSOR[metric]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const stepX = (W - PAD * 2) / (points.length - 1);

  const xy = points.map((p, i) => {
    const v = ACCESSOR[metric](p);
    const x = PAD + i * stepX;
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return { x, y, p };
  });

  const line = xy.map((d, i) => `${i === 0 ? 'M' : 'L'}${d.x.toFixed(1)},${d.y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1].x.toFixed(1)},${H} L${xy[0].x.toFixed(1)},${H} Z`;
  const prelimStart = xy.find((d) => d.p.preliminary);
  const fmt = (v: number) => (metric === 'spend' || metric === 'revenue' ? formatMoney(v, currency, true) : formatNumber(v));
  const last = xy[xy.length - 1];
  const label = metric === 'revenue' ? 'revenue' : metric;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[12px] text-muted">Peak {fmt(max)}</span>
        <span className="num text-[12px] text-muted">
          Now {fmt(ACCESSOR[metric](points[points.length - 1]))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[150px] w-full"
        role="img"
        aria-label={`${label} per day for the last ${points.length} days, peak ${fmt(max)}`}
      >
        <defs>
          <linearGradient id={`g-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a73e8" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#1a73e8" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#f1f3f4" strokeWidth={1} />
        ))}
        {prelimStart && (
          <rect
            x={prelimStart.x}
            y={0}
            width={Math.max(0, W - prelimStart.x)}
            height={H}
            fill="#f8f9fa"
          />
        )}
        <path d={area} fill={`url(#g-${metric})`} />
        <path d={line} fill="none" stroke="#1a73e8" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <circle cx={last.x} cy={last.y} r={3} fill="#1a73e8" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{points[0].date.slice(5)}</span>
        {prelimStart && <span className="text-[#80868b]">shaded = provisional (last 2 days)</span>}
        <span>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}
