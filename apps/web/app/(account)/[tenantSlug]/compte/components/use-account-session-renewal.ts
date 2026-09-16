import { useCallback } from 'react';

import { useSessionRenewal, type SessionRenewal } from '@/lib/session-renewal';

import { refreshPath } from '../paths';

/**
 * Le renouvellement de session des écrans de l'espace client — voir
 * `useSessionRenewal` (#856).
 */
export function useAccountSessionRenewal(tenantSlug: string): SessionRenewal {
  const path = useCallback(
    (returnTo: string): string => refreshPath(tenantSlug, returnTo),
    [tenantSlug],
  );

  return useSessionRenewal(path);
}
