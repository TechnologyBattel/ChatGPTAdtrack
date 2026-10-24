// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PushHints, { type TargetAdGroup } from '../../components/PushHints';
import Research from '../../components/Research';
import { appendAudit, createMemoryStore, describeDiff, diffHints, type AuditEntry } from '../hints';

const pushHints = vi.fn();
vi.mock('../api', () => ({
  pushHints: (...args: unknown[]) => pushHints(...args),
}));

const adGroup: TargetAdGroup = {
  id: 'adgrp_gst',
  name: 'GST filing stress',
  hints: ['someone who is behind on GST filing', 'an accountant filing returns manually'],
};

const proposed = [
  'someone who is behind on GST filing', // kept
  'a business owner asking how to reconcile GSTR-2B before the deadline', // added
];

beforeEach(() => {
  pushHints.mockReset();
});

afterEach(cleanup);

function renderPush(overrides: Partial<Parameters<typeof PushHints>[0]> = {}) {
  const onAudit = vi.fn();
  const onPushed = vi.fn();
  const store = createMemoryStore();
  render(
    <PushHints
      adGroup={adGroup}
      candidateHints={proposed}
      live
      store={store}
      onAudit={onAudit}
      onPushed={onPushed}
      {...overrides}
    />,
  );
  return { onAudit, onPushed, store };
}

describe('diff', () => {
  it('separates added, removed and kept hints', () => {
    const diff = diffHints(adGroup.hints, proposed);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.kept).toHaveLength(1);
    expect(diff.changed).toBe(2);
  });

  it('ignores casing and whitespace when deciding what changed', () => {
    const diff = diffHints(['Someone who is behind on GST filing'], ['  someone who is behind on gst filing ']);
    expect(diff.changed).toBe(0);
  });

  it('collapses duplicates so they cannot inflate the count', () => {
    const diff = diffHints([], ['a hint', 'a hint', 'A Hint']);
    expect(diff.added).toHaveLength(1);
  });

  it('describes itself in one line', () => {
    expect(describeDiff(diffHints(adGroup.hints, proposed))).toBe('+1 to add · −1 to remove · 1 unchanged');
  });
});

describe('demo mode', () => {
  it('is disabled with a visible reason and cannot open the dialog', () => {
    renderPush({ live: false });
    const button = screen.getByRole('button', { name: 'Push to ad group' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/no Advertiser API key/i)).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pushHints).not.toHaveBeenCalled();
  });

  it('uses a specific reason when one is supplied', () => {
    renderPush({ live: false, disabledReason: 'Connect the Advertiser API key to push hints.' });
    expect(screen.getByText('Connect the Advertiser API key to push hints.')).toBeTruthy();
  });

  it('is also disabled without a target ad group or when nothing would change', () => {
    const { unmount } = render(<PushHints adGroup={null} candidateHints={proposed} live store={createMemoryStore()} />);
    expect((screen.getByRole('button', { name: 'Push to ad group' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Choose a target ad group/i)).toBeTruthy();
    unmount();

    render(<PushHints adGroup={adGroup} candidateHints={[...adGroup.hints]} live store={createMemoryStore()} />);
    expect((screen.getByRole('button', { name: 'Push to ad group' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/already identical/i)).toBeTruthy();
  });
});

describe('diff modal', () => {
  it('shows current and proposed hints with counts', () => {
    renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Push hints to GST filing stress/)).toBeTruthy();
    expect(within(dialog).getByText('+1 to add · −1 to remove · 1 unchanged')).toBeTruthy();
    expect(within(dialog).getByText('Current (2)')).toBeTruthy();
    expect(within(dialog).getByText('Proposed (2)')).toBeTruthy();

    const current = within(dialog).getByLabelText('Current hints');
    const next = within(dialog).getByLabelText('Proposed hints');
    // The removed hint is struck through in the current column.
    const removed = within(current).getByText('an accountant filing returns manually');
    expect(removed.className).toContain('line-through');
    // The added hint is highlighted in the proposed column.
    const added = within(next).getByText(/reconcile GSTR-2B before the deadline/);
    expect(added.className).toContain('text-good');
  });

  it('closes on Escape and on Cancel without pushing', () => {
    renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pushHints).not.toHaveBeenCalled();
  });
});

describe('confirm gate', () => {
  it('does not call the API until the confirm button is pressed', () => {
    pushHints.mockResolvedValue({
      adGroupId: adGroup.id,
      previousHints: adGroup.hints,
      pushedHints: proposed,
      versionedAt: 'now',
    });
    renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    expect(pushHints).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));
    expect(pushHints).toHaveBeenCalledWith(adGroup.id, proposed);
  });

  it('logs the push with before and after sets', async () => {
    pushHints.mockResolvedValue({
      adGroupId: adGroup.id,
      previousHints: adGroup.hints,
      pushedHints: proposed,
      versionedAt: '2026-10-24T10:00:00.000Z',
    });
    const { onAudit, onPushed } = renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));

    await waitFor(() => expect(onAudit).toHaveBeenCalled());
    const entries = onAudit.mock.calls.at(-1)![0] as AuditEntry[];
    expect(entries[0]).toMatchObject({
      action: 'push',
      adGroupId: 'adgrp_gst',
      before: adGroup.hints,
      after: proposed,
      ok: true,
    });
    expect(entries[0].at).toBeTruthy();
    expect(onPushed).toHaveBeenCalledWith(adGroup.id, proposed);
  });
});

describe('undo', () => {
  it('pushes the previous set back and logs the undo', async () => {
    pushHints
      .mockResolvedValueOnce({
        adGroupId: adGroup.id,
        previousHints: adGroup.hints,
        pushedHints: proposed,
        versionedAt: '2026-10-24T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        adGroupId: adGroup.id,
        previousHints: proposed,
        pushedHints: adGroup.hints,
        versionedAt: '2026-10-24T10:05:00.000Z',
      });

    const { onAudit, onPushed } = renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));

    const undoButton = await screen.findByRole('button', { name: 'Undo push' });
    expect(screen.getByText(/rollback copy: 2 hints/)).toBeTruthy();

    fireEvent.click(undoButton);
    await waitFor(() => expect(pushHints).toHaveBeenCalledTimes(2));
    // Undo sends exactly the previous set, not the live ad-group state.
    expect(pushHints.mock.calls[1]).toEqual([adGroup.id, adGroup.hints]);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo push' })).toBeNull());
    expect(screen.getByText(/Restored previous hint set \(2 hints\)/)).toBeTruthy();
    expect(onPushed).toHaveBeenLastCalledWith(adGroup.id, adGroup.hints);

    const entries = onAudit.mock.calls.at(-1)![0] as AuditEntry[];
    expect(entries[0]).toMatchObject({ action: 'undo', before: adGroup.hints, after: adGroup.hints, ok: true });
  });

  it('surfaces an undo failure and keeps the undo button available', async () => {
    pushHints
      .mockResolvedValueOnce({
        adGroupId: adGroup.id,
        previousHints: adGroup.hints,
        pushedHints: proposed,
        versionedAt: 'now',
      })
      .mockRejectedValueOnce(new Error('Ads API 500: ad group is locked by another edit'));

    renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo push' }));

    expect(await screen.findByText(/ad group is locked by another edit/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo push' })).toBeTruthy();
  });
});

describe('errors', () => {
  it('shows the upstream message verbatim and logs the failure', async () => {
    pushHints.mockRejectedValue(new Error('Ads API 403: missing scope ads_write'));
    const { onAudit } = renderPush();

    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Ads API 403: missing scope ads_write');
    expect(screen.queryByRole('button', { name: 'Undo push' })).toBeNull();

    const entries = onAudit.mock.calls.at(-1)![0] as AuditEntry[];
    expect(entries[0]).toMatchObject({ action: 'push', ok: false, error: 'Ads API 403: missing scope ads_write' });
  });

  it('never fails silently when the rejection is not an Error', async () => {
    pushHints.mockRejectedValue('gateway timeout');
    renderPush();
    fireEvent.click(screen.getByRole('button', { name: 'Push to ad group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push 2 hints' }));
    expect((await screen.findByRole('alert')).textContent).toBe('gateway timeout');
  });
});

describe('audit log store', () => {
  it('keeps newest first and caps the history', () => {
    const store = createMemoryStore();
    for (let i = 0; i < 105; i++) {
      appendAudit(store, {
        action: 'push',
        adGroupId: 'a',
        before: [],
        after: [`hint ${i}`],
        ok: true,
        at: new Date(2026, 0, 1, 0, i).toISOString(),
      });
    }
    const entries = store.read();
    expect(entries).toHaveLength(100);
    expect(entries[0].after[0]).toBe('hint 104');
  });
});

describe('research panel wiring', () => {
  const groups: TargetAdGroup[] = [
    { id: 'adgrp_gst', name: 'GST filing stress', hints: ['an old hint about filing'] },
    { id: 'adgrp_invoice', name: 'Invoice data entry', hints: [] },
  ];

  function runCluster() {
    fireEvent.click(screen.getByRole('button', { name: /Cluster & score/i }));
  }

  it('shows the disabled push control in demo mode', () => {
    render(
      <Research
        initialSeeds="gst filing\ninvoice automation for accountants"
        live={false}
        adGroups={groups}
        auditStore={createMemoryStore()}
      />,
    );
    runCluster();
    const button = screen.getByRole('button', { name: 'Push to ad group' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/no Advertiser API key/i)).toBeTruthy();
  });

  it('enables the control in live mode and offers the audit log after a push', async () => {
    pushHints.mockResolvedValue({
      adGroupId: 'adgrp_gst',
      previousHints: ['an old hint about filing'],
      pushedHints: ['a new hint'],
      versionedAt: '2026-10-24T10:00:00.000Z',
    });
    const store = createMemoryStore();
    render(
      <Research
        initialSeeds="gst filing\ninvoice automation for accountants"
        live
        adGroups={groups}
        auditStore={store}
      />,
    );
    runCluster();

    // Target selector is populated from the live ad-group list.
    const select = screen.getByLabelText('Target ad group') as HTMLSelectElement;
    expect(within(select).getAllByRole('option')).toHaveLength(2);
    fireEvent.change(select, { target: { value: 'adgrp_gst' } });

    const button = screen.getByRole('button', { name: 'Push to ad group' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: /^Push \d+ hints$/ }));

    await waitFor(() => expect(pushHints).toHaveBeenCalled());
    expect(store.read()[0]).toMatchObject({ action: 'push', adGroupId: 'adgrp_gst', ok: true });
    expect(await screen.findByText(/Audit log \(1\)/)).toBeTruthy();
  });
});
