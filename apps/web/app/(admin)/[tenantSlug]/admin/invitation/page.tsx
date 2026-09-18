import { notFound, redirect } from 'next/navigation';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';
import { readSalonIdentity } from '@/lib/salon-identity';
import { salonPath } from '@/app/(account)/[tenantSlug]/compte/paths';

import { AdminInvitationForm } from '../components/admin-invitation-form';
import { adminLandingPath } from '../components/navigation';
import { loadAdminShell } from '../layout';
import { adminCalendarPath } from '../paths';

/**
 * L'activation d'un compte invité — la page que désigne le lien
 * `/{salon}/admin/invitation?token=…`.
 *
 * C'est le lien que la console remet au gérant d'un salon qu'elle vient
 * d'ouvrir (ADR 0012), et celui qu'un administrateur remet à un membre de son
 * équipe. La personne y choisit son premier mot de passe et arrive, connectée,
 * dans son back-office.
 *
 * Même conduite que la connexion : servie sans session, redirigée quand il y en
 * a une (#760) — une session ouverte n'a pas de compte à activer.
 */

export const dynamic = 'force-dynamic';

const WELCOME_HIGHLIGHTS: readonly AuthHighlight[] = [
  { icon: 'store', text: 'Vos prestations, vos horaires et votre vitrine' },
  { icon: 'users', text: 'Votre équipe et vos fiches clientes' },
  { icon: 'calendar', text: 'Le planning et les réservations en ligne' },
];

interface AdminInvitationPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminInvitationPage({
  params,
  searchParams,
}: AdminInvitationPageProps) {
  const { tenantSlug } = await params;
  const shell = await loadAdminShell(tenantSlug);

  if (shell !== null) {
    redirect(adminLandingPath(tenantSlug, shell.role) ?? adminCalendarPath(tenantSlug));
  }

  const salon = await readSalonIdentity(tenantSlug);

  if (salon.status === 'unknown') {
    notFound();
  }

  const { token } = await searchParams;

  return (
    <AuthScreen
      space="back-office"
      salonName={salon.status === 'found' ? salon.name : null}
      headline="Bienvenue dans votre back-office"
      headlineAs="p"
      lead="Choisissez votre mot de passe : vous arriverez directement dans votre espace."
      highlights={WELCOME_HIGHLIGHTS}
      exits={[
        { href: salonPath(tenantSlug), label: PUBLIC_EXIT_LABELS.vitrine },
        { href: PLATFORM_HOME_PATH, label: `Accueil ${PLATFORM_NAME}` },
      ]}
    >
      <AdminInvitationForm
        tenantSlug={tenantSlug}
        token={typeof token === 'string' && token !== '' ? token : null}
      />
    </AuthScreen>
  );
}
