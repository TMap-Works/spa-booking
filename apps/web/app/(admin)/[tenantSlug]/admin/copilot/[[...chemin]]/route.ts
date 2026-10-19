import { accessTokenForAction } from '@/lib/session-refresh';
import { copilotRoute } from '@/lib/copilot/runtime';

import { readAdminAccessToken, readAdminRefreshToken, writeAdminSession } from '../../session';

/**
 * Le copilot du back-office — sous `/{salon}/admin/` pour que le cookie de
 * session, posé sur ce chemin, l'accompagne. Le jeton est renouvelé sur place
 * quand il a expiré, comme pour une action serveur. Voir
 * `lib/copilot/runtime.ts`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const serve = copilotRoute('admin', (tenantSlug) =>
  accessTokenForAction({
    readAccessToken: readAdminAccessToken,
    readRefreshToken: readAdminRefreshToken,
    write: (renewed) => writeAdminSession(tenantSlug, renewed),
  }),
);

export { serve as GET, serve as POST };
