import type { ReactNode } from 'react';

import { CopilotMount } from '@/components/copilot/copilot-mount';

/**
 * Le gabarit commun du parcours public d'un salon — vitrine, tunnel, politique
 * de données. Il n'ajoute rien à l'écran que le copilot (ADR 0018), en bulle :
 * c'est là que la visiteuse réserve, la priorité 1 du chat.
 */
export default async function PublicSalonLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;
  return (
    <>
      {children}
      <CopilotMount space="public" tenantSlug={tenantSlug} />
    </>
  );
}
