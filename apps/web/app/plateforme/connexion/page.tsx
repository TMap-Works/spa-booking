import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
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
 *
 * Elle porte le sélecteur de langue depuis #1326 : le rail de la console en
 * porte un, mais il n'apparaît qu'une fois la session ouverte — et aucun
 * établissement ne se trouve sur ce chemin dont la langue pourrait trancher.
 * C'est donc l'`Accept-Language` qui décide ici, et le sélecteur est le seul
 * moyen d'en changer.
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

/**
 * Le titre de l'onglet de cet écran (#1329).
 *
 * Le gabarit de l'espace le situe — « … · Console plateforme ». Sans ce
 * titre-ci, l'onglet portait le seul nom de l'espace, et deux écrans ouverts
 * côte à côte étaient indiscernables.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platform');

  return { title: t('meta.login') };
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
      <LocaleSwitcher className="spa-locale-switcher--centered spa-locale-switcher--detached" />
    </AuthScreen>
  );
}
