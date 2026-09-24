'use client';

import { STAFF_ROLES, type StaffAccountState, type StaffRole } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { Select } from '@/components/ui/select';

import { roleLabel } from '../../components/navigation';
import { adminInvitationPath } from '../../invitation/paths';
import {
  changeStaffAccountRoleAction,
  reissueStaffInvitationAction,
  setStaffAccountStatusAction,
} from '../actions';
import { useAdminSessionRenewal } from '../../components/use-admin-session-renewal';
import { InvitationLink } from './invitation-link';

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
 * ## L'état d'activation vient de l'API, et le bouton en découle
 *
 * `GET /v1/users` rend `isActive` depuis #695 : l'état de départ est celui du
 * compte reçu, et non plus un `null` qui ne savait rien. C'était la cause côté
 * front du défaut relevé — après un rechargement, une ligne désactivée
 * reproposait « Désactiver », et une gérante n'avait aucun moyen de voir quels
 * comptes étaient fermés ni d'en rouvrir un autrement qu'à l'aveugle.
 *
 * L'état local survit ensuite à l'appel de statut, le temps que
 * `router.refresh()` rapporte la liste relue : sans lui, le bouton reviendrait à
 * son libellé d'avant pendant la revalidation.
 */

export function StaffAccountActions({
  tenantSlug,
  account,
  isSelf,
}: {
  readonly tenantSlug: string;
  readonly account: StaffAccountState;
  readonly isSelf: boolean;
}) {
  const t = useTranslations('admin-staff');
  const locale = useLocale();
  const router = useRouter();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [role, setRole] = useState<StaffRole>(
    // La liste ne rend que le personnel ; un rôle hors des trois internes ne
    // devrait pas s'y trouver, et le repli évite un `<select>` sans valeur.
    (STAFF_ROLES as readonly string[]).includes(account.role) ? (account.role as StaffRole) : 'staff',
  );
  // L'état de départ est celui que l'API rend (#695), et la liste relue reste la
  // source de vérité : `knownActive` retient ce que le dernier rendu serveur
  // disait, si bien qu'un `router.refresh()` — ou la modification faite depuis un
  // autre poste — reprend la main sur l'état local au lieu de le laisser figé.
  // Ce dernier ne sert qu'à tenir le libellé juste entre la réponse de l'API et
  // la fin de la revalidation.
  const [active, setActive] = useState(account.isActive);
  const [knownActive, setKnownActive] = useState(account.isActive);
  if (knownActive !== account.isActive) {
    setKnownActive(account.isActive);
    setActive(account.isActive);
  }
  const [pending, setPending] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; message: string } | null>(null);
  /**
   * Le **lien** d'une invitation réémise, tenu à part du message.
   *
   * Il fait plus de trois cents caractères d'un seul tenant : glissé dans une
   * phrase, il pousse la ligne du tableau — donc la page — en défilement
   * horizontal. `InvitationLink` le borne à sa propre boîte et lui donne le
   * bouton qui le copie.
   *
   * Le lien et non le jeton depuis #1143 : le jeton nu ne s'employait nulle
   * part, la page d'activation n'acceptant qu'une adresse.
   */
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null);

  const roleChanged = role !== account.role;

  async function applyRole(): Promise<void> {
    setPending('role');
    setNotice(null);
    // Le lien d'une invitation réémise plus tôt est rendu **dans** ce bandeau :
    // le laisser en place l'aurait fait réapparaître sous « Rôle enregistré »,
    // où rien ne dit plus de quoi il est le lien.
    setInvitationUrl(null);

    const result = await changeStaffAccountRoleAction(tenantSlug, account.id, { role });

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setNotice({
      tone: 'success',
      message: t('accountActions.roleSaved', { role: roleLabel(result.data.role, locale) }),
    });
    startRefresh(() => {
      router.refresh();
    });
  }

  async function toggleStatus(): Promise<void> {
    const next = !active;

    setPending('status');
    setNotice(null);
    setInvitationUrl(null);

    const result = await setStaffAccountStatusAction(tenantSlug, account.id, { isActive: next });

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    setActive(result.data.isActive);
    setNotice({
      tone: 'success',
      message: result.data.isActive
        ? t('accountActions.reactivated')
        : t('accountActions.deactivated'),
    });
    startRefresh(() => {
      router.refresh();
    });
  }

  async function reissue(): Promise<void> {
    setPending('invitation');
    setNotice(null);
    setInvitationUrl(null);

    const result = await reissueStaffInvitationAction(tenantSlug, account.id);

    setPending(null);

    if (!result.ok) {
      if (renewIfExpired(result)) {
        return;
      }
      setNotice({ tone: 'danger', message: result.message });
      return;
    }

    // L'origine est lue de `window.location` et non d'`APP_URL` : l'écran tourne
    // dans le navigateur de l'administrateur, sous l'origine même par laquelle
    // la personne invitée joindra ce back-office.
    setInvitationUrl(
      `${window.location.origin}${adminInvitationPath(tenantSlug, result.data.invitationToken)}`,
    );
    setNotice({
      tone: 'success',
      message: t('accountActions.newToken', { email: account.email }),
    });
  }

  return (
    <div className="spa-admin-toolbar">
      <Select
        id={`role-${account.id}`}
        label={t('accountActions.roleLabel')}
        onChange={(event) => setRole(event.target.value as StaffRole)}
        value={role}
      >
        {STAFF_ROLES.map((value) => (
          <option key={value} value={value}>
            {roleLabel(value, locale)}
          </option>
        ))}
      </Select>

      <Button
        disabled={!roleChanged || refreshing}
        loading={pending === 'role'}
        loadingLabel={t('accountActions.saving')}
        onClick={() => void applyRole()}
        variant="neutral"
      >
        {t('accountActions.apply')}
        <span className="spa-visually-hidden">
          {t('accountActions.applyFor', {
            name: `${account.firstName} ${account.lastName}`,
          })}
        </span>
      </Button>

      {isSelf ? (
        <span className="spa-admin-toolbar__hint">{t('accountActions.ownAccount')}</span>
      ) : (
        <Button
          disabled={refreshing}
          loading={pending === 'status'}
          loadingLabel={t('accountActions.saving')}
          onClick={() => void toggleStatus()}
          variant={active ? 'quiet' : 'neutral'}
        >
          {active ? t('accountActions.deactivate') : t('accountActions.reactivate')}
          <span className="spa-visually-hidden">
            {t('accountActions.statusFor', {
              name: `${account.firstName} ${account.lastName}`,
            })}
          </span>
        </Button>
      )}

      <Button
        disabled={refreshing}
        loading={pending === 'invitation'}
        loadingLabel={t('accountActions.issuing')}
        onClick={() => void reissue()}
        variant="quiet"
      >
        {t('accountActions.reissue')}
        <span className="spa-visually-hidden">
          {t('accountActions.reissueFor', {
            name: `${account.firstName} ${account.lastName}`,
          })}
        </span>
      </Button>

      {notice === null ? null : (
        <Notification
          title={
            notice.tone === 'success'
              ? t('accountActions.updatedTitle')
              : t('accountActions.failedTitle')
          }
          tone={notice.tone}
        >
          <p>{notice.message}</p>
          {invitationUrl === null ? null : (
            <InvitationLink id={`invitation-${account.id}`} url={invitationUrl} />
          )}
        </Notification>
      )}
    </div>
  );
}
