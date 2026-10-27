// The production client factory for the HubSpot connector.
//
// The official SDK (`@hubspot/api-client`, ISC licence) is an optional dependency and is
// imported lazily, exactly like `firebase-admin`: a deployment that does not configure
// HubSpot never loads it, and a missing module is a clear startup message rather than a
// crash inside a request.
//
// Signatures below were read from the installed package's own type declarations
// (`lib/codegen/crm/{contacts,deals}/types/PromiseAPI.d.ts`), not assumed:
//
//   basicApi.getPage(limit?, after?, properties?, propertiesWithHistory?, associations?)
//   basicApi.getById(id, properties?, propertiesWithHistory?, associations?)
//
// The SDK performs its own internal retries; they are disabled here so this connector is
// the single owner of retry policy and backoff.

const SDK_MISSING =
  'The HubSpot connector needs the optional dependency @hubspot/api-client. Install it with `npm install @hubspot/api-client`.';

/**
 * Returns `clientFactory(accessToken)` for the connector, or throws a clear error when the
 * SDK is not installed.
 */
export async function createHubSpotSdkClientFactory({ basePath } = {}) {
  let Client;
  try {
    ({ Client } = await import('@hubspot/api-client'));
  } catch {
    throw new Error(SDK_MISSING);
  }

  return function clientFactory(accessToken) {
    if (!accessToken) throw new Error('clientFactory requires an access token');
    const client = new Client({
      accessToken,
      // This connector owns retry/backoff, so the SDK must not add its own.
      numberOfApiCallRetries: 0,
      ...(basePath ? { basePath } : {}),
    });

    const page = async (api, { limit, after, properties, associations }) =>
      api.getPage(limit, after, properties, undefined, associations);
    const byId = async (api, id, properties, associations) => api.getById(id, properties, undefined, associations);

    return {
      contacts: {
        getPage: ({ limit, after, properties }) => page(client.crm.contacts.basicApi, { limit, after, properties }),
        getById: (id, properties) => byId(client.crm.contacts.basicApi, id, properties),
      },
      deals: {
        getPage: ({ limit, after, properties, associations }) =>
          page(client.crm.deals.basicApi, { limit, after, properties, associations }),
        getById: (id, properties, associations) => byId(client.crm.deals.basicApi, id, properties, associations),
      },
    };
  };
}
