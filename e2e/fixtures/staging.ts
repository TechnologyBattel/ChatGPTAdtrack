// Staging fixture for the browser suite.
//
// The suite runs against a real API process, so it needs a real agency and workspace: the
// guided-research screen correctly says "you are not a member of any agency yet" on an
// empty install, and a test that pretends otherwise would only pass by mocking the thing
// it is meant to verify.
//
// Everything here goes through the application's own HTTP API with a dev session, so the
// records are created the same way a user would create them — no direct store writes, no
// invented provider data. It is idempotent: running the suite twice reuses the same agency.
//
// This is deliberately restricted to first-party records (an organisation and a client
// workspace). It never creates leads, events or CRM records, so the report the browser
// sees is the honest "no data yet" state.

import { request as playwrightRequest } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:8787';
const ORG_NAME = 'E2E Staging Agency';
const WORKSPACE_NAME = 'E2E Client Workspace';

export type SeededScope = { organizationId: string; workspaceId: string; token: string };

type Json = Record<string, unknown>;

async function json(response: {
  json: () => Promise<unknown>;
  status: () => number;
  url: () => string;
}): Promise<Json> {
  const body = (await response.json()) as Json;
  if (response.status() >= 400) {
    throw new Error(`fixture request failed: ${response.status()} ${response.url()} ${JSON.stringify(body)}`);
  }
  return body;
}

/** Create (or reuse) an agency with one workspace, as the dev user, via the public API. */
export async function seedWorkspace(): Promise<SeededScope> {
  const context = await playwrightRequest.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'content-type': 'application/json' },
  });
  try {
    const session = await json(await context.post('/api/dev/session'));
    // Dev sessions are only issued in dev auth mode. If this 404s the suite is pointed at
    // a production-mode server, which is a configuration error worth failing loudly on.
    const token: string = session.token;
    const headers = { authorization: `Bearer ${token}` };

    const orgs = await json(await context.get('/api/orgs', { headers }));
    const existing = ((orgs.orgs ?? []) as Json[]).find((org) => org.name === ORG_NAME);
    let organizationId = String(existing?.organizationId ?? '');
    if (!organizationId) {
      const created = await json(await context.post('/api/orgs', { headers, data: { name: ORG_NAME } }));
      organizationId = String(created.organizationId);
    }

    const workspaces = await json(await context.get(`/api/orgs/${organizationId}/workspaces`, { headers }));
    const found = ((workspaces.workspaces ?? []) as Json[]).find((workspace) => workspace.name === WORKSPACE_NAME);
    const workspaceId: string =
      String(found?.workspaceId ?? '') ||
      (
        await json(
          await context.post(`/api/orgs/${organizationId}/workspaces`, {
            headers,
            data: {
              name: WORKSPACE_NAME,
              clientName: 'E2E Client',
              timeZone: 'Asia/Kolkata',
              currency: 'INR',
              defaultLanguage: 'en',
              targetMarkets: [{ countryCode: 'IN', region: 'Maharashtra', city: 'Pune' }],
            },
          }),
        )
      ).workspaceId;

    return { organizationId, workspaceId, token };
  } finally {
    await context.dispose();
  }
}

/** Bearer token for the dev user, for tests that call the API directly. */
export async function devToken(): Promise<string> {
  const context = await playwrightRequest.newContext({ baseURL: API });
  try {
    return (await json(await context.post('/api/dev/session'))).token;
  } finally {
    await context.dispose();
  }
}
