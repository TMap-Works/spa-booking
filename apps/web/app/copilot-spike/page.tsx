import { notFound } from 'next/navigation';

import { SpikeChat } from '@/components/copilot/spike-chat';
import { copilotEnabled } from '@/lib/copilot/config';

/**
 * Banc d'essai du spike P1-01 (ADR 0018). Introuvable en production et sans
 * clé Anthropic, comme la route qu'il appelle ; disparaît quand l'interface du
 * chat (P1-06) prend place dans les vrais écrans.
 */

export const dynamic = 'force-dynamic';

export default function CopilotSpikePage() {
  if (!copilotEnabled()) notFound();
  return <SpikeChat />;
}
