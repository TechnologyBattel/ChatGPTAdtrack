// HTTP surface for connector adapters.
//
// Two shapes of route, deliberately kept apart:
//
//   * Tenant routes (`/api/orgs/:org/workspaces/:ws/connectors/hubspot/...`) require a
//     bearer token. The adapter re-proves membership on every call; this router only
//     forwards, so a new connector cannot forget the tenancy check by construction.
//   * The webhook route is public by necessity — HubSpot cannot present our bearer token.
//     It authenticates with HubSpot's own v3 signature and derives the tenant from the
//     path plus the stored source record. A webhook therefore never trusts a body for
//     identity.

import { ApiError } from '../errors.mjs';

export function createConnectorRouter({ hubspot = null, publicBaseUrl = null } = {}) {
  const orgRoute = /^\/api\/orgs\/([^/]+)\/workspaces\/([^/]+)\/connectors\/([^/]+)(?:\/(.*))?$/;
  const webhookRoute = /^\/api\/connectors\/([^/]+)\/webhook\/([^/]+)\/([^/]+)$/;

  function adapterFor(name) {
    if (name !== 'hubspot') throw new ApiError(404, 'not_found', 'No such connector.');
    if (!hubspot) {
      throw new ApiError(503, 'connector_not_configured', 'The HubSpot connector is not configured on this server.');
    }
    return hubspot;
  }

  return {
    async handle({ method, path, body = {}, headers = {}, rawBody = '', principal = null }) {
      const webhook = webhookRoute.exec(path);
      if (webhook) {
        if (method !== 'POST')
          return {
            matched: true,
            status: 405,
            body: { error: { code: 'method_not_allowed', message: 'Webhooks are POST only.' } },
          };
        const [, provider, organizationId, sourceConnectionId] = webhook;
        const connector = adapterFor(provider);
        if (!publicBaseUrl) {
          // The signature covers the exact URL HubSpot called, so without a configured
          // public origin this server cannot verify anything. Refusing is the only
          // honest option.
          throw new ApiError(
            503,
            'webhook_not_configured',
            'PUBLIC_BASE_URL must be set to the public origin of this API so webhook signatures can be verified.',
          );
        }
        const result = await connector.webhook({
          organizationId,
          sourceConnectionId,
          headers,
          rawBody,
          method,
          url: `${publicBaseUrl.replace(/\/$/, '')}${path}`,
        });
        return { matched: true, status: 200, body: result };
      }

      const route = orgRoute.exec(path);
      if (!route) return { matched: false };
      const [, organizationId, workspaceId, provider, suffix = ''] = route;
      const connector = adapterFor(provider);
      if (!principal) throw new ApiError(401, 'unauthenticated', 'Sign in to manage connectors.');

      if (method === 'GET' && suffix === '') {
        const body = await connector.status({ principal, organizationId, workspaceId });
        return { matched: true, status: 200, body };
      }
      if (method === 'POST' && suffix === 'connect') {
        const result = await connector.connectStart({ principal, organizationId, workspaceId, body });
        return { matched: true, status: 200, body: result };
      }
      if (method === 'POST' && suffix === 'connect/complete') {
        const result = await connector.connectComplete({ principal, organizationId, workspaceId, body });
        return { matched: true, status: 200, body: result };
      }
      if (method === 'POST' && suffix === 'sync') {
        const result = await connector.sync({ principal, organizationId, workspaceId, trigger: 'manual' });
        return { matched: true, status: 200, body: result };
      }
      if (method === 'POST' && suffix === 'disconnect') {
        const result = await connector.disconnect({ principal, organizationId, workspaceId });
        return { matched: true, status: 200, body: result };
      }
      throw new ApiError(404, 'not_found', 'No such connector action.');
    },
  };
}
