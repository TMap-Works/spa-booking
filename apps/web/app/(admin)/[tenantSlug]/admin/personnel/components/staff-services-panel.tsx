'use client';

import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';

import { assignStaffServiceAction, removeStaffServiceAction } from '../actions';

/**
 * Les prestations que ce praticien pratique (#53, quatrième critère).
 *
 * ## Le même lien, vu de l'autre bout
 *
 * L'API n'a qu'un sens pour cette relation : `POST /v1/services/{id}/staff` et
 * son `DELETE`. L'écran d'une prestation coche les praticiens (#52) ; celui-ci
 * coche les prestations. Ce sont deux vues d'une même table, et non deux
 * contrats : l'affectation posée ici apparaît immédiatement là-bas.
 *
 * ## Une affectation à la fois, dans les deux sens
 *
 * `setStaffServicesRequestSchema` — « voici la liste complète » — existe dans le
 * contrat partagé mais **n'est servie par aucune route**. Ce n'est pas une
 * limitation à contourner : envoyer la liste entière à chaque clic écraserait
 * l'affectation qu'une collègue vient d'ajouter depuis un autre poste. Un geste,
 * un appel.
 *
 * ## Une prestation désactivée reste affichée
 *
 * Elle porte son état, et l'affectation lui survit. La masquer ferait croire à
 * une affectation perdue et inviterait à la recréer — pour se heurter au conflit
 * d'unicité de `service_staff`.
 */

export interface StaffServiceChoice {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly assigned: boolean;
}

export function StaffServicesPanel({
  tenantSlug,
  staffId,
  services,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly staffId: string;
  readonly services: readonly StaffServiceChoice[];
  /**
   * `false` au rang praticien : `POST` et `DELETE /v1/services/:id/staff` sont
   * `@AuthAtLeast('MANAGER')`. La liste des affectations reste lisible, ses
   * bascules disparaissent.
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  async function toggle(service: StaffServiceChoice): Promise<void> {
    setPending(service.id);
    setFailure(null);

    const result = service.assigned
      ? await removeStaffServiceAction(tenantSlug, staffId, service.id)
      : await assignStaffServiceAction(tenantSlug, staffId, service.id);

    setPending(null);

    if (!result.ok) {
      // Un 409 n'est pas une panne : quelqu'un a posé la même affectation entre
      // le rendu de la page et le clic. On le dit, et le rafraîchissement remet
      // la liste d'aplomb.
      setFailure(
        result.code === ERROR_CODES.CONFLICT
          ? 'Cette prestation lui est déjà affectée.'
          : result.message,
      );
    }

    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="prestations-titre">
      <h2 className="spa-admin__section-title" id="prestations-titre">
        Prestations pratiquées
      </h2>
      <p className="spa-admin-toolbar__hint">
        Une prestation qu’aucun praticien ne pratique ne produit aucun créneau, quels que soient
        les horaires saisis.
      </p>

      {failure === null ? null : (
        <Notification tone="danger" title="Affectation impossible">
          <p>{failure}</p>
        </Notification>
      )}

      {services.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Catalogue vide</p>
          <p className="spa-empty-state__description">
            Créez au moins une prestation pour pouvoir l’affecter à ce praticien.
          </p>
        </div>
      ) : (
        <ul className="spa-admin__nav">
          {services.map((service) => (
            <li className="spa-admin-toolbar" key={service.id}>
              <span className="spa-admin-toolbar__caption">{service.name}</span>
              {service.isActive ? null : (
                <span className="spa-admin-badge spa-admin-badge--cancelled">Désactivée</span>
              )}
              {service.assigned ? (
                <span className="spa-admin-badge spa-admin-badge--confirmed">Affectée</span>
              ) : null}
              <span className="spa-admin-toolbar__spacer" />
              {canManage ? (
                <Button
                  disabled={refreshing}
                  loading={pending === service.id}
                  loadingLabel="Enregistrement…"
                  onClick={() => void toggle(service)}
                  variant={service.assigned ? 'quiet' : 'neutral'}
                >
                  {service.assigned ? 'Retirer' : 'Affecter'}
                  <span className="spa-visually-hidden"> {service.name}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
