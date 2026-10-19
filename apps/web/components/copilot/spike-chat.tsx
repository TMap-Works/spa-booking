'use client';

import '@copilotkit/react-core/v2/styles.css';

import { CopilotKitProvider, CopilotSidebar, useAgentContext, useFrontendTool } from '@copilotkit/react-core/v2';
import { useState } from 'react';
import { z } from 'zod';

/**
 * Banc d'essai du spike P1-01 : le chat, et une liste que Claude filtre par un
 * outil du navigateur — l'écran change sous les yeux, sans navigateur piloté.
 * Les prestations sont fictives ; la vraie action (`reservation.ouvrir_tunnel`)
 * vient avec le registre (P1-02) et le spécialiste Réservation (P2-01).
 */
const PRESTATIONS = [
  { nom: 'Massage relaxant 60 min', famille: 'massage' },
  { nom: 'Massage aux pierres chaudes', famille: 'massage' },
  { nom: 'Soin du visage éclat', famille: 'visage' },
  { nom: 'Coupe et brushing', famille: 'coiffure' },
  { nom: 'Taille de barbe', famille: 'barbier' },
] as const;

const FAMILLES = ['massage', 'visage', 'coiffure', 'barbier'] as const;

export function SpikeChat() {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      <Banc />
      <CopilotSidebar defaultOpen labels={{ chatInputPlaceholder: 'Posez votre question…' }} />
    </CopilotKitProvider>
  );
}

function Banc() {
  const [famille, setFamille] = useState<(typeof FAMILLES)[number] | null>(null);

  useAgentContext({ description: 'Écran', value: 'Vitrine du salon (banc d’essai), liste des prestations' });
  useAgentContext({ description: 'Filtre actif', value: famille ?? 'aucun' });

  useFrontendTool(
    {
      name: 'filtrer_prestations',
      description: 'Filtre la liste des prestations affichée à l’écran par famille. « tout » retire le filtre.',
      parameters: z.object({ famille: z.enum([...FAMILLES, 'tout']) }).strict(),
      handler: async ({ famille: choix }) => {
        setFamille(choix === 'tout' ? null : choix);
        return choix === 'tout' ? 'Filtre retiré.' : `Liste filtrée sur « ${choix} ».`;
      },
    },
    [],
  );

  const visibles = PRESTATIONS.filter((p) => famille === null || p.famille === famille);

  return (
    <main style={{ padding: 24, maxWidth: 560 }}>
      <h1>Banc d’essai du copilot</h1>
      <p>Essayez : « je voudrais un massage », « et pour la barbe ? », « montre tout ».</p>
      <ul>
        {visibles.map((p) => (
          <li key={p.nom}>{p.nom}</li>
        ))}
      </ul>
    </main>
  );
}
