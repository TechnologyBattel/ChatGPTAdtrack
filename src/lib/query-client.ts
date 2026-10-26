// One query cache for the app, created per page load.
//
// Keys are built with the organization *and* workspace id wherever data is
// tenant-scoped (see components/GuidedResearch.tsx), so switching client can never show
// the previous client's numbers while the new request is in flight.

import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A failed read is shown as a failure. Retrying a 403 or a 404 only delays it.
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
      mutations: { retry: 0 },
    },
  });
}
