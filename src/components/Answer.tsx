import type { AnswerSpec, Section, Tile } from '../lib/answer';
import type { Dataset, Settings } from '../lib/types';
import { dailySeries } from '../lib/metrics';
import Chart from './Chart';
import Research from './Research';

interface Props {
  spec: AnswerSpec;
  dataset: Dataset;
  settings: Settings;
  onFollowUp: (q: string, mode: 'track' | 'research') => void;
  /** True only when the server is talking to a real ad account. */
  live?: boolean;
}

function DeltaBadge({ delta, goodWhenUp = true }: { delta?: number; goodWhenUp?: boolean }) {
  if (delta === undefined || !Number.isFinite(delta)) return null;
  const up = delta >= 0;
  const good = up === goodWhenUp;
  return (
    <span className={`num text-[12px] ${good ? 'text-good' : 'text-warn'}`}>
      {up ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(1)}%
    </span>
  );
}

function TileCard({ tile }: { tile: Tile }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3">
      <div className="text-[12px] leading-5 text-muted">{tile.label}</div>
      <div className="num mt-0.5 text-[22px] font-medium leading-7 text-ink">{tile.value}</div>
      <div className="mt-0.5 flex items-center gap-2">
        {tile.delta !== undefined && <DeltaBadge delta={tile.delta} goodWhenUp={(tile.tone ?? 'neutral') !== 'warn'} />}
        {tile.sub && <span className="text-[12px] text-muted">{tile.sub}</span>}
      </div>
    </div>
  );
}

function renderSection(
  section: Section,
  dataset: Dataset,
  settings: Settings,
  onFollowUp: Props['onFollowUp'],
  index: number,
  live: boolean,
) {
  switch (section.kind) {
    case 'kpis':
      return (
        <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {section.tiles.map((t) => (
            <TileCard key={t.label} tile={t} />
          ))}
        </div>
      );
    case 'chart':
      return (
        <figure key={index} className="rounded-xl border border-line px-4 pb-3 pt-3">
          <figcaption className="mb-2 text-[13px] font-medium text-ink">{section.title}</figcaption>
          <Chart points={dailySeries(dataset, { days: 30 })} metric={section.metric} currency={settings.currency} />
          {section.note && <p className="mt-2 text-[12px] text-muted">{section.note}</p>}
        </figure>
      );
    case 'table':
      return (
        <figure key={index} className="overflow-hidden rounded-xl border border-line">
          <figcaption className="border-b border-line bg-cloud px-4 py-2 text-[13px] font-medium text-ink">
            {section.title}
          </figcaption>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead>
                <tr className="text-[12px] uppercase tracking-wide text-muted">
                  {section.columns.map((c) => (
                    <th key={c} className="px-4 py-2 font-normal">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-[#f1f3f4] hover:bg-[#fafafa]">
                    {row.map((cell, ci) => (
                      <td key={ci} className={`px-4 py-2 ${ci === 0 ? 'text-ink' : 'num text-muted'}`}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {section.note && <p className="border-t border-line px-4 py-2 text-[12px] text-muted">{section.note}</p>}
        </figure>
      );
    case 'bars':
      return (
        <figure key={index} className="rounded-xl border border-line px-4 py-3">
          <figcaption className="mb-3 text-[13px] font-medium text-ink">{section.title}</figcaption>
          <ul className="space-y-2.5">
            {section.bars.map((b) => (
              <li key={b.label}>
                <div className="mb-1 flex justify-between text-[13px]">
                  <span className="text-ink">{b.label}</span>
                  <span className="num text-muted">{b.display}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-[#f1f3f4]">
                  <div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(2, b.share * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
          {section.note && <p className="mt-3 text-[12px] text-muted">{section.note}</p>}
        </figure>
      );
    case 'text':
      return (
        <div key={index} className="rounded-xl bg-cloud px-4 py-3">
          <h3 className="text-[13px] font-medium text-ink">{section.title}</h3>
          <p className="mt-1 text-[14px] leading-6 text-ink">{section.body}</p>
          {section.bullets && (
            <ul className="mt-2 space-y-1.5">
              {section.bullets.map((b) => (
                <li key={b} className="flex gap-2 text-[13px] leading-6 text-muted">
                  <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[#9aa0a6]" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'research':
      return (
        <div key={index} className="space-y-3">
          <div className="rounded-xl border border-[#d2e3fc] bg-brandSoft px-4 py-3">
            <h3 className="text-[13px] font-medium text-ink">{section.title}</h3>
            <p className="mt-1 text-[13px] leading-6 text-[#174ea6]">{section.body}</p>
          </div>
          <Research
            initialSeeds={section.seed}
            compactDataset={dataset}
            onFollowUp={onFollowUp}
            live={live}
            adGroups={dataset.adGroups.map((g) => ({ id: g.id, name: g.name, hints: g.hints }))}
          />
        </div>
      );
    default:
      return null;
  }
}

export default function Answer({ spec, dataset, settings, onFollowUp, live = false }: Props) {
  return (
    <article className="animate-rise pb-24">
      <header className="mb-5">
        <h1 className="max-w-3xl text-[22px] font-normal leading-8 text-ink sm:text-[24px]">{spec.headline}</h1>
        {spec.subline && <p className="mt-1.5 max-w-3xl text-[14px] leading-6 text-muted">{spec.subline}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#80868b]">
          <span className="rounded-full bg-cloud px-2 py-0.5">last {spec.windowDays} days</span>
          <span>{settings.timezone}</span>
          <span>·</span>
          <span>{settings.currency} · minor units</span>
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {spec.tiles.map((t) => (
          <TileCard key={t.label} tile={t} />
        ))}
      </div>

      <div className="space-y-4">
        {spec.sections.map((s, i) => renderSection(s, dataset, settings, onFollowUp, i, live))}
      </div>

      <details className="mt-6 rounded-xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-medium text-ink">Where these numbers come from</summary>
        <ul className="mt-2 space-y-1">
          {spec.sources.map((s) => (
            <li key={s} className="text-[13px] text-muted">
              · {s}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[12px] leading-5 text-muted">
          Native (OpenAI-reported) and internal (first-party) figures are always shown separately. Native includes 1-day
          view-through; internal is click-only, last touch, {settings.windowDays}-day window. Money is stored in minor
          units and formatted for display only.
        </p>
      </details>

      <div className="mt-6">
        <p className="mb-2 text-[12px] text-muted">Related questions</p>
        <div className="flex flex-wrap gap-2">
          {spec.followUps.map((f) => (
            <button key={f} type="button" className="chip" onClick={() => onFollowUp(f, 'track')}>
              {f}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            onClick={() =>
              onFollowUp(spec.intent === 'research' ? 'context hints' : 'Help me research context hints', 'research')
            }
          >
            Research context hints
          </button>
        </div>
      </div>
    </article>
  );
}
