import { SUBSCRIPTION_PLAN, type Locale } from '@spa/shared';
import type { Metadata } from 'next';
import { useTranslations, useLocale } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';

import { AuthScreen, type AuthHighlight } from '@/components/auth/auth-screen';
import type { DisplayLocale } from '@/lib/format';
import { PHOTOS } from '@/lib/photos';
import { planPriceLabel } from '@/lib/plan';
import { PLATFORM_HOME_PATH, PLATFORM_NAME } from '@/lib/platform';

import { SignupForm } from './components/signup-form';

import '../../styles/admin/index.css';

/**
 * L'inscription d'un salon en libre-service — ADR 0016.
 *
 * `inscription` est un slug réservé (`RESERVED_TENANT_SLUGS`) : aucun salon ne
 * peut s'y ouvrir, et le segment statique l'emporte sur `[tenantSlug]`.
 *
 * ## La langue (#1105)
 *
 * Tous les libellés viennent du namespace `signup`. Ce qui reste écrit ici est
 * l'ordre des arguments de vente, l'icône de chacun et la photographie du volet
 * d'accueil — ce qui ne se traduit pas.
 *
 * Aucun établissement n'existe encore sur cet écran : la **région** de mise en
 * forme est donc celle du repli de `lib/format.ts` (`en` → `en-US`,
 * `fr` → `fr-FR`), comme sur l'accueil de la plateforme. Le prix de l'offre est
 * en euros quel que soit le pays du salon qui s'inscrit — c'est le prix que
 * l'éditeur facture, pas celui que le salon vend.
 */

/** La région de repli : il n'y a pas encore de salon dont lire le pays. */
const NO_TENANT_YET: null = null;

/**
 * Le titre et la description de l'onglet, dans la langue résolue.
 *
 * `generateMetadata` et non un objet `metadata` constant : un littéral est
 * évalué à l'importation, hors de toute requête, et ne peut donc connaître ni la
 * langue ni le prix tel qu'elle l'écrit.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('signup');
  const locale = (await getLocale()) as Locale;
  const display: DisplayLocale = { locale, countryCode: NO_TENANT_YET };

  const promise = t('plan.promise', {
    days: SUBSCRIPTION_PLAN.trialDays,
    price: planPriceLabel(display),
  });

  return {
    title: t('metadata.title', { platform: PLATFORM_NAME }),
    description: t('metadata.description', { promise }),
  };
}

/** Les arguments du volet d'accueil : leur ordre et leur icône, pas leur texte. */
const HIGHLIGHTS = ['booking', 'reminders', 'team'] as const;

const HIGHLIGHT_ICONS: Readonly<Record<(typeof HIGHLIGHTS)[number], AuthHighlight['icon']>> = {
  booking: 'calendar',
  reminders: 'bell',
  team: 'users',
};

export default function SignupPage() {
  const t = useTranslations('signup');
  const locale = useLocale() as Locale;
  const display: DisplayLocale = { locale, countryCode: NO_TENANT_YET };

  const promise = t('plan.promise', {
    days: SUBSCRIPTION_PLAN.trialDays,
    price: planPriceLabel(display),
  });

  const highlights: readonly AuthHighlight[] = [
    ...HIGHLIGHTS.map((key) => ({
      icon: HIGHLIGHT_ICONS[key],
      text: t(`intro.highlights.${key}` as 'intro.highlights.booking'),
    })),
    { icon: 'shield' as const, text: t('intro.highlights.trial', { promise }) },
  ];

  return (
    <AuthScreen
      salonName={null}
      headline={t('intro.headline')}
      lead={t('intro.lead')}
      highlights={highlights}
      photo={PHOTOS.spaInterieur}
      exits={[{ href: PLATFORM_HOME_PATH, label: t('intro.home', { platform: PLATFORM_NAME }) }]}
    >
      <SignupForm />
    </AuthScreen>
  );
}
