import {
  hasAtLeastRole,
  type SessionUser,
  type StaffAccountState,
  type StaffMember,
} from '@spa/shared';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';

import {
  fetchOwnProfile,
  fetchPublicTenant,
  fetchStaffAccounts,
  fetchStaffMembers,
} from '@/lib/api-client';
import { sortStaffMembers, staffInitials } from '@/lib/admin/staff-directory';
import { isStaffRole } from '@/lib/admin/staff-contract';
import type { DisplayLocale } from '@/lib/format';
import { formatPhoneForDisplay } from '@/lib/phone';

import { roleLabel } from '../../components/navigation';
import { adminLoadFailure, requireAdminAccessToken } from '../../guard';
import { StaffAccountActions } from '../components/staff-account-actions';
import {
  adminNewStaffMemberPath,
  adminStaffInvitePath,
  adminStaffMemberPath,
  adminStaffPath,
} from '../paths';

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
 * l'agenda. Rien ne publie le lien entre les deux en lecture — `StaffMemberDto`
 * masque `userId` — et les apparier sur le nom serait une devinette dont le coût
 * est d'attribuer les horaires d'une collègue. L'écran affiche donc les deux, en
 * disant ce que chacune est et ce qu'on y fait.
 *
 * Le lien se **pose**, en revanche, et depuis #694 : `StaffMemberForm` choisit
 * explicitement le compte qu'une nouvelle fiche sert. C'est ce qui manquait pour
 * qu'un salon neuf soit exploitable — aucune route n'écrivait la table `staff`,
 * si bien que « Praticiens — 0 » était un état dont rien ne permettait de
 * sortir, et que le tunnel public répondait « aucun créneau » indéfiniment.
 *
 * ## Deux seuils de rôle, et ils ne disent pas la même chose
 *
 * Créer une fiche s'arrête au rang `MANAGER` : composer l'équipe réservable est
 * une décision d'exploitation. Inviter un compte, changer un rôle, désactiver un
 * accès exigent `ADMIN` — tout ce qui change ce qu'une personne *peut faire*.
 * L'écran reprend cette ligne de partage plutôt que d'aligner les deux sur le
 * plus haut, qui priverait les gérantes d'un geste que l'API leur accorde.
 *
 * Dans les deux cas, le rôle **filtre l'affichage, il ne protège rien** :
 * masquer un contrôle évite d'offrir un bouton qui répondrait 403, et la seule
 * garde qui compte reste celle de l'API, qu'aucun front ne contourne. Les deux
 * écrans vers lesquels ces actions mènent relisent le rang pour eux-mêmes : une
 * adresse se saisit, et un signet se garde.
 *
 * ## Les deux gestes sont en tête, et les formulaires ailleurs (#766)
 *
 * L'écran ouvrait sur deux listes et rien d'autre : à 1280 px, la première
 * action — « Créer la fiche » — était à quelque 700 px de défilement, la seconde
 * — « Inviter » — à 1 050, toutes deux accentuées et donc sans hiérarchie entre
 * elles. Les deux formulaires vivent désormais sur leur propre écran, et la
 * barre d'outils qui les appelle est celle de /catalogue : une action accentuée,
 * une action secondaire, sous le titre. La liste redevient une liste.
 *
 * ## Les états vides ne nomment qu'un geste, et c'est celui du bouton (#767)
 *
 * Même audit, critère `ds:etats`, et même règle que
 * `docs/design/appointments/states.md` : « Vide : toujours accompagné d'une
 * explication et d'**au moins une action** pour sortir de l'impasse. » Le
 * déplacement des formulaires (#766) a posé cette action — l'état vide des
 * praticiens porte le bouton accentué que `mockups/admin/personnel.html` y
 * dessine, et le « ci-dessous » du constat a disparu avec le formulaire qu'il
 * désignait.
 *
 * Restait le motif que ce constat condamne, déplacé d'un cran : la description
 * nommait **un second geste en prose** — « invitez-en un d'abord s'il n'y en a
 * aucun » —, sans contrôle pour l'exécuter. Deux défauts d'un coup. Il était
 * mort : `GET /v1/users` rend tout le personnel de l'établissement, **le compte
 * qui lit compris**, si bien que la liste en porte toujours au moins un et que
 * la condition « s'il n'y en a aucun » ne se vérifie jamais. Et il s'adressait
 * au rang gérant, à qui `POST /v1/users/invitations` répondrait 403 — la
 * promesse de refus que #619 a précisément chassée de cet écran.
 *
 * La règle tenue ici, dans les deux états vides : **le texte ne nomme que le
 * geste que le contrôle d'à côté exécute**, et quand le rang n'en accorde
 * aucun, il dit qui peut agir au lieu de donner un ordre irréalisable.
 *
 * ## Pourquoi sous `(liste)/` (#830)
 *
 * Le groupe ne change pas l'URL. Il donne à la liste un dossier où poser son
 * squelette (`loading.tsx`) sans envelopper la fiche voisine, dont le 404 doit
 * partir avant tout squelette — voir `components/admin-screen-skeleton.tsx`.
 */

export const dynamic = 'force-dynamic';

interface StaffPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function StaffPage({ params }: StaffPageProps) {
  const { tenantSlug } = await params;
  const t = await getTranslations('admin-staff');
  const locale = await getLocale();
  const accessToken = await requireAdminAccessToken(tenantSlug, adminStaffPath(tenantSlug));

  let profile: SessionUser;
  let accounts: StaffAccountState[];
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
      deniedTitle: t('denied.title'),
      deniedHint: t('denied.hint'),
      failedTitle: t('failure.list'),
    });
  }

  const canAdminister = hasAtLeastRole(profile.role, 'admin');
  // Composer l'équipe réservable est une décision d'exploitation, pas une
  // distribution de droits : `POST /v1/staff` s'arrête au rang `MANAGER`, là où
  // l'invitation et le changement de rôle exigent `ADMIN`. Les deux seuils sont
  // donc distincts ici aussi — masquer l'action aux gérantes leur cacherait un
  // geste que l'API leur accorde.
  const canManage = hasAtLeastRole(profile.role, 'manager');
  // Un compte `client` n'a rien à faire dans cette liste — `GET /v1/users` ne
  // rend que le personnel — mais toutes les actions de la ligne supposent un
  // rôle interne, et l'afficher offrirait des boutons qui échoueraient.
  const staffAccounts = accounts.filter((account) => isStaffRole(account.role));
  /*
   * La **région** du classement (#848) — jamais le fuseau, qui ne sert pas ici.
   *
   * Elle vient de l'adresse publiée sur la vitrine, `GET /public/{slug}` : la
   * même réponse que le gabarit du back-office lit déjà pour son pied de rail,
   * et que Next mémoïse sur la durée du rendu. Aucun aller-retour de plus.
   *
   * Un échec ne coûte qu'un ordre de tri : le repli documenté de
   * `lib/format.ts` s'applique, et l'écran du personnel n'a aucune raison de
   * tomber parce que la vitrine n'a pas répondu.
   */
  const countryCode = await fetchPublicTenant(tenantSlug)
    .then((tenant) => tenant.address?.country ?? null)
    .catch(() => null);
  const display: DisplayLocale = { locale, countryCode };
  const practitioners = sortStaffMembers(members, display);

  return (
    <section aria-labelledby="personnel-titre">
      <h1 className="spa-admin__title" id="personnel-titre">
        {t('title')}
      </h1>

      {/* La barre d'outils de /catalogue, aux mêmes classes et dans le même
          ordre : l'entretoise pousse les actions à droite du titre, l'accentuée
          en dernier. Deux rangs, donc deux visibilités — et quand le rang n'en
          accorde aucune, la barre dit pourquoi plutôt que de disparaître sans un
          mot (#619). */}
      <div className="spa-admin-toolbar">
        <span className="spa-admin-toolbar__spacer" />
        <div className="spa-admin-toolbar__group">
          {canAdminister ? (
            <Link className="spa-button spa-button--neutral" href={adminStaffInvitePath(tenantSlug)}>
              {t('toolbar.invite')}
            </Link>
          ) : null}
          {canManage ? (
            <Link
              className="spa-button spa-button--accent"
              href={adminNewStaffMemberPath(tenantSlug)}
            >
              {t('toolbar.newMember')}
            </Link>
          ) : (
            <span className="spa-admin-toolbar__hint">{t('toolbar.restricted')}</span>
          )}
        </div>
      </div>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">
          {t('practitioners.title', { count: String(practitioners.length) })}
        </h2>
        <p className="spa-admin-toolbar__hint">{t('practitioners.hint')}</p>

        {practitioners.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('practitioners.emptyTitle')}</p>
            <p className="spa-empty-state__description">
              {canManage
                ? t('practitioners.emptyDescriptionManager')
                : t('practitioners.emptyDescriptionReader')}
            </p>
            {/* Un lien et non un bouton : c'est une destination. Posé
                directement dans `.spa-empty-state`, déjà une colonne centrée avec
                son écart — même motif que l'état vide de l'espace client. */}
            {canManage ? (
              <Link
                className="spa-button spa-button--accent"
                href={adminNewStaffMemberPath(tenantSlug)}
              >
                <span className="spa-button__label">{t('toolbar.newMember')}</span>
              </Link>
            ) : null}
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
                    {staffInitials(member.displayName, display)}
                  </span>
                  <span className="spa-admin-staff__identity">
                    <span className="spa-admin-staff__name">{member.displayName}</span>
                    <span className="spa-admin-staff__role">{t('practitioners.subtitle')}</span>
                  </span>
                  <span
                    className={
                      member.isActive
                        ? 'spa-admin-badge spa-admin-badge--confirmed'
                        : 'spa-admin-badge spa-admin-badge--cancelled'
                    }
                  >
                    {member.isActive ? t('practitioners.active') : t('practitioners.suspended')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="spa-admin__section">
        <h2 className="spa-admin__section-title">
          {t('accounts.title', { count: String(staffAccounts.length) })}
        </h2>
        <p className="spa-admin-toolbar__hint">{t('accounts.hint')}</p>

        {staffAccounts.length === 0 ? (
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">{t('accounts.emptyTitle')}</p>
            <p className="spa-empty-state__description">
              {canAdminister
                ? t('accounts.emptyDescriptionAdmin')
                : t('accounts.emptyDescriptionReader')}
            </p>
            {canAdminister ? (
              <Link
                className="spa-button spa-button--neutral"
                href={adminStaffInvitePath(tenantSlug)}
              >
                <span className="spa-button__label">{t('toolbar.invite')}</span>
              </Link>
            ) : null}
          </div>
        ) : (
          <table className="spa-admin-table">
            <caption className="spa-visually-hidden">{t('accounts.caption')}</caption>
            <thead>
              <tr>
                <th className="spa-admin-table__head" scope="col">
                  {t('accounts.name')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('accounts.email')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('accounts.phone')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('accounts.role')}
                </th>
                <th className="spa-admin-table__head" scope="col">
                  {t('accounts.state')}
                </th>
                {canAdminister ? (
                  <th className="spa-admin-table__head" scope="col">
                    {t('accounts.actions')}
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
                  <td className="spa-admin-table__cell">{account.phone === null ? '—' : formatPhoneForDisplay(account.phone)}</td>
                  <td className="spa-admin-table__cell">{roleLabel(account.role, locale)}</td>
                  <td className="spa-admin-table__cell">
                    <span
                      className={
                        account.isActive
                          ? 'spa-admin-badge spa-admin-badge--confirmed'
                          : 'spa-admin-badge spa-admin-badge--cancelled'
                      }
                    >
                      {account.isActive ? t('accounts.active') : t('accounts.disabled')}
                    </span>
                  </td>
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
    </section>
  );
}
