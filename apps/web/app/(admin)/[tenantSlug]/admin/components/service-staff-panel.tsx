'use client';

import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';

import { assignServiceStaffAction, removeServiceStaffAction } from '../catalogue/actions';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

/**
 * Qui pratique cette prestation (#52, quatrième critère).
 *
 * ## Un seul geste pour les deux faces du même lien (#768)
 *
 * Le CDC §2.4 ne décrit qu'une relation, « Service — N–N vers Staff ». Cette
 * fiche et celle du praticien en sont deux vues, et elles l'éditaient avec deux
 * gestes : ici on choisissait dans un `<select>` qui ne listait que les non
 * affectés, puis on validait par un bouton accentué ; là-bas on basculait la
 * ligne. Deux modèles mentaux, deux styles de bouton, deux emplacements pour un
 * seul lien.
 *
 * C'est la bascule par ligne qui a été retenue, et ce panneau reprend donc, au
 * balisage près, celui de `StaffServicesPanel` : l'établissement entier est
 * listé, chaque ligne porte soit un bouton neutre « Affecter », soit le badge
 * « Affecté » et un bouton discret « Retirer ». Un clic suffit, dans les deux
 * sens, et il n'y a plus d'état intermédiaire — le choix n'attend plus une
 * seconde action pour exister.
 *
 * ## La liste complète tient parce qu'elle est en bas de page
 *
 * Lister tout le personnel allonge la page là où le sélecteur l'aplatissait.
 * C'est le point que la fiche praticien avait déjà réglé, et de la même façon :
 * le panneau ne vit pas dans la colonne de 22 rem d'un `.spa-admin__split`, il
 * est la **dernière** section d'une pile pleine largeur. Rien ne se trouve
 * poussé plus bas par sa longueur, et chaque ligne dispose de la mesure entière.
 * La page de la prestation s'empile donc elle aussi (voir `[serviceId]/page.tsx`).
 *
 * ## Un praticien à la fois, dans les deux sens
 *
 * L'API offre `POST …/staff` (un praticien) et `DELETE …/staff/{staffId}`,
 * plutôt qu'un remplacement en bloc de la liste. Ce n'est pas une limitation à
 * contourner : envoyer la liste complète à chaque clic écraserait, à chaque
 * enregistrement, l'affectation qu'un collègue vient d'ajouter depuis un autre
 * poste. L'écran suit donc le contrat — un geste, un appel.
 *
 * ## Les fiches désactivées restent listées, affectées ou non
 *
 * `serviceStaffMemberSchema` porte `isActive`, et c'est l'API qui les renvoie.
 * Masquer une fiche suspendue déjà affectée ferait croire à une affectation
 * perdue et inviterait à la recréer — pour se heurter au conflit d'unicité de
 * `service_staff`. Masquer une fiche suspendue non affectée la rendrait
 * introuvable depuis l'écran où l'on vient justement la retrouver, alors que
 * l'API accepte de l'affecter. La ligne dit donc l'état, et les deux gestes
 * restent possibles.
 *
 * ## D'où vient la liste
 *
 * De `GET /v1/staff` — l'annuaire des fiches praticien de l'établissement, dont
 * l'identifiant est bien celui qu'attend l'affectation (`GET /v1/users`, lui,
 * rend des **comptes**, et son identifiant n'irait nulle part ici). Ce n'est
 * plus le catalogue public qui la compose : il ne citait que les fiches **déjà
 * affectées** à une prestation active, et un salon qui démarre n'y trouvait donc
 * aucun candidat pour sa toute première affectation (#455).
 *
 * ## Ce que le rang praticien en voit
 *
 * Qui pratique la prestation, et rien de plus : `POST` et
 * `DELETE /v1/services/{id}/staff` sont `@AuthAtLeast('MANAGER')`. Les bascules
 * disparaissent pour ce rôle, une mention dit pourquoi, et la liste reste
 * lisible — c'est une information dont une praticienne se sert (#619).
 */

/**
 * Une fiche praticien de l'établissement, et son état vis-à-vis de cette
 * prestation. Le miroir exact de `StaffServiceChoice`, de l'autre côté du lien.
 */
export interface ServiceStaffChoice {
  readonly id: string;
  readonly displayName: string;
  readonly isActive: boolean;
  readonly assigned: boolean;
}

export function ServiceStaffPanel({
  tenantSlug,
  serviceId,
  staff,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly serviceId: string;
  /**
   * Tout le personnel de l'établissement — affecté ou non —, déjà ordonné par la
   * page (`sortStaffMembers`) : actifs d'abord, puis par nom en français.
   */
  readonly staff: readonly ServiceStaffChoice[];
  /**
   * `false` au rang praticien : l'affectation et le retrait sont tous deux
   * `@AuthAtLeast('MANAGER')`. La liste reste affichée, ses bascules
   * disparaissent.
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [pending, setPending] = useState<string | null>(null);
  // `router.refresh()` ne remonte pas ce composant : la transition est ce qui
  // rend l'aller-retour observable, et ce qui garde les bascules inertes jusqu'à
  // ce que la liste rendue par le serveur soit arrivée. Sans elle, un second
  // clic partirait sur une liste déjà périmée — et se heurterait au 409.
  const [refreshing, startRefresh] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  async function toggle(member: ServiceStaffChoice): Promise<void> {
    setPending(member.id);
    setFailure(null);

    const result = member.assigned
      ? await removeServiceStaffAction(tenantSlug, serviceId, member.id)
      : await assignServiceStaffAction(tenantSlug, serviceId, { staffId: member.id });

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      // Un 409 n'est pas une panne : quelqu'un a posé la même affectation entre
      // le rendu de la page et le clic. On le dit, et le rafraîchissement remet
      // la liste d'aplomb.
      setFailure(
        result.code === ERROR_CODES.CONFLICT
          ? 'Ce praticien est déjà affecté à cette prestation.'
          : result.message,
      );
    }

    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="prestation-praticiens">
      <h2 className="spa-admin__section-title" id="prestation-praticiens">
        Praticiens
      </h2>
      <p className="spa-admin-toolbar__hint">
        Tant qu’aucun praticien ne pratique cette prestation, le moteur de disponibilité ne
        proposera aucun créneau pour elle.
      </p>

      {failure === null ? null : (
        <Notification tone="danger" title="Affectation impossible">
          <p>{failure}</p>
        </Notification>
      )}

      {staff.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Aucune fiche praticien</p>
          <p className="spa-empty-state__description">
            Créez au moins une fiche praticien pour pouvoir l’affecter à cette prestation.
          </p>
        </div>
      ) : (
        <ul className="spa-admin__nav" role="list">
          {staff.map((member) => (
            <li className="spa-admin-toolbar" key={member.id}>
              <span className="spa-admin-toolbar__caption">{member.displayName}</span>
              {member.isActive ? null : (
                <span className="spa-admin-badge spa-admin-badge--cancelled">
                  Compte désactivé
                </span>
              )}
              {member.assigned ? (
                <span className="spa-admin-badge spa-admin-badge--confirmed">Affecté</span>
              ) : null}
              <span className="spa-admin-toolbar__spacer" />
              {/* La bascule d'une ligne rend les autres inertes : `pending` est une
               * clé unique, et laisser les autres boutons cliquables ouvrait deux
               * appels concurrents — le premier à répondre remettait `pending` à
               * `null`, rendant le second bouton cliquable alors que sa requête
               * était toujours en vol : un second POST pour une seule intention,
               * donc un 409 sur un geste qu'on n'a demandé qu'une fois. */}
              {canManage ? (
                <Button
                  disabled={refreshing || (pending !== null && pending !== member.id)}
                  loading={pending === member.id}
                  loadingLabel="Enregistrement…"
                  onClick={() => void toggle(member)}
                  variant={member.assigned ? 'quiet' : 'neutral'}
                >
                  {member.assigned ? 'Retirer' : 'Affecter'}
                  <span className="spa-visually-hidden"> {member.displayName}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? null : (
        <p className="spa-admin-toolbar__hint">
          L’affectation des praticiens est réservée au rang gérant.
        </p>
      )}
    </section>
  );
}
