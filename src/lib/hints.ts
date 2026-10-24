// Push/rollback support for context hints: a pure diff and an append-only audit
// log. No React, no fetch — so both are directly testable.

export interface HintDiff {
  added: string[];
  removed: string[];
  kept: string[];
  /** 0 when nothing would change. */
  changed: number;
}

/** Hints are prose, so casing and stray whitespace must not count as a change. */
function key(hint: string): string {
  return hint.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Compare what an ad group has now with what we intend to push. The proposed
 * list wins on ordering and on the exact wording it carries.
 */
export function diffHints(current: string[], proposed: string[]): HintDiff {
  const currentKeys = new Set(current.map(key));
  const proposedKeys = new Set(proposed.map(key));
  const seen = new Set<string>();

  const added: string[] = [];
  for (const hint of proposed) {
    const k = key(hint);
    if (seen.has(k)) continue; // a duplicate in the input is not a second hint
    seen.add(k);
    if (!currentKeys.has(k)) added.push(hint);
  }

  const removed = current.filter((hint) => !proposedKeys.has(key(hint)));
  const kept = proposed.filter((hint) => currentKeys.has(key(hint)) && seen.has(key(hint)));

  return {
    added,
    removed,
    kept: [...new Map(kept.map((h) => [key(h), h])).values()],
    changed: added.length + removed.length,
  };
}

export function describeDiff(diff: HintDiff): string {
  return `+${diff.added.length} to add · −${diff.removed.length} to remove · ${diff.kept.length} unchanged`;
}

export type AuditAction = 'push' | 'undo';

export interface AuditEntry {
  id: string;
  at: string;
  action: AuditAction;
  adGroupId: string;
  adGroupName?: string;
  before: string[];
  after: string[];
  ok: boolean;
  error?: string;
}

export interface AuditStore {
  read(): AuditEntry[];
  write(entries: AuditEntry[]): void;
}

const MAX_ENTRIES = 100;

/** Used by tests, and as a fallback when storage is unavailable. */
export function createMemoryStore(seed: AuditEntry[] = []): AuditStore {
  let entries = [...seed];
  return {
    read: () => [...entries],
    write: (next) => {
      entries = [...next];
    },
  };
}

export function createLocalStore(key = 'adtrack.audit.v1'): AuditStore {
  const available = () => {
    try {
      return typeof window !== 'undefined' && Boolean(window.localStorage);
    } catch {
      return false;
    }
  };
  return {
    read() {
      if (!available()) return [];
      try {
        const raw = window.localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
      } catch {
        return [];
      }
    },
    write(entries) {
      if (!available()) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
      } catch {
        /* quota or privacy mode: the log is a convenience, not a record of truth */
      }
    },
  };
}

/**
 * Append one attempt. Failures are logged too — an audit trail that only records
 * successes hides exactly the incidents you need to explain later.
 */
export function appendAudit(
  store: AuditStore,
  entry: Omit<AuditEntry, 'id' | 'at'> & { id?: string; at?: string },
): AuditEntry[] {
  const at = entry.at ?? new Date().toISOString();
  const id = entry.id ?? `${Date.parse(at)}-${Math.random().toString(36).slice(2, 8)}`;
  const next = [{ ...entry, id, at }, ...store.read()].slice(0, MAX_ENTRIES);
  store.write(next);
  return next;
}

export function summariseEntry(entry: AuditEntry): string {
  const delta = entry.after.length - entry.before.length;
  const sign = delta > 0 ? `+${delta}` : String(delta);
  return `${entry.before.length} → ${entry.after.length} hints (${sign})`;
}
