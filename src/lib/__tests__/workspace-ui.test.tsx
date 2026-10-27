// @vitest-environment jsdom
//
// The workspace panel may only repeat what the server said. This test drives it with a
// stubbed fetch and checks three product rules:
//   1. a metric the product does not collect is shown as "unavailable", never 0;
//   2. a lead nobody qualified says so, and a suggestion is labelled as one;
//   3. no credential means an explanation, not an empty dashboard of zeros.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import WorkspacePanel from '../../components/WorkspacePanel';
import { setTokenReader } from '../api';

const ORG = { organizationId: 'org_1', name: 'Agency', slug: 'agency', role: 'owner', plan: 'free' };
const WS = {
  workspaceId: 'ws_1',
  name: 'Main',
  clientName: 'Client A',
  timeZone: 'Asia/Kolkata',
  currency: 'INR',
  targetMarkets: [{ countryCode: 'IN', region: null, city: null }],
};

// Set by a test that wants a workspace with nothing in it yet.
let noLeads = false;

function route(url: string) {
  if (url.endsWith('/api/orgs')) return { orgs: [ORG] };
  if (url.endsWith('/workspaces')) return { workspaces: [WS] };
  if (url.endsWith('/permissions')) return { role: 'owner', permissions: ['data.read', 'campaign.write'] };
  if (url.endsWith('/summary'))
    return {
      workspace: WS,
      counts: {
        campaigns: 1,
        topics: 2,
        leads: noLeads ? 0 : 1,
        leadsQualified: 0,
        events: 4,
        sourceConnections: 1,
      },
      currency: 'INR',
      unavailable: ['search_volume', 'cpc'],
      missing: ['first_party_revenue'],
      freshness: { lastEventAt: 1_760_000_000_000, lastSyncAt: null },
    };
  if (url.endsWith('/campaigns'))
    return {
      campaigns: [
        {
          campaignId: 'cmp_1',
          name: 'Diwali search',
          status: 'draft',
          launchState: 'not_launched',
          primaryConversion: 'qualified_lead',
          createdAt: 1,
        },
      ],
    };
  if (url.endsWith('/topics'))
    return {
      topics: [
        {
          topicId: 't_1',
          seed: 'gst filing',
          question: 'how to file gst',
          intent: 'informational',
          funnelStage: 'top',
          status: 'new',
          origin: 'observed',
          freshness: 'fresh',
          source: {
            url: 'https://search.google.com/search-console',
            name: null,
            observedAt: 1_759_000_000_000,
            observedAtRaw: '2025-09-28',
            method: 'search_console',
          },
        },
        {
          topicId: 't_2',
          seed: 'gst software',
          question: 'best gst software',
          intent: 'commercial',
          funnelStage: 'mid',
          status: 'new',
          origin: 'ai_suggested',
          freshness: 'unknown',
          source: null,
        },
      ],
    };
  if (url.endsWith('/leads'))
    return {
      leads: noLeads ? [] : [{ leadId: 'lead_1', campaignId: 'cmp_1', createdAt: 2, qualification: null }],
    };
  if (url.endsWith('/sources'))
    return {
      sources: [
        {
          sourceConnectionId: 'src_1',
          provider: 'crm',
          label: 'HubSpot',
          capability: 'read',
          status: 'active',
          trustedForQualification: true,
          lastSyncAt: null,
        },
      ],
    };
  return {};
}

beforeEach(() => {
  noLeads = false;
  setTokenReader(() => 'test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => route(String(input)),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setTokenReader(null);
});

describe('workspace panel', () => {
  it('shows the hierarchy the server reports', async () => {
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Diwali search')).toBeTruthy());
    expect(screen.getByText('Client A — Main')).toBeTruthy();
    expect(screen.getByText(/INR · Asia\/Kolkata · IN/)).toBeTruthy();
    expect(screen.getByText('HubSpot')).toBeTruthy();
  });

  it('shows the organization plan beside the selector, and defaults to free', async () => {
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Free plan')).toBeTruthy());
  });

  it('still says free when the server sends an organization with no plan', async () => {
    // Organizations written before the field existed have none; the pill must not be blank.
    const legacy = { ...ORG } as Partial<typeof ORG>;
    delete legacy.plan;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/orgs')) {
          return { ok: true, status: 200, json: async () => ({ orgs: [legacy] }) };
        }
        return { ok: true, status: 200, json: async () => route(url) };
      }),
    );
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Free plan')).toBeTruthy());
  });

  it('labels unmeasured metrics as unavailable rather than zero', async () => {
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Diwali search')).toBeTruthy());
    // The list the server refuses to measure is printed as such.
    expect(screen.getByText(/search_volume, cpc/)).toBeTruthy();
    expect(screen.getByText(/Not collected by this product/)).toBeTruthy();
    // Areas with no data at all are named, not rendered as an empty table.
    expect(screen.getByText(/no data yet/)).toBeTruthy();
  });

  it('calls qualification unavailable when there are no leads to qualify', async () => {
    noLeads = true;
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('Diwali search')).toBeTruthy());
    // Nothing was measured, so a 0 would read as "we qualified none of them".
    expect(screen.getByText('unavailable')).toBeTruthy();
    expect(screen.getByText(/No leads recorded/)).toBeTruthy();
  });

  it('distinguishes an observed topic from an AI suggestion and never implies qualification', async () => {
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('how to file gst')).toBeTruthy());
    expect(screen.getByText(/observed via search_console/)).toBeTruthy();
    expect(screen.getByText(/AI suggestion — not observed evidence/)).toBeTruthy();
    expect(screen.getByText(/not qualified by any user or CRM/)).toBeTruthy();
  });

  it('explains a missing credential instead of rendering zeros', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'unauthenticated', message: 'Sign in to use this route.' } }),
      })),
    );
    render(<WorkspacePanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/Sign in to use this route/)).toBeTruthy());
    expect(screen.getByText(/needs a signed-in account/)).toBeTruthy();
  });
});
