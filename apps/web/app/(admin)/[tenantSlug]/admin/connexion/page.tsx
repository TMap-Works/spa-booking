import { AdminLoginForm } from '../components/admin-login-form';

/**
 * L'écran de connexion — **la seule page du back-office qui n'exige pas de
 * session**.
 *
 * Elle ne lit donc aucun jeton : la garde vit dans chaque page, et celle-ci s'en
 * passe délibérément plutôt que d'être exemptée par une liste tenue ailleurs.
 * Une exemption par liste finit toujours par contenir une page de trop.
 */

export const dynamic = 'force-dynamic';

interface AdminLoginPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
}

export default async function AdminLoginPage({ params }: AdminLoginPageProps) {
  const { tenantSlug } = await params;

  return <AdminLoginForm tenantSlug={tenantSlug} />;
}
