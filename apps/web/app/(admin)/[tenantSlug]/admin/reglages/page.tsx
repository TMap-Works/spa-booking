import type { Tenant } from '@spa/shared';

import { fetchTenantSettings } from '@/lib/api-client';

import { TenantSettingsForm } from '../components/tenant-settings-form';
import { adminLoadFailure, requireAdminAccessToken } from '../guard';
import { adminSettingsPath } from '../paths';

/**
 * Réglages de l'établissement — adresse, horaires d'ouverture, coordonnées
 * (#343, quatrième critère).
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
 */

export const dynamic = 'force-dynamic';

interface SettingsPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function TenantSettingsPage({ params }: SettingsPageProps) {
  const { tenantSlug } = await params;
  const accessToken = await requireAdminAccessToken(tenantSlug, adminSettingsPath(tenantSlug));

  let tenant: Tenant;
  try {
    tenant = await fetchTenantSettings(accessToken);
  } catch (error) {
    return adminLoadFailure(error, tenantSlug, {
      deniedTitle: 'Accès réservé',
      deniedHint:
        'Le paramétrage de l’établissement est réservé aux comptes administrateurs. Demandez l’accès à l’administrateur du salon.',
      failedTitle: 'Réglages indisponibles',
    });
  }

  return <TenantSettingsForm tenantSlug={tenantSlug} tenant={tenant} />;
}
