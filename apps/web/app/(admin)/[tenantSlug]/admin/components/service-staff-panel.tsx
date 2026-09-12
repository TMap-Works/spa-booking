'use client';

import { ERROR_CODES, type ServiceStaffMember, type StaffMember } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';

import { assignServiceStaffAction, removeServiceStaffAction } from '../catalogue/actions';

/**
 * Qui pratique cette prestation (#52, quatrième critère).
 *
 * ## Un praticien à la fois, dans les deux sens
 *
 * L'API offre `POST …/staff` (un praticien) et `DELETE …/staff/{staffId}`,
 * plutôt qu'un remplacement en bloc de la liste. Ce n'est pas une limitation à
 * contourner : envoyer la liste complète à chaque clic écraserait, à chaque
 * enregistrement, l'affectation qu'un collègue vient d'ajouter depuis un autre
 * poste. L'écran suit donc le contrat — un geste, un appel.
 *
 * ## Les praticiens désactivés restent listés
 *
 * `serviceStaffMemberSchema` porte `isActive`, et c'est l'API qui les renvoie.
 * Les masquer ferait croire à une affectation perdue et inviterait à la
 * recréer — pour se heurter au conflit d'unicité de `service_staff`. La ligne
 * dit donc l'état, et le retrait reste possible.
 *
 * ## D'où vient la liste des praticiens qu'on peut ajouter
 *
 * De `GET /v1/staff` — l'annuaire des fiches praticien de l'établissement, dont
 * l'identifiant est bien celui qu'attend l'affectation (`GET /v1/users`, lui,
 * rend des **comptes**, et son identifiant n'irait nulle part ici). La page
 * retire de cette liste les praticiens déjà affectés et passe le reste.
 *
 * Ce n'est plus le catalogue public qui la compose : il ne citait que les fiches
 * **déjà affectées** à une prestation active, et un salon qui démarre n'y
 * trouvait donc aucun candidat pour sa toute première affectation (#455).
 *
 * ## Les fiches désactivées sont proposées, en le disant
 *
 * L'API accepte de les affecter, et le back-office est l'écran où l'on vient
 * retrouver une praticienne suspendue. Les masquer les rendrait introuvables
 * ici ; les proposer sans rien dire ferait créer une affectation dont le moteur
 * de disponibilité ne tirera aucun créneau. L'option porte donc la mention.
 *
 * ## Ce que le rang praticien en voit
 *
 * Qui pratique la prestation, et rien de plus : `POST` et
 * `DELETE /v1/services/{id}/staff` sont `@AuthAtLeast('MANAGER')`. Le sélecteur
 * et les deux boutons disparaissent pour ce rôle, une mention dit pourquoi, et la
 * liste reste lisible — c'est une information dont une praticienne se sert
 * (#619).
 */
/**
 * Pourquoi la liste de choix est vide — les deux cas ne sont pas le même écran.
 *
 * « Tous déjà affectés » est une bonne nouvelle : il n'y a rien à faire.
 * « Aucune fiche dans l'établissement » est un état de démarrage dont on ne sort
 * pas depuis cet écran, et le taire laisserait une gérante cliquer sur un
 * sélecteur muet en cherchant ce qu'elle a mal fait. Rendu `undefined` quand il y
 * a des candidats : `Select` réserve `emptyLabel` à la liste chargée **et** vide.
 *
 * Les deux messages décrivent maintenant l'état réel de l'établissement, et non
 * plus l'ancienne composition depuis le catalogue : la liste est celle des
 * fiches du salon, la seconde branche veut donc bien dire qu'il n'y en a aucune.
 */
function emptyChoiceLabel(assignedCount: number, candidateCount: number): string | undefined {
  if (candidateCount > 0) {
    return undefined;
  }

  return assignedCount === 0
    ? 'Aucune fiche praticien dans cet établissement — il n’y a personne à affecter. La création d’une fiche n’est pas encore servie par l’API.'
    : 'Tous les praticiens de l’établissement pratiquent déjà cette prestation.';
}

export function ServiceStaffPanel({
  tenantSlug,
  serviceId,
  assigned,
  candidates,
  canManage = true,
}: {
  readonly tenantSlug: string;
  readonly serviceId: string;
  readonly assigned: readonly ServiceStaffMember[];
  /**
   * Les fiches praticien de l'établissement, déjà privées de celles qui sont
   * affectées — et déjà ordonnées par la page (`sortStaffMembers`) : actives
   * d'abord, puis par nom en français.
   */
  readonly candidates: readonly StaffMember[];
  /**
   * `false` au rang praticien : l'affectation et le retrait sont tous deux
   * `@AuthAtLeast('MANAGER')`. La liste des affectés reste affichée, ses
   * commandes disparaissent.
   */
  readonly canManage?: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  // `router.refresh()` ne remonte pas ce composant : la transition est ce qui
  // rend l'aller-retour observable, et ce qui garde les boutons inertes jusqu'à
  // ce que la liste rendue par le serveur soit arrivée. Sans elle, un second
  // clic partirait sur une liste déjà périmée — et se heurterait au 409.
  const [refreshing, startRefresh] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  async function assign(): Promise<void> {
    if (choice === '') {
      setFailure('Choisissez un praticien à affecter.');
      return;
    }

    setPending('assign');
    setFailure(null);

    const result = await assignServiceStaffAction(tenantSlug, serviceId, { staffId: choice });

    if (!result.ok) {
      // Un 409 n'est pas une panne : quelqu'un a affecté ce praticien entre le
      // rendu de la page et le clic. On le dit, et le rafraîchissement remet la
      // liste d'aplomb.
      setFailure(
        result.code === ERROR_CODES.CONFLICT
          ? 'Ce praticien est déjà affecté à cette prestation.'
          : result.message,
      );
      setPending(null);
      startRefresh(() => {
        router.refresh();
      });
      return;
    }

    setChoice('');
    setPending(null);
    startRefresh(() => {
      router.refresh();
    });
  }

  async function remove(staffId: string): Promise<void> {
    setPending(staffId);
    setFailure(null);

    const result = await removeServiceStaffAction(tenantSlug, serviceId, staffId);

    if (!result.ok) {
      setFailure(result.message);
      setPending(null);
      return;
    }

    setPending(null);
    startRefresh(() => {
      router.refresh();
    });
  }

  return (
    <section className="spa-admin__section" aria-labelledby="prestation-praticiens">
      <h2 className="spa-admin__section-title" id="prestation-praticiens">
        Praticiens
      </h2>

      {failure === null ? null : (
        <Notification tone="danger" title="Affectation impossible">
          <p>{failure}</p>
        </Notification>
      )}

      {assigned.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Aucun praticien affecté</p>
          <p className="spa-empty-state__description">
            Tant qu’aucun praticien ne pratique cette prestation, le moteur de disponibilité ne
            proposera aucun créneau pour elle.
          </p>
        </div>
      ) : (
        <ul className="spa-admin__nav">
          {assigned.map((member) => (
            <li className="spa-admin-toolbar" key={member.id}>
              <span className="spa-admin-toolbar__caption">{member.displayName}</span>
              {member.isActive ? null : (
                <span className="spa-admin-badge spa-admin-badge--cancelled">
                  Compte désactivé
                </span>
              )}
              <span className="spa-admin-toolbar__spacer" />
              {canManage ? (
                <Button
                  variant="quiet"
                  loading={pending === member.id}
                  disabled={refreshing}
                  loadingLabel="Retrait…"
                  onClick={() => void remove(member.id)}
                >
                  Retirer
                  <span className="spa-visually-hidden"> {member.displayName}</span>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <>
          <Select
            id="service-staff-candidate"
            label="Ajouter un praticien"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            hint="Toutes les fiches praticien de l’établissement, celles qui pratiquent déjà cette prestation en moins."
            emptyLabel={emptyChoiceLabel(assigned.length, candidates.length)}
          >
            <option value="">Choisir un praticien…</option>
            {candidates.map((member) => (
              <option key={member.id} value={member.id}>
                {member.isActive ? member.displayName : `${member.displayName} (désactivé)`}
              </option>
            ))}
          </Select>

          <Button
            variant="accent"
            disabled={candidates.length === 0 || refreshing}
            loading={pending === 'assign'}
            loadingLabel="Affectation…"
            onClick={() => void assign()}
          >
            Affecter
          </Button>
        </>
      ) : (
        <p className="spa-admin-toolbar__hint">
          L’affectation des praticiens est réservée au rang gérant.
        </p>
      )}
    </section>
  );
}
