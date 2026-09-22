import { hasAtLeastRole, type SessionUser, type StaffAccountState } from '@spa/shared';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { Notification } from '@/components/ui/notification';
import { fetchOwnProfile, fetchStaffAccounts } from '@/lib/api-client';
import { isStaffRole } from '@/lib/admin/staff-contract';

import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { StaffMemberForm } from '../components/staff-member-form';
import { adminNewStaffMemberPath, adminStaffInvitePath, adminStaffPath } from '../paths';

/**
 * Création d'une fiche praticien — l'écran (#766).
 *
 * ## Pourquoi le formulaire a quitté la liste
 *
 * L'audit de conception `d20260916-1` a relevé sur /personnel un écran qui
 * n'offrait aucune action en tête : ses deux boutons accentués étaient ceux de
 * deux formulaires déployés en permanence sous les listes, à quelque 700 et
 * 1 050 px de défilement à 1280 px, de poids visuel identique et sans hiérarchie
 * entre eux. La correction est celle que le back-office tient déjà pour le
 * catalogue — « Nouvelle prestation » mène à /catalogue/nouveau —, et c'est la
 * même mécanique ici : la liste garde les listes, le formulaire a son écran.
 *
 * ## Le rang est relu ici, et ce n'est pas une garde
 *
 * La barre d'outils de la liste ne propose « Créer une fiche praticien » qu'au
 * rang gérant, mais une adresse se saisit et un signet se garde. Sans cette
 * borne, l'écran servirait ses trois champs à un compte qui n'obtiendra que le
 * 403 de `POST /v1/staff` — le refus après coup qu'il s'agit justement de ne
 * plus infliger (#619). La seule garde qui compte reste celle de l'API.
 *
 * ## Les comptes viennent d'ici, et pas du formulaire
 *
 * `StaffMemberForm` est un Client Component : lui faire lire les comptes le
 * ferait passer par une route interne, un aller-retour réseau de plus pour une
 * donnée que le serveur a déjà sous la main (web-frontend §1). L'écran les lit
 * donc et les lui passe, filtrés comme la liste les filtre — un compte `client`
 * n'est pas rattachable à une fiche.
 */

export const dynamic = 'force-dynamic';

interface NewStaffMemberPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function NewStaffMemberPage({ params }: NewStaffMemberPageProps) {
  const { tenantSlug } = await params;
  const t = await getTranslations('admin-staff');
  const accessToken = await requireAdminAccessToken(tenantSlug, adminNewStaffMemberPath(tenantSlug));

  let profile: SessionUser;
  let accounts: StaffAccountState[];

  try {
    // Deux lectures indépendantes : les enchaîner ajouterait un aller-retour à
    // l'ouverture de l'écran.
    [profile, accounts] = await Promise.all([
      fetchOwnProfile(accessToken),
      fetchStaffAccounts(accessToken),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.hint'),
      failedTitle: t('failure.form'),
    });
  }

  if (!hasAtLeastRole(profile.role, 'manager')) {
    return (
      <Notification tone="warning" title={t('member.deniedTitle')}>
        <p>
          {t.rich('member.deniedBody', {
            link: (chunks) => <Link href={adminStaffPath(tenantSlug)}>{chunks}</Link>,
          })}
        </p>
      </Notification>
    );
  }

  return (
    <section aria-labelledby="fiche-praticien-nouvelle">
      <h1 className="spa-admin__title" id="fiche-praticien-nouvelle">
        {t('member.screenTitle')}
      </h1>

      <div className="spa-admin-toolbar">
        <Link className="spa-button spa-button--quiet" href={adminStaffPath(tenantSlug)}>
          {t('returnToStaff')}
        </Link>
        <span className="spa-admin-toolbar__spacer" />
        {/* L'enchaînement de l'écran vide : une fiche se rattache à un compte,
            et s'il n'y en a aucun il faut d'abord inviter. Réservé au rang qui
            peut le faire — l'offrir à une gérante serait lui promettre le 403 de
            `POST /v1/users/invitations`. */}
        {hasAtLeastRole(profile.role, 'admin') ? (
          <Link className="spa-button spa-button--neutral" href={adminStaffInvitePath(tenantSlug)}>
            {t('toolbar.invite')}
          </Link>
        ) : null}
      </div>

      <StaffMemberForm
        accounts={accounts.filter((account) => isStaffRole(account.role))}
        tenantSlug={tenantSlug}
      />
    </section>
  );
}
