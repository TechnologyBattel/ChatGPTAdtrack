// @vitest-environment jsdom
// Component tests for the private research panel (AC4c, AC6a, AC7, T12, T13, T17).
//
// These cover the promises the *browser* has to keep: the disclosure is visible before the
// key field, the key never lands in storage, a failed run leaves the deterministic names
// alone, and nothing writes to the push/undo audit store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PrivateResearchPanel from '../../components/PrivateResearchPanel';
import { getPrivateStatus } from '../private-research';

const CLUSTERS = [
  { id: 'c_1', label: 'broad · gst', seeds: ['gst filing last date'] },
  { id: 'c_2', label: 'compare · software', seeds: ['best gst software india'] },
];

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('disclosure (T12)', () => {
  it('states the memory-only guarantee, the provider retention limit, and puts both above the key field', () => {
    render(
      <PrivateResearchPanel
        orgId="org_1"
        status={{ enabled: true, providers: ['openai'] }}
        clusters={CLUSTERS}
        onNamed={() => undefined}
        onClear={() => undefined}
      />,
    );

    const panel = screen.getByTestId('private-research');
    const text = panel.textContent ?? '';
    expect(text).toContain('pass through our server process in memory, never persisted, never logged');
    expect(text).toContain('may retain it under its own policy');
    expect(text).toContain('Nothing is saved');

    // The disclosure must precede the input in document order, not merely exist somewhere.
    const keyField = screen.getByLabelText(/provider api key/i);
    const position = keyField.compareDocumentPosition(panel.firstElementChild as Node);
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('masks the key field', () => {
    render(
      <PrivateResearchPanel
        orgId="org_1"
        status={{ enabled: true, providers: ['openai'] }}
        clusters={CLUSTERS}
        onNamed={() => undefined}
        onClear={() => undefined}
      />,
    );
    const input = screen.getByLabelText(/provider api key/i) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });
});

describe('key handling (AC4c)', () => {
  it('clears the field after a run and never writes the key to storage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          names: [
            { id: 'c_1', name: 'GST filing' },
            { id: 'c_2', name: 'GST software' },
          ],
        }),
      ),
    );
    const onNamed = vi.fn();
    render(
      <PrivateResearchPanel
        orgId="org_1"
        status={{ enabled: true, providers: ['openai'] }}
        clusters={CLUSTERS}
        onNamed={onNamed}
        onClear={() => undefined}
      />,
    );

    const key = 'sk-test-0123456789abcdefghijklmnop';
    fireEvent.change(screen.getByLabelText(/provider api key/i), { target: { value: key } });
    fireEvent.change(screen.getByLabelText(/^Model/i), { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(screen.getByRole('button', { name: /name clusters/i }));

    await waitFor(() => expect(onNamed).toHaveBeenCalled());
    expect(onNamed.mock.calls[0][0]).toEqual([
      { id: 'c_1', name: 'GST filing' },
      { id: 'c_2', name: 'GST software' },
    ]);

    const input = screen.getByLabelText(/provider api key/i) as HTMLInputElement;
    expect(input.value).toBe('');

    const dump = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    expect(dump).not.toContain(key);
    expect(dump).not.toContain('sk-test');
    // And the push/undo audit store is untouched.
    expect(window.localStorage.getItem('adtrack.audit.v1')).toBeNull();
  });
});

describe('failure behaviour (AC7)', () => {
  it('shows a fixed message, keeps the deterministic result, and does not call onNamed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(502, { error: { code: 'provider_unavailable', message: 'upstream exploded: sk-test-0123' } }),
      ),
    );
    const onNamed = vi.fn();
    render(
      <PrivateResearchPanel
        orgId="org_1"
        status={{ enabled: true, providers: ['openai'] }}
        clusters={CLUSTERS}
        onNamed={onNamed}
        onClear={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText(/provider api key/i), {
      target: { value: 'sk-test-0123456789abcdefghijklmnop' },
    });
    fireEvent.change(screen.getByLabelText(/^Model/i), { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(screen.getByRole('button', { name: /name clusters/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be reached');
    // Our own wording, never the provider's: it may quote the request.
    expect(alert.textContent).not.toContain('upstream exploded');
    expect(alert.textContent).toContain('deterministic clusters and names are unchanged');
    expect(onNamed).not.toHaveBeenCalled();
  });
});

describe('status resolution (T13)', () => {
  it('treats a 404 as "feature absent" rather than an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: { code: 'not_configured', message: 'nope' } })),
    );
    await expect(getPrivateStatus('org_1')).resolves.toBeNull();
  });

  it('treats a 403 as "not for this caller"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(403, { error: { code: 'forbidden', message: 'nope' } })),
    );
    await expect(getPrivateStatus('org_1')).resolves.toBeNull();
  });

  it('surfaces a real status when enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { enabled: true, providers: ['openai', 'anthropic'] })),
    );
    await expect(getPrivateStatus('org_1')).resolves.toEqual({ enabled: true, providers: ['openai', 'anthropic'] });
  });
});
