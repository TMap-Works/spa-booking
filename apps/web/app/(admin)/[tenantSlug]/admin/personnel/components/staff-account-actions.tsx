'use client';

import { STAFF_ROLES, type StaffRole } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';
import { type StaffAccount } from '@/lib/admin/staff-contract';

import { roleLabel } from '../../components/navigation';
import {
  changeStaffAccountRoleAction,
  reissueStaffInvitationAction,
  setStaffAccountStatusAction,
} from '../actions';

/**
 * Ce qu'on fait d'un compte du personnel depuis la liste (#53, premier critère).
 *
 * ## Trois gestes, trois décisions distinctes
 *
 * Changer un rôle distribue des droits ; désactiver ferme un accès ; réémettre
 * une invitation dépanne un compte jamais activé. Les trois sont réservés aux
 * administrateurs côté API, et l'écran ne les propose qu'à eux — non pour
 * protéger quoi que ce soit (la garde de l'API est la seule qui compte) mais
 * pour ne pas offrir des boutons qui répondraient 403.
 *
 * ## Personne ne se désactive soi-même
 *
 * L'API répond 422 quand l'appelant se vise lui-même — le dernier administrateur
 * d'un salon qui se ferme l'accès ferme la porte de l'intérieur. Le bouton est
 * donc absent sur sa propre ligne plutôt que présent et refusé.
 *
 * ## L'état d'activation n'est pas dans la liste, et l'écran ne l'invente pas
 *
 * `GET /v1/users` rend `UserProfileDto`, qui ne porte pas `isActive` : seule la
 * réponse de `PATCH /v1/users/:id/status` le dit. Tant que rien n'a été fait sur
 * une ligne, le composant ne prétend donc **rien** savoir — il propose la
 * désactivation, le geste courant, et n'affiche d'état qu'une fois qu'il en a
 * reçu un. Deviner « actif » et peindre une pastille verte serait affirmer sur
 * un écran d'administration une chose que l'API n'a pas dite. Une issue de suivi
 * porte l'ajout du champ à la liste.
 */

export function StaffAccountActions({
  tenantSlug,
  account,
  isSelf,
}: {
  readonly tenantSlug: string;
  readonly account: StaffAccount;
  readonly isSelf: boolean;
}) {
  const router = useRouter();
  const [role, setRole] = useState<StaffRole>(
    // La liste ne rend que le personnel ; un rôle hors des trois internes ne
    // devrait pas s'y trouver, et le repli évite un `<select>` sans valeur.
    (STAFF_ROLES as readonly string[]).includes(account.role) ? (account.role as StaffRole) : 'staff',
  );
  const [active, setActive] = useState<boolean | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);
  /**
   * Le jeton d'une invitation réémise, tenu à part du message.
   *
   * Il fait trois cents caractères d'un seul tenant : glissé dans une phrase, il
   * pousse la ligne du tableau — donc la page — en défilement horizontal. Un
   * champ en lecture seule le borne à sa propre boîte, et se sélectionne d'un
   * raccourci, ce qu'on vient précisément faire ici.
   */
  const [invitationToken, setInvitationToken] = useState<string | null>(null);

  const roleChanged = role !== account.role;

  async function applyRole(): Promise<void> {
    setPending('role');
    setNotice(null);

    const result = await changeStaffAccountRoleAction(tenantSlug, account.id, { role });

    setPending(null);

    if (!result.ok) {
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setNotice({ tone: 'success', message: `Rôle enregistré : ${roleLabel(result.data.role)}.` });
    startRefresh(() => {
      router.refresh();
    });
  }

  async function toggleStatus(): Promise<void> {
    const next = active === null ? false : !active;

    setPending('status');
    setNotice(null);

    const result = await setStaffAccountStatusAction(tenantSlug, account.id, { isActive: next });

    setPending(null);

    if (!result.ok) {
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setActive(result.data.isActive);
    setNotice({
      tone: 'success',
      message: result.data.isActive
        ? 'Compte réactivé : la connexion est de nouveau possible.'
        : 'Compte désactivé. Ses affectations et ses rendez-vous passés sont intacts.',
    });
    startRefresh(() => {
      router.refresh();
    });
  }

  async function reissue(): Promise<void> {
    setPending('invitation');
    setNotice(null);
    setInvitationToken(null);

    const result = await reissueStaffInvitationAction(tenantSlug, account.id);

    setPending(null);

    if (!result.ok) {
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setInvitationToken(result.data.invitationToken);
    setNotice({
      tone: 'success',
      message: `Nouveau jeton d’invitation à transmettre à ${account.email}.`,
    });
  }

  return (
    <div className="spa-admin-toolbar">
      <Select
        id={`role-${account.id}`}
        label="Rôle"
        onChange={(event) => setRole(event.target.value as StaffRole)}
        value={role}
      >
        {STAFF_ROLES.map((value) => (
          <option key={value} value={value}>
            {roleLabel(value)}
          </option>
        ))}
      </Select>

      <Button
        disabled={!roleChanged || refreshing}
        loading={pending === 'role'}
        loadingLabel="Enregistrement…"
        onClick={() => void applyRole()}
        variant="neutral"
      >
        Appliquer
        <span className="spa-visually-hidden">
          {' '}
          le rôle de {account.firstName} {account.lastName}
        </span>
      </Button>

      {isSelf ? (
        <span className="spa-admin-toolbar__hint">Votre propre compte</span>
      ) : (
        <Button
          disabled={refreshing}
          loading={pending === 'status'}
          loadingLabel="Enregistrement…"
          onClick={() => void toggleStatus()}
          variant={active === false ? 'neutral' : 'quiet'}
        >
          {active === false ? 'Réactiver' : 'Désactiver'}
          <span className="spa-visually-hidden">
            {' '}
            le compte de {account.firstName} {account.lastName}
          </span>
        </Button>
      )}

      <Button
        disabled={refreshing}
        loading={pending === 'invitation'}
        loadingLabel="Émission…"
        onClick={() => void reissue()}
        variant="quiet"
      >
        Réémettre l’invitation
        <span className="spa-visually-hidden">
          {' '}
          de {account.firstName} {account.lastName}
        </span>
      </Button>

      {notice === null ? null : (
        <Notification
          title={notice.tone === 'success' ? 'Compte mis à jour' : 'Modification impossible'}
          tone={notice.tone}
        >
          <p>{notice.message}</p>
          {invitationToken === null ? null : (
            <Field
              id={`invitation-${account.id}`}
              label="Jeton d’invitation"
              readOnly
              value={invitationToken}
            />
          )}
        </Notification>
      )}
    </div>
  );
}
