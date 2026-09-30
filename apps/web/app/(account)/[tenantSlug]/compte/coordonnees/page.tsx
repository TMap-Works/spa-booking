import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { fetchOwnProfile } from '@/lib/api-client';
import { isRenewalReturn, RENEWAL_PARAM } from '@/lib/session-refresh';

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
  /**
   * Cet écran n'a qu'un paramètre d'URL, et il ne l'écrit pas lui-même : le
   * marqueur de renouvellement, posé par la route de renouvellement au retour
   * d'un 401 (#861). Le lire est ce qui borne la tentative à une seule, et donc
   * ce qui empêche la chaîne de redirections. Facultatif pour les doubles de
   * test, que Next n'est pas.
   */
  readonly searchParams?: Promise<{ readonly session?: string | readonly string[] }>;
}

/**
 * Le titre de l'onglet de cet écran (#1329).
 *
 * Le gabarit de l'espace le situe — « … · Mon compte ». Sans ce
 * titre-ci, l'onglet portait le seul nom de l'espace, et deux écrans ouverts
 * côte à côte étaient indiscernables.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('account');

  return { title: t('metadata.profile') };
}

export default async function ProfilePage({ params, searchParams }: ProfilePageProps) {
  const { tenantSlug } = await params;
  const query = (await searchParams) ?? {};

  const profile = await readAccountData(
    tenantSlug,
    accountPath(tenantSlug, '/coordonnees'),
    async (accessToken) => fetchOwnProfile(accessToken),
    isRenewalReturn(query[RENEWAL_PARAM]),
  );

  return <ProfileForm tenantSlug={tenantSlug} profile={profile} />;
}
