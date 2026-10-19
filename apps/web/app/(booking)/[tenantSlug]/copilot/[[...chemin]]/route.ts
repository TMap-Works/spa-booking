import { copilotRoute } from '@/lib/copilot/runtime';

/**
 * Le copilot du parcours public : sans cookie de session, la personne y est
 * toujours visiteuse. Voir `lib/copilot/runtime.ts`.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const serve = copilotRoute('public');

export { serve as GET, serve as POST };
