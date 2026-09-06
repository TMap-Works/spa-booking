import { hasAtLeastRole, type SessionUser, type StaffMember } from '@spa/shared';
import Link from 'next/link';

import { fetchOwnProfile, fetchStaffAccounts, fetchStaffMembers } from '@/lib/api-client';
import { sortStaffMembers, staffInitials } from '@/lib/admin/staff-directory';
import { isStaffRole, type StaffAccount } from '@/lib/admin/staff-contract';

import { roleLabel } from '../components/navigation';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { StaffAccountActions } from './components/staff-account-actions';
import { StaffInviteForm } from './components/staff-invite-form';
import { adminStaffMemberPath, adminStaffPath } from './paths';

/**
 * Le personnel de l'établissement (#53, premier critère).
 *
 * ## Server Component, et rendu à la demande
 *
 * Les deux listes sont du texte : rien n'y a d'état. Seuls les contrôles —
 * l'invitation, les actions de compte — basculent côté client, aussi bas que
 * possible dans l'arbre (web-frontend §1). `force-dynamic` parce que la page lit
 * un cookie de session : la mettre en cache servirait l'équipe du premier arrivé
 * à tout le monde.
 *
 * ## Deux listes, et c'est l'API qui le veut
 *
 * « Membre du personnel » recouvre deux choses que l'API tient séparées : le
 * **compte**, qui porte le rôle et l'accès, et la **fiche praticien**, qui porte
 * l'agenda. Rien ne publie le lien entre les deux — `StaffMemberDto` masque
 * `userId` — et les apparier sur le nom serait une devinette dont le coût est
 * d'attribuer les horaires d'une collègue. L'écran affiche donc les deux, en
 * disant ce que chacune est et ce qu'on y fait.
 *
 * ## Le rôle filtre l'affichage, il ne protège rien
 *
 * L'invitation et les actions de compte sont réservées aux administrateurs côté
 * API. Les masquer pour les autres évite d'offrir des boutons qui répondraient
 * 403 ; la seule garde qui compte reste celle de l'API, qu'aucun front ne
 * contourne.
 */

export const dynamic = 'force-dynamic';

interface StaffPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function StaffPage({ params }: StaffPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminStaffPath(tenantSlug));

  let profile: SessionUser;
  let accounts: StaffAccount[];
  let members: StaffMember[];

  try {
    // Trois lectures indépendantes : les enchaîner ajouterait deux allers-retours
    // à l'ouverture de l'écran.
    [profile, accounts, members] = await Promise.all([
      fetchOwnProfile(accessToken),
      fetchStaffAccounts(accessToken),
      fetchStaffMembers(accessToken),
    ]);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'La gestion du personnel est réservée aux comptes du salon. Demandez l’accès à l’administrateur.',
      failedTitle: 'Personnel indisponible',
    });
  }

  const canAdminister = hasAtLeastRole(profile.role, 'admin');
  // Un compte `client` n'a rien à faire dans cette liste — `GET /v1/users` ne
  // rend que le personnel — mais toutes les actions de la ligne supposent un
  // rôle interne, et l'afficher offrirait des boutons qui échoueraient.
  const staffAccounts = accounts.filter((account) => isStaffRole(account.role));
  const practitioners = sortStaffMembers(members);

  return (
    <section aria-labelledby="personnel-titre">
      <h1 className="spa-admin__title" id="personnel-titre">
        Personnel et horaires
      </h1>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">Praticiens — {practitioners.length}</h2>
        <p className="spa-admin-toolbar__hint">
          Les fiches qui portent un agenda. Ouvrez-en une pour saisir ses horaires récurrents, ses
          congés et les prestations qu’elle pratique.
        </p>

        {practitioners.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun praticien enregistré</p>
            <p className="spa-empty-state__description">
              Tant que personne n’est déclaré, le parcours de réservation ne propose aucun créneau.
              La création d’une fiche praticien n’est pas encore servie par l’API — invitez d’abord
              le compte ci-dessous.
            </p>
          </div>
        ) : (
          <ul className="spa-admin-staff">
            {practitioners.map((member) => (
              <li key={member.id}>
                <Link
                  className="spa-admin-staff__member"
                  href={adminStaffMemberPath(tenantSlug, member.id)}
                >
                  <span aria-hidden="true" className="spa-admin-staff__initials">
                    {staffInitials(member.displayName)}
                  </span>
                  <span className="spa-admin-staff__identity">
                    <span className="spa-admin-staff__name">{member.displayName}</span>
                    <span className="spa-admin-staff__role">Horaires, congés, prestations</span>
                  </span>
                  <span
                    className={
                      member.isActive
                        ? 'spa-admin-badge spa-admin-badge--confirmed'
                        : 'spa-admin-badge spa-admin-badge--cancelled'
                    }
                  >
                    {member.isActive ? 'Active' : 'Suspendue'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">Comptes — {staffAccounts.length}</h2>
        <p className="spa-admin-toolbar__hint">
          Les identités qui se connectent au back-office, avec leur rôle. Un compte n’est pas une
          fiche praticien&nbsp;: il porte l’accès, pas l’agenda.
        </p>

        {staffAccounts.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun compte du personnel</p>
            <p className="spa-empty-state__description">
              Invitez au moins une personne pour que le salon puisse être tenu à plusieurs.
            </p>
          </div>
        ) : (
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">
              Comptes du personnel de l’établissement, avec leur rôle.
            </caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  Nom
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Adresse
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Téléphone
                </th>
                <th className="spa-admin-table__head" scope="col">
                  Rôle
                </th>
                {canAdminister ? (
                  <th className="spa-admin-table__head" scope="col">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {staffAccounts.map((account) => (
                <tr className="spa-admin-table__row" key={account.id}>
                  <td className="spa-admin-table__cell">
                    {account.firstName} {account.lastName}
                  </td>
                  <td className="spa-admin-table__cell">{account.email}</td>
                  <td className="spa-admin-table__cell">{account.phone ?? '—'}</td>
                  <td className="spa-admin-table__cell">{roleLabel(account.role)}</td>
                  {canAdminister ? (
                    <td className="spa-admin-table__cell">
                      <StaffAccountActions
                        account={account}
                        isSelf={account.id === profile.id}
                        tenantSlug={tenantSlug}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canAdminister ? <StaffInviteForm tenantSlug={tenantSlug} /> : null}
    </section>
  );
}
