import { copilotEnabled } from '@/lib/copilot/config';
import { copilotBasePath } from '@/lib/copilot/paths';
import type { CopilotSpace } from '@/lib/copilot/session';

import { CopilotLauncher } from './copilot-launcher';

/**
 * Le point de montage du chat dans un gabarit — P1-06.
 *
 * Décidé côté serveur : un copilot fermé (`copilotEnabled`) ne laisse aucune
 * trace dans la page, pas même le code du chat. Le panneau va au back-office,
 * la bulle au parcours public et à l'espace client (spécification EF-5).
 */
export function CopilotMount({ space, tenantSlug }: { readonly space: CopilotSpace; readonly tenantSlug: string }) {
  if (!copilotEnabled()) return null;
  return (
    <CopilotLauncher
      runtimeUrl={copilotBasePath(space, tenantSlug)}
      tenantSlug={tenantSlug}
      variant={space === 'admin' ? 'panneau' : 'bulle'}
    />
  );
}
