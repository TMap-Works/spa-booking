import { copilotRoute } from '@/lib/copilot/runtime';

import { accountActionAccess } from '../../session';

/**
 * Le copilot de l'espace client — sous `/{salon}/compte/` pour que le cookie de
 * session, posé sur ce chemin, l'accompagne. Voir `lib/copilot/runtime.ts`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const serve = copilotRoute('compte', accountActionAccess);

export { serve as GET, serve as POST };
