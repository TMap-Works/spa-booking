import { LoginForm } from '../components/login-form';

/**
 * L'écran de connexion — **la seule page de l'espace client qui n'exige pas de
 * session**, avec l'inscription.
 *
 * Elle n'appelle donc pas `readAccountData` : la garde vit dans chaque page, et
 * ces deux-là s'en passent délibérément plutôt que d'être exemptées par une
 * liste tenue ailleurs. Une exemption par liste finit toujours par contenir une
 * page de trop.
 */

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ params, searchParams }: LoginPageProps) {
  const { tenantSlug } = await params;
  const { motif } = await searchParams;

  return <LoginForm tenantSlug={tenantSlug} expired={motif === 'session-expiree'} />;
}
