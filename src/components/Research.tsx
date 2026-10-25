import { useCallback, useEffect, useMemo, useState } from 'react';
import { SAMPLE_SEEDS, runResearch, scoreBreakdown, toCsv, type Cluster, type ResearchResult } from '../lib/research';
import { byAdGroup, formatMoney, formatPercent, formatRatio } from '../lib/metrics';
import type { Dataset } from '../lib/types';
import PushHints, { type TargetAdGroup } from './PushHints';
import { createLocalStore, summariseEntry, type AuditEntry, type AuditStore } from '../lib/hints';

interface Props {
  initialSeeds?: string;
  compactDataset?: Dataset;
  onFollowUp?: (q: string, mode: 'track' | 'research') => void;
  /** False in demo mode: the server has no key, so hint sets cannot be pushed. */
  live?: boolean;
  /** Ad groups the user may push into, with their current hints. */
  adGroups?: TargetAdGroup[];
  /**
   * False when the signed-in role cannot write (analyst, viewer) or when the server
   * has not confirmed a role. The button is disabled rather than letting the user
   * fill in a diff and be rejected with 403 at the end.
   */
  canWrite?: boolean;
  /** Injected by tests; defaults to localStorage. */
  auditStore?: AuditStore;
}

/**
 * One scored component. The number on the right is what this part contributes to
 * the cluster score (`value × weight`), so the five numbers below add up to the
 * badge at the top of the panel.
 */
function ScoreBar({ label, value, weight, points }: { label: string; value: number; weight: number; points: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[74px] shrink-0 text-[11px] text-muted">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-[#f1f3f4]">
        <div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.max(2, Math.min(1, value) * 100)}%` }} />
      </div>
      <span className="num w-24 shrink-0 text-right text-[11px] text-muted">
        {(points * 100).toFixed(0)} pts · {Math.round(weight * 100)}%
      </span>
    </div>
  );
}

export default function Research({
  initialSeeds,
  compactDataset,
  onFollowUp,
  live = false,
  adGroups = [],
  canWrite = false,
  auditStore,
}: Props) {
  const [raw, setRaw] = useState(initialSeeds && initialSeeds.length > 3 ? initialSeeds : SAMPLE_SEEDS);
  const [granularity, setGranularity] = useState(50);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const store = useMemo(() => auditStore ?? createLocalStore(), [auditStore]);
  const [audit, setAudit] = useState<AuditEntry[]>(() => store.read());
  const [targets, setTargets] = useState<Record<string, string>>({});

  const onAudit = useCallback((entries: AuditEntry[]) => setAudit(entries), []);

  // A pushed hint set should be visible on the page immediately, not only in the log.
  const [pushed, setPushed] = useState<Record<string, string[]>>({});
  const handlePushed = useCallback((adGroupId: string, after: string[]) => {
    setPushed((prev) => ({ ...prev, [adGroupId]: after }));
  }, []);

  const run = () => {
    const r = runResearch(raw, granularity);
    setResult(r);
    setOpen(r.clusters[0]?.id ?? null);
  };

  // Re-cluster live when granularity moves, once a run has happened.
  useEffect(() => {
    if (result) setResult(runResearch(raw, granularity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity]);

  const matching = useMemo(
    () => (compactDataset ? byAdGroup(compactDataset, { days: 30 }).slice(0, 4) : []),
    [compactDataset],
  );

  const download = () => {
    if (!result) return;
    const blob = new Blob([toCsv(result)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'adtrack-hints.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const hintIssues = (c: Cluster) => result?.hints.filter((h) => h.clusterId === c.id) ?? [];

  const selectedId = (clusterId: string) => targets[clusterId] ?? adGroups[0]?.id;

  const targetHintsOf = (clusterId: string) => {
    const group = adGroups.find((g) => g.id === selectedId(clusterId));
    if (!group) return [];
    return pushed[group.id] ?? group.hints;
  };

  const targetAdGroup = (clusterId: string): TargetAdGroup | null => {
    const group = adGroups.find((g) => g.id === selectedId(clusterId));
    if (!group) return null;
    return { ...group, hints: pushed[group.id] ?? group.hints };
  };

  return (
    <section className="rounded-xl border border-line">
      <div className="border-b border-line bg-cloud px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">Context-hint research</h2>
        <p className="mt-0.5 text-[12px] leading-5 text-muted">
          Seeds → scrub → intent → cluster → score → conversation-shaped hints. There are no keyword volumes on this
          channel, and no first-party revenue is connected yet — so the score measures cluster structure (tightness,
          intent, size, coverage, safety), not expected ₹. The parts add up to the number they show.
        </p>
      </div>

      <div className="space-y-3 px-4 py-3">
        <label className="block text-[12px] text-muted" htmlFor="seeds">
          Seed keywords or questions, one per line ({raw.split('\n').filter((l) => l.trim()).length} lines)
        </label>
        <textarea
          id="seeds"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={7}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-line bg-white px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none focus:border-brand"
        />

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="gran" className="text-[12px] text-muted">
            Cluster granularity
          </label>
          <input
            id="gran"
            type="range"
            min={0}
            max={100}
            step={5}
            value={granularity}
            onChange={(e) => setGranularity(Number(e.target.value))}
            className="h-1 w-40 accent-[#1a73e8]"
          />
          <span className="num text-[12px] text-muted">
            {granularity < 34 ? 'broad' : granularity < 67 ? 'balanced' : 'fine'}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setRaw(SAMPLE_SEEDS)}
              className="rounded-full border border-line px-3 py-1.5 text-[12px] text-muted hover:bg-cloud"
            >
              Load sample
            </button>
            <button
              type="button"
              onClick={run}
              className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[#1765cc] disabled:opacity-40"
              disabled={!raw.trim()}
            >
              Cluster & score
            </button>
          </div>
        </div>

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-cloud px-3 py-2 text-[12px] text-muted">
              <span className="num">{result.stats.input} lines</span>
              <span className="num">{result.stats.unique} usable</span>
              <span className="num">{result.stats.piiRemoved} PII removed</span>
              <span className="num">{result.stats.clusters} clusters</span>
              <span className="num">{result.stats.hints} hints</span>
              {result.stats.blockedHints > 0 && (
                <span className="num text-warn">{result.stats.blockedHints} blocked by validators</span>
              )}
              <button type="button" onClick={download} className="ml-auto text-brand hover:underline">
                Download CSV
              </button>
            </div>

            <ul className="space-y-2">
              {result.clusters.map((c) => {
                const isOpen = open === c.id;
                const hints = hintIssues(c);
                return (
                  <li key={c.id} className="rounded-lg border border-line">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : c.id)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[#fafafa]"
                    >
                      <span className="num w-10 shrink-0 rounded bg-brandSoft px-1.5 py-0.5 text-center text-[11px] text-brand">
                        {(c.score * 100).toFixed(0)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{c.name}</span>
                        <span className="block text-[11px] text-muted">
                          {c.size} seeds · {c.intent} · {c.landingPath}
                          {c.coverageGap ? ' · coverage gap' : ''}
                        </span>
                      </span>
                      <span aria-hidden className="text-muted">
                        {isOpen ? '−' : '+'}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-3 border-t border-line px-3 py-3">
                        <div className="space-y-1.5">
                          {scoreBreakdown(c).map((b) => (
                            <ScoreBar key={b.key} label={b.label} value={b.value} weight={b.weight} points={b.points} />
                          ))}
                          <p className="text-right text-[11px] text-muted">
                            score {Math.round(scoreBreakdown(c).reduce((s, b) => s + b.points, 0) * 100)} · badge{' '}
                            {Math.round(c.score * 100)}
                          </p>
                        </div>

                        <div>
                          <p className="mb-1 text-[12px] font-medium text-ink">
                            Hints ({hints.filter((h) => !h.blocked).length} ready)
                          </p>
                          <ul className="space-y-1.5">
                            {hints.map((h) => (
                              <li key={h.id} className="rounded-md bg-cloud px-2.5 py-1.5">
                                <div className="flex items-start gap-2">
                                  <span
                                    aria-hidden
                                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                      h.blocked ? 'bg-[#d93025]' : 'bg-good'
                                    }`}
                                  />
                                  <div className="min-w-0">
                                    <p className="text-[12.5px] leading-5 text-ink">{h.text}</p>
                                    <p className="text-[11px] text-muted">
                                      {h.issues
                                        .filter((i) => i.severity !== 'ok')
                                        .map((i) => i.message)
                                        .join(' ') || h.issues[0].message}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => navigator.clipboard?.writeText(h.text)}
                                    className="ml-auto shrink-0 text-[11px] text-brand hover:underline"
                                  >
                                    copy
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {matching.length > 0 && (
                          <div className="rounded-md border border-line px-2.5 py-2">
                            <p className="text-[11px] font-medium text-ink">Where a set like this would land today</p>
                            <ul className="mt-1 space-y-0.5">
                              {matching.map((g) => (
                                <li key={g.key} className="flex justify-between text-[11px] text-muted">
                                  <span className="truncate">{g.label}</span>
                                  <span className="num shrink-0">
                                    {formatMoney(g.cplMinor, 'INR')} CPL · {formatPercent(g.leadToCustomer)} ·{' '}
                                    {formatRatio(g.roas)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        <div className="space-y-2 rounded-md border border-line px-2.5 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <label htmlFor={`target-${c.id}`} className="text-[11px] text-muted">
                              Target ad group
                            </label>
                            {adGroups.length > 0 ? (
                              <select
                                id={`target-${c.id}`}
                                value={targets[c.id] ?? adGroups[0].id}
                                onChange={(e) => setTargets((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                className="max-w-[220px] rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink"
                              >
                                {adGroups.map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {g.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-[11px] text-[#80868b]">no ad groups loaded</span>
                            )}
                            <span className="num text-[11px] text-muted">
                              {(pushed[targets[c.id] ?? adGroups[0]?.id ?? ''] ?? targetHintsOf(c.id)).length} hints now
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                onFollowUp?.(c.name.replace(/^[^:]+:\s*/, '') + ' ad group performance', 'track')
                              }
                              className="rounded-full border border-line px-3 py-1 text-[11px] text-muted hover:bg-cloud"
                            >
                              Check this theme&apos;s performance
                            </button>
                            <PushHints
                              adGroup={targetAdGroup(c.id)}
                              candidateHints={hints.filter((h) => !h.blocked).map((h) => h.text)}
                              live={live && canWrite}
                              disabledReason={
                                live && !canWrite
                                  ? 'Your role can read but not change the ad account. Pushing hints needs admin or owner.'
                                  : undefined
                              }
                              store={store}
                              onAudit={onAudit}
                              onPushed={handlePushed}
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {result.gaps.length > 0 && (
              <p className="text-[12px] leading-5 text-muted">
                <span className="font-medium text-ink">Coverage gaps:</span> {result.gaps.join('; ')} — thin clusters
                are usually where a new ad group earns its budget.
              </p>
            )}

            {audit.length > 0 && (
              <details className="rounded-lg border border-line" open>
                <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-ink">
                  Audit log ({audit.length})
                </summary>
                <ul className="divide-y divide-[#f1f3f4] border-t border-line">
                  {audit.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-[11px]"
                    >
                      <span className="num text-muted">
                        {new Date(entry.at).toLocaleString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                          entry.action === 'undo' ? 'bg-brandSoft text-brand' : 'bg-cloud text-muted'
                        }`}
                      >
                        {entry.action}
                      </span>
                      <span className="text-ink">{entry.adGroupName ?? entry.adGroupId}</span>
                      <span className="num text-muted">{summariseEntry(entry)}</span>
                      {!entry.ok && <span className="text-[#d93025]">failed: {entry.error}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
