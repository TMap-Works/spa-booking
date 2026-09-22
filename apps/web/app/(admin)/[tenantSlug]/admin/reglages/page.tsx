import type { SessionUser, Tenant } from '@spa/shared';
import { getTranslations } from 'next-intl/server';
import type { ReactElement } from 'react';

import { fetchOwnProfile, fetchTenantSettings } from '@/lib/api-client';

import { TenantSettingsForm } from '../components/tenant-settings-form';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { adminSettingsPath } from '../paths';
import { MemberLocaleForm } from './components/member-locale-form';

/**
 * Réglages de l'établissement — adresse, horaires d'ouverture, coordonnées
 * (#343, quatrième critère), langue par défaut du salon et **langue du compte
 * connecté** (#853).
 *
 * ## La garde est ici, pas dans le layout
 *
 * Un layout n'est pas rejoué à chaque navigation dans l'App Router : une page
 * peut être servie sans que son parent ait été réévalué. La lecture du jeton et
 * la redirection vivent donc dans la page — mais par `requireAdminAccessToken`,
 * comme les sept autres écrans du back-office, et non par une cascade réécrite
 * ici. Cette page était la dernière à la réécrire, et elle avait divergé sur le
 * point qui compte : un cookie d'accès expiré la renvoyait à la connexion au
 * lieu de renouveler la session, alors qu'elle est l'écran où la connexion
 * dépose (#48, #458). Huit heures d'ouverture d'affilée et une reconnexion à
 * chaque quart d'heure : c'est exactement ce que le renouvellement silencieux
 * existe pour éviter.
 *
 * ## Trois issues, et aucune ne boucle
 *
 * 1. **pas de cookie d'accès** — renouvellement de session, qui rend la main
 *    ici ; l'écran de connexion seulement si le jeton de rafraîchissement manque
 *    lui aussi ;
 * 2. **un 401 malgré un cookie** — la session a été révoquée en base ou l'API a
 *    changé de secret. On ne tente pas de renouveler, ce qui échouerait pour la
 *    même raison : on renvoie à la connexion ;
 * 3. **un 403** — la session est valide mais le rôle ne suffit pas. Ce n'est
 *    **pas** une raison de renvoyer à la connexion : se reconnecter avec le même
 *    compte donnerait le même refus, et la boucle serait sans fin. L'écran le
 *    dit, et s'arrête là.
 *
 * ## Deux cartes, et deux autorisations (#853)
 *
 * Les réglages du salon sont fermés au rang `ADMIN` — c'est la garde de
 * `GET /tenant`. La langue du compte, elle, relève de `PATCH /users/me`, ouvert
 * à toute session : le critère parle d'un **membre de l'équipe**, pas du seul
 * gérant. La seconde carte est donc rendue quoi qu'ait donné la première, et un
 * 403 sur les réglages du salon ne l'emporte pas avec lui.
 *
 * Le refus garde sa forme : `adminLoadFailure` redirige encore sur 401 et 402 —
 * ces deux-là ne laissent aucun écran à afficher — et n'affiche un encart que
 * sur 403 et sur les pannes. Le `<h1>` de l'écran est alors rendu ici, puisque
 * c'est `TenantSettingsForm` qui le porte en temps normal : une zone de contenu
 * sans titre laisserait le titre de l'écran précédent pour seul repère.
 *
 * Deux bornes de colonne plutôt qu'une (#630) : chaque carte garde ses 44 rem,
 * et `TenantSettingsForm` reste l'enfant immédiat de la sienne — c'est cette
 * imbrication précise que `admin/shell.css` vise pour écarter le titre de son
 * premier champ (#718).
 */

export const dynamic = 'force-dynamic';

interface SettingsPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function TenantSettingsPage({ params }: SettingsPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminSettingsPath(tenantSlug));
  const t = await getTranslations('admin-settings');

  let tenant: Tenant | null = null;
  let refusal: ReactElement | null = null;

  try {
    tenant = await fetchTenantSettings(accessToken);
  } catch (error) {
    refusal = adminLoadFailure(error, tenantSlug, {
      deniedTitle: t('deniedTitle'),
      deniedHint: t('deniedHint'),
      failedTitle: t('failedTitle'),
    });
  }

  /*
   * Le compte connecté, pour sa seule langue préférée.
   *
   * `GET /auth/me` est déjà appelé par le gabarit du back-office dans la même
   * passe de rendu, et Next mémoïse les `fetch` identiques : cette lecture ne
   * coûte aucun aller-retour de plus. Une panne n'emporte pas l'écran — la carte
   * le dit et propose de rafraîchir, là où une exception aurait fait tomber des
   * réglages de salon qui, eux, ont répondu.
   */
  let profile: SessionUser | null = null;

  try {
    profile = await fetchOwnProfile(accessToken);
  } catch {
    profile = null;
  }

  return (
    <>
      {tenant === null ? (
        <div className="spa-admin-form">
          <section aria-labelledby="reglages-titre">
            <h1 className="spa-admin__title" id="reglages-titre">
              {t('title')}
            </h1>
            {refusal}
          </section>
        </div>
      ) : (
        <div className="spa-admin-form">
          <TenantSettingsForm tenantSlug={tenantSlug} tenant={tenant} />
        </div>
      )}
      <div className="spa-admin-form">
        <MemberLocaleForm profile={profile} tenantSlug={tenantSlug} />
      </div>
    </>
  );
}
