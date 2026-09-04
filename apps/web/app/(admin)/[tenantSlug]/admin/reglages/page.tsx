import type { Tenant } from '@spa/shared';
import { redirect } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { ApiClientError, fetchTenantSettings } from '@/lib/api-client';

import { TenantSettingsForm } from '../components/tenant-settings-form';
import { adminLoginPath } from '../paths';
import { readAdminAccessToken } from '../session';

/**
 * Réglages de l'établissement — adresse, horaires d'ouverture, coordonnées
 * (#343, quatrième critère).
 *
 * ## La garde est ici, pas dans le layout
 *
 * Un layout n'est pas rejoué à chaque navigation dans l'App Router : une page
 * peut être servie sans que son parent ait été réévalué. La lecture du jeton et
 * la redirection vivent donc dans la page, comme dans l'espace client.
 *
 * ## Trois issues, et aucune ne boucle
 *
 * 1. **pas de cookie d'accès** — écran de connexion ;
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
  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    redirect(adminLoginPath(tenantSlug));
  }

  let tenant: Tenant;
  try {
    tenant = await fetchTenantSettings(accessToken);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(adminLoginPath(tenantSlug));
    }
    if (error instanceof ApiClientError && error.status === 403) {
      return (
        <Notification tone="warning" title="Accès réservé">
          <p>
            Le paramétrage de l’établissement est réservé aux comptes administrateurs. Demandez
            l’accès à l’administrateur du salon.
          </p>
        </Notification>
      );
    }
    if (error instanceof ApiClientError) {
      return (
        <Notification tone="danger" title="Réglages indisponibles">
          <p>{error.message}</p>
        </Notification>
      );
    }
    throw error;
  }

  return <TenantSettingsForm tenantSlug={tenantSlug} tenant={tenant} />;
}
