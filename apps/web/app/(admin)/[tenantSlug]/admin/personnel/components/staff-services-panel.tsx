'use client';

import { ERROR_CODES } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';

import { assignStaffServiceAction, removeStaffServiceAction } from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';

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
  const t = useTranslations('admin-staff');
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
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
      if (renewIfExpired(result)) {
        return;
      }
      // Un 409 n'est pas une panne : quelqu'un a posé la même affectation entre
      // le rendu de la page et le clic. On le dit, et le rafraîchissement remet
      // la liste d'aplomb.
      setFailure(
        result.code === ERROR_CODES.CONFLICT ? t('services.conflict') : result.message,
      );
    }

    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="prestations-titre">
      <h2 className="spa-admin__section-title" id="prestations-titre">
        {t('services.title')}
      </h2>
      <p className="spa-admin-toolbar__hint">{t('services.hint')}</p>

      {failure === null ? null : (
        <Notification tone="danger" title={t('services.failureTitle')}>
          <p>{failure}</p>
        </Notification>
      )}

      {services.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">{t('services.emptyTitle')}</p>
          <p className="spa-empty-state__description">{t('services.emptyDescription')}</p>
        </div>
      ) : (
        <ul className="spa-admin__nav" role="list">
          {services.map((service) => (
            <li className="spa-admin-toolbar" key={service.id}>
              <span className="spa-admin-toolbar__caption">{service.name}</span>
              {service.isActive ? null : (
                <span className="spa-admin-badge spa-admin-badge--cancelled">
                  {t('services.disabled')}
                </span>
              )}
              {service.assigned ? (
                <span className="spa-admin-badge spa-admin-badge--confirmed">
                  {t('services.assigned')}
                </span>
              ) : null}
              <span className="spa-admin-toolbar__spacer" />
              {/* La bascule d'une ligne rend les autres inertes : `pending` est une
               * clé unique, et laisser les autres boutons cliquables ouvrait deux
               * appels concurrents — le premier à répondre remettait `pending` à
               * `null`, rendant le second bouton cliquable alors que sa requête
               * était toujours en vol : un second POST pour une seule intention,
               * donc un 409 sur un geste qu'on n'a demandé qu'une fois. La même
               * ligne qu'en face (#768) : les deux vues d'un même lien se
               * défendent de la même façon. */}
              {canManage ? (
                <Button
                  disabled={refreshing || (pending !== null && pending !== service.id)}
                  loading={pending === service.id}
                  loadingLabel={t('services.saving')}
                  onClick={() => void toggle(service)}
                  variant={service.assigned ? 'quiet' : 'neutral'}
                >
                  {service.assigned ? t('services.remove') : t('services.assign')}
                  <span className="spa-visually-hidden">
                    {t('services.forService', { name: service.name })}
                  </span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
