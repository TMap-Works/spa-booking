import { useCallback } from 'react';

import { useSessionRenewal, type SessionRenewal } from '@/lib/session-renewal';

import { adminSessionRefreshPath } from '../paths';

/**
 * Le renouvellement de session des écrans du back-office — voir
 * `useSessionRenewal` (#856).
 */
export function useAdminSessionRenewal(tenantSlug: string): SessionRenewal {
  const refreshPath = useCallback(
    (returnTo: string): string => adminSessionRefreshPath(tenantSlug, returnTo),
    [tenantSlug],
  );

  return useSessionRenewal(refreshPath);
}
