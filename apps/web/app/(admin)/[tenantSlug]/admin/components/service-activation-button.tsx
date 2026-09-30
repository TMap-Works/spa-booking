'use client';

import type { Locale, Service } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { refusalMessage, type Refusal } from '@/lib/refusal';

import { updateServiceAction } from '../catalogue/actions';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

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
 *
 * ## Le refus est gardé par son code, jamais par sa phrase (#1354)
 *
 * Pour la raison même qui fait employer `useTransition` ci-dessus : ce composant
 * **n'est pas démonté** quand la route se rejoue. Le sélecteur de langue du rail
 * pose un cookie et laisse Next rendre à nouveau sans navigation
 * (`i18n/actions.ts`), si bien qu'une phrase rangée en état restait écrite dans la
 * langue d'avant, sous des boutons qui, eux, suivaient le rendu. Ce qui va en état
 * est donc le **code** du refus, et `refusalMessage` en écrit la phrase au rendu —
 * voir `lib/refusal.ts`.
 */
export function ServiceActivationButton({
  tenantSlug,
  service,
}: {
  readonly tenantSlug: string;
  readonly service: Service;
}) {
  const t = useTranslations('admin-catalog');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  /** Le **code** du refus, pas sa phrase (#1354) — voir l'en-tête. */
  const [failure, setFailure] = useState<Refusal | null>(null);

  async function toggle(): Promise<void> {
    setSaving(true);
    setFailure(null);

    const result = await updateServiceAction(tenantSlug, service.id, {
      isActive: !service.isActive,
    });

    if (!result.ok) {
      if (renewIfExpired(result)) {
        setSaving(false);
        return;
      }
      setFailure({ code: result.code });
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
        loadingLabel={t('activation.updating')}
        onClick={() => void toggle()}
      >
        {service.isActive ? t('activation.deactivate') : t('activation.reactivate')}
        {/* Le nom de la prestation n'est **pas** traduit : c'est la saisie du
            salon, et c'est ce qui distingue les vingt boutons « Désactiver »
            d'une liste pour un lecteur d'écran. */}
        <span className="spa-visually-hidden"> {service.name}</span>
      </Button>
      {failure === null ? null : (
        <p className="spa-field__error" role="alert">
          {/* La phrase est écrite ici, dans la langue de ce rendu (#1354). */}
          {refusalMessage(failure, locale)}
        </p>
      )}
    </>
  );
}
