import { redirect } from 'next/navigation';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

import { PlatformLoginForm } from '../components/platform-login-form';
import { PLATFORM_CONSOLE_PATH } from '../paths';
import { readPlatformAccessToken } from '../session';

/**
 * La connexion à la console — mot de passe **et** code TOTP (ADR 0012 §3).
 *
 * Servie sans session, et redirigée vers la console quand il y en a une : même
 * conduite que l'écran de connexion du back-office (#760).
 */

const CONSOLE_HIGHLIGHTS: readonly AuthHighlight[] = [
  { icon: 'store', text: 'Ouvrir un salon et inviter son gérant' },
  { icon: 'calendar', text: 'Remettre le lien de réservation et celui du back-office' },
  { icon: 'users', text: 'Suivre les salons ouverts sur la plateforme' },
];

interface PlatformLoginPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlatformLoginPage({ searchParams }: PlatformLoginPageProps) {
  if ((await readPlatformAccessToken()) !== null) {
    redirect(PLATFORM_CONSOLE_PATH);
  }

  const { motif } = await searchParams;

  return (
    <AuthScreen
      salonName={null}
      headline="La console de l’éditeur"
      lead="L’espace réservé à l’équipe qui ouvre et accompagne les salons de la plateforme."
      highlights={CONSOLE_HIGHLIGHTS}
      exits={[{ href: PLATFORM_HOME_PATH, label: `Accueil ${PLATFORM_NAME}` }]}
    >
      <PlatformLoginForm expired={motif === 'session-expiree'} />
    </AuthScreen>
  );
}
