import { getLocale, getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { PHOTOS } from '@/lib/photos';
import { publicExitLabels } from '@/components/salon/public-exits';
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
 *
 * Ses mots viennent du catalogue `admin-auth` (#853), comme ceux de la
 * connexion, et par le même chemin : `getTranslations`, la page étant
 * asynchrone.
 */

export const dynamic = 'force-dynamic';

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
  const [t, locale] = await Promise.all([getTranslations('admin-auth'), getLocale()]);

  const highlights: readonly AuthHighlight[] = [
    { icon: 'store', text: t('invitation.highlights.store') },
    { icon: 'users', text: t('invitation.highlights.users') },
    { icon: 'calendar', text: t('invitation.highlights.calendar') },
  ];

  return (
    <AuthScreen
      salonName={salon.status === 'found' ? salon.name : null}
      headline={t('invitation.headline')}
      lead={t('invitation.lead')}
      highlights={highlights}
      photo={PHOTOS.soinVisage}
      exits={[
        { href: salonPath(tenantSlug), label: publicExitLabels(locale).vitrine },
        { href: PLATFORM_HOME_PATH, label: t('platformHome', { platform: PLATFORM_NAME }) },
      ]}
    >
      <AdminInvitationForm
        tenantSlug={tenantSlug}
        token={typeof token === 'string' && token !== '' ? token : null}
      />
    </AuthScreen>
  );
}
