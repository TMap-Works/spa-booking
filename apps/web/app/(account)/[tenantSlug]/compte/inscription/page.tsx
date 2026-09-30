import type { PublicTenant } from '@spa/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SalonAuthScreen } from '@/components/auth/salon-auth-screen';

import { RegisterForm } from '../components/register-form';
import { readAccessToken, readRefreshToken } from '../session';
import { accountTenant } from '../tenant';

/**
 * L'écran d'inscription — ouvert, comme la connexion. Voir `connexion/page.tsx`,
 * qui porte la raison pour laquelle le cadre d'accueil vit dans la page et non
 * dans le gabarit (#1052).
 *
 * À ne pas confondre avec `/inscription`, qui inscrit **un salon** à la
 * plateforme : celle-ci crée le compte d'une cliente chez un salon donné.
 */

export const dynamic = 'force-dynamic';

interface RegisterPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
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

  return { title: t('metadata.register') };
}

export default async function RegisterPage({ params }: RegisterPageProps) {
  const { tenantSlug } = await params;

  let tenant: PublicTenant | null;
  try {
    tenant = await accountTenant(tenantSlug);
  } catch {
    tenant = null;
  }

  // Le rang du titre suit celui du gabarit — même raison, même condition qu'à
  // la connexion (`../connexion/page.tsx`).
  const signedIn = (await readAccessToken()) !== null || (await readRefreshToken()) !== null;

  return (
    <SalonAuthScreen tenant={tenant} intent="inscription" headlineAs={signedIn ? 'p' : 'h1'}>
      <RegisterForm tenantSlug={tenantSlug} />
    </SalonAuthScreen>
  );
}
