import { RegisterForm } from '../components/register-form';

/** L'écran d'inscription — ouvert, comme la connexion. Voir `connexion/page.tsx`. */

export const dynamic = 'force-dynamic';

interface RegisterPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function RegisterPage({ params }: RegisterPageProps) {
  const { tenantSlug } = await params;

  return <RegisterForm tenantSlug={tenantSlug} />;
}
