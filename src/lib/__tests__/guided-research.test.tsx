// @vitest-environment jsdom
//
// The guided-research screen, with the server stubbed at the fetch boundary.
//
// What is being protected here is the honesty of the states, not the layout: an
// unavailable metric must never render as 0, a running request must not show a
// percentage, and a role that cannot write must be told why rather than shown a button
// that fails.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import GuidedResearch from '../../components/GuidedResearch';
import { createQueryClient } from '../query-client';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const orgs = [{ organizationId: 'org_1', name: 'Agency A', slug: 'agency-a', role: 'owner' }];
const workspaces = [
  {
    workspaceId: 'ws_1',
    name: 'Acme India',
    clientName: 'Acme',
    timeZone: 'Asia/Kolkata',
    currency: 'INR',
    targetMarkets: [{ countryCode: 'IN', region: null, city: null }],
  },
];

const plan = {
  goals: [
    { id: 'attribution', label: 'Review campaign attribution' },
    { id: 'sources', label: 'Review connected data sources' },
  ],
  steps: [
    { id: 'workspace', label: 'Workspace context', detail: '', request: 'workspace' },
    { id: 'sources', label: 'Connected sources', detail: '', request: 'sources' },
    { id: 'analysis', label: 'Assemble findings', detail: '', request: 'run' },
  ],
};

const emptyConnector = {
  provider: 'hubspot',
  configured: false,
  missingConfig: ['HUBSPOT_CLIENT_ID', 'CONNECTOR_ENCRYPTION_KEY'],
  status: 'not_connected',
  connected: false,
  sourceConnectionId: null,
  trustedForQualification: false,
  scopesGranted: [],
  portalId: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  lastSync: null,
  checkpoint: null,
  lastError: null,
  qualifiedStages: [],
  nextAction: 'configure_server',
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    goal: 'attribution',
    goalLabel: 'Review campaign attribution',
    generatedAt: NOW,
    workspace: {
      workspaceId: 'ws_1',
      name: 'Acme India',
      clientName: 'Acme',
      currency: 'INR',
      timeZone: 'Asia/Kolkata',
      targetMarkets: [{ countryCode: 'IN', region: null, city: null }],
    },
    window: { firstEventAt: null, lastEventAt: null, dataFreshness: 'none', currency: 'INR', timeZone: 'Asia/Kolkata' },
    counts: { leads: 0, touchpointEvents: 0 },
    countsAreLowerBound: [],
    dataStates: { leads: 'no_data', touchpointEvents: 'unavailable' },
    permissions: ['data.read'],
    findings: [
      {
        id: 'sources.none',
        severity: 'gap',
        topics: ['sources'],
        title: 'No data source is connected',
        summary: 'Nothing in this workspace has reported an event.',
        evidence: [{ label: 'Sources connected', value: 0, detail: null }],
        limitations: ['An unconnected workspace is “unavailable”, not a workspace with zero leads.'],
        action: { label: 'Connect a CRM or send signed events', kind: 'connect_source' },
      },
    ],
    limitations: ['No keyword volume, CPC, competitor spend or trend is measured by this product.'],
    nextActions: [],
    ...overrides,
  };
}

function stubFetch(overrides: Record<string, () => unknown | Promise<unknown>> = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (url.includes(fragment)) {
        const result = (await handler()) as { status?: number; body: unknown };
        const status = result.status ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () => result.body,
        } as Response;
      }
    }
    const defaults: [string, unknown][] = [
      ['/api/orgs/org_1/workspaces/ws_1/research/plan', plan],
      ['/api/orgs/org_1/workspaces/ws_1/research/runs', { runs: [] }],
      ['/api/orgs/org_1/workspaces/ws_1/connectors/hubspot', emptyConnector],
      [
        '/api/orgs/org_1/permissions',
        { role: 'owner', permissions: ['data.read', 'research.read', 'research.write', 'source.manage'] },
      ],
      ['/api/orgs/org_1/workspaces', { workspaces }],
      ['/api/orgs', { orgs }],
    ];
    const match = defaults.find(([fragment]) => url.includes(fragment));
    return { ok: true, status: 200, json: async () => (match ? match[1] : {}) } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function renderScreen() {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <GuidedResearch />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('guided research', () => {
  it('offers the goals the server published, and says how a run is saved', async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('guided-research')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    expect(screen.getByText('Review connected data sources')).toBeTruthy();
    expect(screen.getByRole('button', { name: /run research/i })).toBeTruthy();
  });

  it('runs a research request and renders the server report without inventing numbers', async () => {
    // The runs *list* must stay a list; only the POST is overridden here.
    const calls = stubFetch({
      'research/runs': () => ({ status: 201, body: { runId: 'res_1', report: report(), goal: 'attribution' } }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    screen.getByRole('button', { name: /run research/i }).click();

    await waitFor(() => expect(screen.getByTestId('research-report')).toBeTruthy());
    const panel = screen.getByTestId('research-report');
    // An unavailable metric is described in words; "0" is not used as a stand-in.
    expect(panel.textContent).toContain('not measurable yet');
    expect(panel.textContent).toContain('none found');
    expect(panel.textContent).toContain('saved as res_1');
    // It states what it cannot know.
    expect(panel.textContent).toContain('No keyword volume, CPC, competitor spend or trend');
    // The request was a POST to this workspace's runs endpoint.
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/api/orgs/org_1/workspaces/ws_1/research/runs'))).toBe(
      true,
    );
  });

  it('tells the user when the server has no HubSpot app configured, naming what is missing', async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('connector-card')).toBeTruthy());
    const card = screen.getByTestId('connector-card');
    await waitFor(() => expect(card.textContent).toContain('HUBSPOT_CLIENT_ID'));
    expect(card.textContent).toContain('CONNECTOR_ENCRYPTION_KEY');
    // No connect button exists when the server cannot honour it.
    expect(card.textContent).not.toContain('Connect HubSpot');
  });

  it('hides write actions from a read-only role and explains why', async () => {
    stubFetch({
      '/permissions': () => ({ body: { role: 'viewer', permissions: ['data.read', 'research.read'] } }),
      '/connectors/hubspot': () => ({
        body: {
          ...emptyConnector,
          configured: true,
          missingConfig: [],
          status: 'connected',
          connected: true,
          lastSyncAt: NOW,
          lastSyncStatus: 'complete',
        },
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('connector-card')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('connector-card').textContent).toContain('source.manage'));
    const run = screen.getByRole('button', { name: /run research/i }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    // The controls exist but cannot be used: a disabled control is honest, a hidden one
    // makes the reader wonder whether they are missing a setting.
    const buttons = screen.getByTestId('connector-card').querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of Array.from(buttons)) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders a network failure as a failure, never as an endless spinner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Failed to fetch/i)).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText(/Loading the agencies/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /run research/i })).toBeNull();
  });

  it('tells an expired session to sign in rather than showing an empty workspace', async () => {
    stubFetch({
      '/api/orgs': () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Token expired.' } } }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Sign in to load this workspace/i)).toBeTruthy(), {
      timeout: 4000,
    });
  });

  it('shows elapsed seconds — not a percentage — while the request is open', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch({
      'research/runs': async () => {
        await gate;
        return { status: 201, body: { runId: 'res_1', report: report() } };
      },
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    screen.getByRole('button', { name: /run research/i }).click();

    await waitFor(() => expect(screen.getByText(/one request is open/i)).toBeTruthy(), { timeout: 4000 });
    const page = screen.getByTestId('guided-research').textContent ?? '';
    expect(page).toMatch(/\d+s — one request is open/);
    // No invented progress: no percentage anywhere in the running state.
    expect(page).not.toMatch(/\d{1,3}\s?%/);

    release();
    await waitFor(() => expect(screen.getByTestId('research-report')).toBeTruthy(), { timeout: 4000 });
  });

  it('marks a capped count as a minimum instead of presenting it as a total', async () => {
    stubFetch({
      'research/runs': () => ({
        status: 201,
        body: {
          runId: 'res_lb',
          goal: 'attribution',
          report: report({
            counts: { leads: 1000 },
            countsAreLowerBound: ['leads'],
            dataStates: { leads: 'observed' },
          }),
        },
      }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    screen.getByRole('button', { name: /run research/i }).click();
    await waitFor(() => expect(screen.getByTestId('research-report')).toBeTruthy());
    const panel = screen.getByTestId('research-report');
    expect(panel.textContent).toContain('≥ 1000');
    expect(panel.textContent).not.toMatch(/(^|[^≥ ])1000(?!\d)/);
    expect(panel.textContent).toContain('store row cap');
  });

  it('says so when HubSpot did not report scopes, and when a sync did not finish', async () => {
    stubFetch({
      '/permissions': () => ({
        body: { role: 'owner', permissions: ['data.read', 'source.manage', 'research.write'] },
      }),
      '/connectors/hubspot': () => ({
        body: {
          ...emptyConnector,
          configured: true,
          missingConfig: [],
          status: 'connected',
          connected: true,
          scopesVerified: false,
          syncStale: true,
          scopesGranted: [],
          lastSyncAt: NOW,
        },
      }),
    });
    renderScreen();
    const card = await screen.findByTestId('connector-card');
    await waitFor(() => expect(card.textContent).toContain('scopes not reported by HubSpot'));
    expect(card.textContent).toContain('last sync did not finish');
    expect(card.textContent).toContain('take over from it');
  });

  it('gives every control on the journey an accessible name', async () => {
    stubFetch();
    renderScreen();
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    const root = screen.getByTestId('guided-research');
    const controls = Array.from(root.querySelectorAll('button, select, input'));
    expect(controls.length).toBeGreaterThan(3);
    const unnamed = controls.filter((el) => {
      const label = el.getAttribute('aria-label')?.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      const text = (el.textContent ?? '').trim();
      return !label && !labelledBy && !text && !el.closest('label');
    });
    expect(unnamed).toEqual([]);
    // The two scope selectors are labelled, not placeholders.
    expect(screen.getByLabelText('Agency')).toBeTruthy();
    expect(screen.getByLabelText('Client workspace')).toBeTruthy();
  });

  it('refuses a malformed success body instead of rendering a broken report', async () => {
    stubFetch({
      'research/runs': () => ({ status: 201, body: { runId: 'res_1', report: null } }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText('Review campaign attribution')).toBeTruthy());
    screen.getByRole('button', { name: /run research/i }).click();
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByTestId('research-report')).toBeNull();
  });

  it('shows a server error as a failure instead of a spinner that never ends', async () => {
    stubFetch({
      '/research/plan': () => ({ status: 403, body: { error: { code: 'forbidden', message: 'Missing data.read.' } } }),
    });
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Missing data\.read\./)).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: /run research/i })).toBeNull();
  });
});
