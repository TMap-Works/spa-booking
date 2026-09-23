import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { PHOTOS } from '@/lib/photos';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

import { PlatformLoginForm } from '../components/platform-login-form';
import { PLATFORM_CONSOLE_PATH } from '../paths';
import { readPlatformAccessToken } from '../session';

/**
 * La connexion à la console — mot de passe **et** code TOTP (ADR 0012 §3).
 *
 * Servie sans session, et redirigée vers la console quand il y en a une : même
 * conduite que l'écran de connexion du back-office (#760).
 *
 * La page est asynchrone : c'est `getTranslations` qui lui donne ses mots, et un
 * composant asynchrone ne peut pas appeler un crochet (#1106).
 */

/** Ce que la console ouvre — les clés, l'ordre, et le pictogramme de chacune. */
const CONSOLE_HIGHLIGHTS: readonly { icon: AuthHighlight['icon']; key: string }[] = [
  { icon: 'store', key: 'open' },
  { icon: 'calendar', key: 'links' },
  { icon: 'users', key: 'watch' },
];

interface PlatformLoginPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PlatformLoginPage({ searchParams }: PlatformLoginPageProps) {
  if ((await readPlatformAccessToken()) !== null) {
    redirect(PLATFORM_CONSOLE_PATH);
  }

  const [{ motif }, t] = await Promise.all([searchParams, getTranslations('platform')]);

  const highlights: readonly AuthHighlight[] = CONSOLE_HIGHLIGHTS.map((highlight) => ({
    icon: highlight.icon,
    text: t(`login.highlights.${highlight.key}` as 'login.highlights.open'),
  }));

  return (
    <AuthScreen
      salonName={null}
      headline={t('login.headline')}
      lead={t('login.lead')}
      highlights={highlights}
      photo={PHOTOS.salonInterieur}
      exits={[
        { href: PLATFORM_HOME_PATH, label: t('login.exitHome', { platform: PLATFORM_NAME }) },
      ]}
    >
      <PlatformLoginForm expired={motif === 'session-expiree'} />
    </AuthScreen>
  );
}
