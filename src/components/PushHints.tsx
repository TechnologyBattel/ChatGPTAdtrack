import { useEffect, useMemo, useRef, useState } from 'react';
import { pushHints } from '../lib/api';
import { appendAudit, createLocalStore, describeDiff, diffHints, type AuditEntry, type AuditStore } from '../lib/hints';

export interface TargetAdGroup {
  id: string;
  name: string;
  hints: string[];
}

interface Props {
  /** Ad group the hint set will replace. Null until a target is chosen. */
  adGroup: TargetAdGroup | null;
  candidateHints: string[];
  /** False in demo mode: the server has no Advertiser API key. */
  live: boolean;
  disabledReason?: string;
  store?: AuditStore;
  onAudit?: (entries: AuditEntry[]) => void;
  onPushed?: (adGroupId: string, after: string[]) => void;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; at: string; previousHints: string[]; pushed: string[] };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function PushHints({ adGroup, candidateHints, live, disabledReason, store, onAudit, onPushed }: Props) {
  const auditStore = useMemo(() => store ?? createLocalStore(), [store]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const [undo, setUndo] = useState<{ previousHints: string[]; at: string } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const diff = useMemo(() => diffHints(adGroup?.hints ?? [], candidateHints), [adGroup?.hints, candidateHints]);

  const blockedReason = !live
    ? (disabledReason ?? 'The server has no Advertiser API key, so hint sets cannot be pushed.')
    : !adGroup
      ? 'Choose a target ad group first.'
      : candidateHints.length === 0
        ? 'This cluster produced no hints to push.'
        : diff.changed === 0
          ? 'This set is already identical to the ad group.'
          : null;

  const disabled = Boolean(blockedReason);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.kind !== 'saving') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, state.kind]);

  const confirm = async () => {
    if (!adGroup) return;
    setState({ kind: 'saving' });
    const before = adGroup.hints;
    try {
      const result = await pushHints(adGroup.id, candidateHints);
      const after = result.pushedHints?.length ? result.pushedHints : candidateHints;
      const previousHints = result.previousHints ?? before;
      setState({ kind: 'done', at: result.versionedAt ?? new Date().toISOString(), previousHints, pushed: after });
      setUndo({ previousHints, at: result.versionedAt ?? new Date().toISOString() });
      setOpen(false); // the Undo affordance lives in the panel, not behind the dialog
      onAudit?.(
        appendAudit(auditStore, {
          action: 'push',
          adGroupId: adGroup.id,
          adGroupName: adGroup.name,
          before,
          after,
          ok: true,
        }),
      );
      onPushed?.(adGroup.id, after);
    } catch (error) {
      const message = errorMessage(error);
      setState({ kind: 'error', message });
      onAudit?.(
        appendAudit(auditStore, {
          action: 'push',
          adGroupId: adGroup.id,
          adGroupName: adGroup.name,
          before,
          after: candidateHints,
          ok: false,
          error: message,
        }),
      );
    }
  };

  const runUndo = async () => {
    if (!adGroup || !undo) return;
    setUndoBusy(true);
    setState({ kind: 'idle' });
    const before = adGroup.hints;
    try {
      const result = await pushHints(adGroup.id, undo.previousHints);
      const after = result.pushedHints?.length ? result.pushedHints : undo.previousHints;
      setUndo(null);
      setState({ kind: 'done', at: result.versionedAt ?? new Date().toISOString(), previousHints: [], pushed: after });
      onAudit?.(
        appendAudit(auditStore, {
          action: 'undo',
          adGroupId: adGroup.id,
          adGroupName: adGroup.name,
          before,
          after,
          ok: true,
        }),
      );
      onPushed?.(adGroup.id, after);
    } catch (error) {
      const message = errorMessage(error);
      setState({ kind: 'error', message });
      onAudit?.(
        appendAudit(auditStore, {
          action: 'undo',
          adGroupId: adGroup.id,
          adGroupName: adGroup.name,
          before,
          after: undo.previousHints,
          ok: false,
          error: message,
        }),
      );
    } finally {
      setUndoBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setState({ kind: 'idle' });
          setOpen(true);
        }}
        disabled={disabled}
        title={blockedReason ?? 'Review the diff, then confirm'}
        className="rounded-full border border-line px-3 py-1 text-[11px] text-ink transition hover:bg-cloud disabled:cursor-not-allowed disabled:border-dashed disabled:text-subtle disabled:hover:bg-transparent"
      >
        Push to ad group
      </button>

      {blockedReason && <span className="text-[11px] text-subtle">{blockedReason}</span>}

      {undo && !undoBusy && (
        <button
          type="button"
          onClick={() => void runUndo()}
          className="rounded-full border border-[#d2e3fc] bg-brandSoft px-3 py-1 text-[11px] text-brand transition hover:bg-[#d2e3fc]"
        >
          Undo push
        </button>
      )}
      {undoBusy && <span className="text-[11px] text-muted">Restoring…</span>}
      {undo && !undoBusy && (
        <span className="text-[11px] text-muted">rollback copy: {undo.previousHints.length} hints</span>
      )}
      {state.kind === 'error' && !open && (
        <span role="alert" className="text-[11px] text-[#d93025]">
          {state.message}
        </span>
      )}
      {state.kind === 'done' && !undo && (
        <span role="status" className="text-[11px] text-good">
          Restored previous hint set ({state.pushed.length} hints)
        </span>
      )}

      {open && adGroup && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(32,33,36,0.4)] px-4 py-10 print:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget && state.kind !== 'saving') setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="push-title"
            aria-describedby="push-desc"
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-white shadow-card"
          >
            <div className="border-b border-line px-4 py-3">
              <h2 id="push-title" className="text-[15px] font-medium text-ink">
                Push hints to {adGroup.name}
              </h2>
              <p id="push-desc" className="mt-0.5 text-[12px] leading-5 text-muted">
                This replaces the ad group&apos;s context hints. OpenAI keeps no history, so the current set is copied
                locally and offered as Undo.
              </p>
            </div>

            <div className="max-h-[52vh] overflow-y-auto px-4 py-3">
              <p className="num mb-2 rounded-lg bg-cloud px-2.5 py-1.5 text-[12px] text-ink" aria-live="polite">
                {describeDiff(diff)}
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <section aria-label="Current hints">
                  <h3 className="mb-1 text-[12px] font-medium text-ink">Current ({adGroup.hints.length})</h3>
                  <ul className="space-y-1">
                    {adGroup.hints.length === 0 && <li className="text-[12px] text-muted">No hints set.</li>}
                    {adGroup.hints.map((hint) => {
                      const removing = diff.removed.includes(hint);
                      return (
                        <li
                          key={hint}
                          className={`rounded-md px-2 py-1 text-[12px] leading-5 ${
                            removing ? 'bg-dangerSoft text-[#a50e0e] line-through' : 'bg-cloud text-ink'
                          }`}
                        >
                          {hint}
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section aria-label="Proposed hints">
                  <h3 className="mb-1 text-[12px] font-medium text-ink">Proposed ({candidateHints.length})</h3>
                  <ul className="space-y-1">
                    {candidateHints.map((hint) => {
                      const adding = diff.added.includes(hint);
                      return (
                        <li
                          key={hint}
                          className={`rounded-md px-2 py-1 text-[12px] leading-5 ${
                            adding ? 'bg-[#e6f4ea] text-good' : 'bg-cloud text-ink'
                          }`}
                        >
                          {hint}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>

              {state.kind === 'error' && (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-[#f6aea9] bg-dangerSoft px-2.5 py-1.5 text-[12px] leading-5 text-[#a50e0e]"
                >
                  {state.message}
                </p>
              )}
              {state.kind === 'done' && (
                <p
                  role="status"
                  className="mt-3 rounded-md border border-[#ceead6] bg-[#e6f4ea] px-2.5 py-1.5 text-[12px] leading-5 text-good"
                >
                  Pushed {state.pushed.length} hints. Undo is available while this page is open.
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line bg-cloud px-4 py-2.5">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setOpen(false)}
                disabled={state.kind === 'saving'}
                className="rounded-full px-3 py-1.5 text-[12px] text-muted hover:bg-white disabled:opacity-50"
              >
                {state.kind === 'done' ? 'Close' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={state.kind === 'saving' || diff.changed === 0}
                className="rounded-full bg-brand px-4 py-1.5 text-[12px] font-medium text-white transition hover:bg-[#1765cc] disabled:opacity-40"
              >
                {state.kind === 'saving' ? 'Pushing…' : `Push ${candidateHints.length} hints`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
