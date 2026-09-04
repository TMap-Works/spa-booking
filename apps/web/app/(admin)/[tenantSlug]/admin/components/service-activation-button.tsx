'use client';

import type { Service } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';

import { updateServiceAction } from '../catalogue/actions';

/**
 * Retire une prestation du catalogue, ou l'y remet (#52, premier critère).
 *
 * ## Pourquoi une bascule et non une suppression
 *
 * L'API n'expose aucun `DELETE` sur une prestation, et ce n'est pas un oubli :
 * les rendez-vous passés la référencent, le reporting doit continuer à savoir ce
 * qui a été vendu, et la clé étrangère `Restrict` d'`appointments.service_id`
 * refuserait de toute façon l'effacement. Une prestation retirée disparaît du
 * catalogue public et reste dans l'historique.
 *
 * ## Pourquoi la charge utile ne porte que `isActive`
 *
 * `PATCH` est partiel. N'envoyer que le champ qu'on change, c'est ne pas
 * réécrire le prix ni la durée avec les valeurs qu'affichait la page — donc ne
 * pas écraser ce qu'un collègue vient de modifier depuis un autre poste.
 *
 * ## Ce que la désactivation ne demande pas
 *
 * Aucune confirmation : le geste est **réversible d'un clic**, immédiatement, par
 * le même bouton. Une boîte de dialogue pour une action annulable ne protège de
 * rien et se clique sans être lue.
 *
 * ## Pourquoi `useTransition` autour du rafraîchissement
 *
 * `router.refresh()` **ne remonte pas** ce composant : l'App Router réconcilie
 * la ligne en place, et l'état local lui survit. Un `pending` posé avant l'appel
 * et jamais rendu resterait donc à `true` pour toujours — le bouton s'afficherait
 * « Mise à jour… », désactivé, et il faudrait recharger la page à la main pour
 * pouvoir rebasculer. La transition rend cette attente observable : `isPending`
 * retombe de lui-même quand le rendu serveur est arrivé, et le bouton reste
 * inerte pendant tout l'aller-retour — pas une milliseconde de plus, pas une de
 * moins.
 */
export function ServiceActivationButton({
  tenantSlug,
  service,
}: {
  readonly tenantSlug: string;
  readonly service: Service;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setSaving(true);
    setFailure(null);

    const result = await updateServiceAction(tenantSlug, service.id, {
      isActive: !service.isActive,
    });

    if (!result.ok) {
      setFailure(result.message);
      setSaving(false);
      return;
    }

    startRefresh(() => {
      router.refresh();
    });
    setSaving(false);
  }

  return (
    <>
      <Button
        variant={service.isActive ? 'quiet' : 'neutral'}
        loading={saving || refreshing}
        loadingLabel="Mise à jour…"
        onClick={() => void toggle()}
      >
        {service.isActive ? 'Désactiver' : 'Réactiver'}
        <span className="spa-visually-hidden"> {service.name}</span>
      </Button>
      {failure === null ? null : (
        <p className="spa-field__error" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}
