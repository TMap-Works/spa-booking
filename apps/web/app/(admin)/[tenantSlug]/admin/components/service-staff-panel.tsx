'use client';

import { ERROR_CODES, type ServiceStaffMember, type StaffMemberSummary } from '@spa/shared';
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
 * De ce que le catalogue publie : l'API du back-office n'expose à ce jour aucun
 * point d'entrée « tous les praticiens de l'établissement » — `GET /v1/users`
 * rend des **comptes**, dont l'identifiant n'est pas celui d'une fiche
 * praticien, et l'affectation attend le second. La page compose donc les
 * candidats à partir des fiches déjà citées par le catalogue. Conséquence
 * assumée et écrite sur l'écran : un praticien qui ne pratique encore aucune
 * prestation n'y apparaît pas. Le point d'entrée manquant fait l'objet d'une
 * issue de suivi ; l'inventer côté front reviendrait à deviner un contrat.
 */
/**
 * Pourquoi la liste de choix est vide — les deux cas ne sont pas le même écran.
 *
 * « Tous déjà affectés » est une bonne nouvelle : il n'y a rien à faire.
 * « Aucune fiche connue » est un état de démarrage dont on ne sort pas depuis
 * cet écran, et le taire laisserait une gérante cliquer sur un sélecteur muet en
 * cherchant ce qu'elle a mal fait. Rendu `undefined` quand il y a des candidats :
 * `Select` réserve `emptyLabel` à la liste chargée **et** vide.
 */
function emptyChoiceLabel(assignedCount: number, candidateCount: number): string | undefined {
  if (candidateCount > 0) {
    return undefined;
  }

  return assignedCount === 0
    ? 'Aucune fiche praticien n’est encore rattachée au catalogue de ce salon. Affectez d’abord un praticien depuis sa fiche, ou créez-en une.'
    : 'Tous les praticiens connus du catalogue pratiquent déjà cette prestation.';
}

export function ServiceStaffPanel({
  tenantSlug,
  serviceId,
  assigned,
  candidates,
}: {
  readonly tenantSlug: string;
  readonly serviceId: string;
  readonly assigned: readonly ServiceStaffMember[];
  /** Praticiens connus du catalogue, déjà privés de ceux qui sont affectés. */
  readonly candidates: readonly StaffMemberSummary[];
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
            </li>
          ))}
        </ul>
      )}

      <Select
        id="service-staff-candidate"
        label="Ajouter un praticien"
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        hint="Praticiens connus du catalogue. Un praticien qui ne pratique encore aucune prestation n’apparaît pas ici."
        emptyLabel={emptyChoiceLabel(assigned.length, candidates.length)}
      >
        <option value="">Choisir un praticien…</option>
        {candidates.map((member) => (
          <option key={member.id} value={member.id}>
            {member.displayName}
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
    </section>
  );
}
