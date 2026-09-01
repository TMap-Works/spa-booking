import { fetchOwnProfile } from '@/lib/api-client';

import { ProfileForm } from '../components/profile-form';
import { accountPath } from '../paths';
import { readAccountData } from '../session';

/**
 * L'écran « modifier mes coordonnées » (#47, quatrième critère).
 *
 * Le profil est lu côté serveur, avec le jeton, puis passé en prop au
 * formulaire : le Client Component reçoit un nom, un e-mail et un numéro — jamais
 * la session qui a permis de les lire.
 */

export const dynamic = 'force-dynamic';

interface ProfilePageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { tenantSlug } = await params;

  const profile = await readAccountData(
    tenantSlug,
    accountPath(tenantSlug, '/coordonnees'),
    async (accessToken) => fetchOwnProfile(accessToken),
  );

  return <ProfileForm tenantSlug={tenantSlug} profile={profile} />;
}
