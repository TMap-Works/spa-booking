import type { Locale, UserRole } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';

import { Icon } from '@/components/ui/icon';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { formattingLocale } from '@/lib/format';

import type { AdminShellBilling } from '../layout';
import { adminBillingPath } from '../paths';

/**
 * La barre haute du back-office : où l'on est (le salon, la date du jour dans
 * son fuseau), et deux gestes transverses — ouvrir la vitrine publique telle
 * que les clientes la voient, et choisir le thème d'affichage (#855).
 *
 * Elle ne porte **pas** le titre de l'écran : chaque page rend déjà son
 * `<h1 className="spa-admin__title">`.
 *
 * ## La langue (#845)
 *
 * Ses libellés viennent du namespace `shell`, et la date du jour est mise en
 * forme dans la langue résolue plutôt qu'en `fr-FR` codé en dur. Le **fuseau**,
 * lui, ne bouge pas : c'est celui du salon, et il le reste quelle que soit la
 * langue de qui lit — une date affichée dans le fuseau du lecteur ferait
 * annoncer une autre journée que celle que le planning montre.
 */

interface AdminTopbarProps {
  readonly tenantSlug: string;
  readonly salonName: string;
  readonly timeZone: string | null;
  readonly billing: AdminShellBilling | null;
  readonly role: UserRole;
}

/** Jours d'essai restants, arrondis au jour supérieur — « J-1 » le dernier jour. */
function trialDaysLeft(trialEndsAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(trialEndsAt) - Date.now()) / 86_400_000));
}

/**
 * La pastille d'abonnement (ADR 0016) : l'essai qui court, ou le salon fermé.
 * Un lien pour l'administrateur, qui peut agir ; un texte pour les autres.
 */
function BillingPill({
  billing,
  role,
  tenantSlug,
}: {
  billing: AdminShellBilling | null;
  role: UserRole;
  tenantSlug: string;
}) {
  const t = useTranslations('shell.admin.topbar');

  if (billing === null) {
    return null;
  }

  let label: string;
  let tone: 'trial' | 'closed';
  if (billing.status === 'trialing' && billing.trialEndsAt !== null) {
    const days = trialDaysLeft(billing.trialEndsAt);
    label = days <= 1 ? t('trialLastDay') : t('trialDaysLeft', { days });
    tone = 'trial';
  } else if (billing.status === 'pending' || billing.status === 'canceled') {
    label = billing.status === 'pending' ? t('subscriptionPending') : t('subscriptionCanceled');
    tone = 'closed';
  } else if (billing.status === 'past_due') {
    label = t('subscriptionPastDue');
    tone = 'closed';
  } else {
    return null;
  }

  const className = `spa-admin-topbar__billing spa-admin-topbar__billing--${tone}`;

  return role === 'admin' ? (
    <Link className={className} href={adminBillingPath(tenantSlug)}>
      {label}
    </Link>
  ) : (
    <span className={className}>{label}</span>
  );
}

function todayIn(timeZone: string, locale: Locale): string {
  const formatted = new Intl.DateTimeFormat(formattingLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(new Date());
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export function AdminTopbar({ tenantSlug, salonName, timeZone, billing, role }: AdminTopbarProps) {
  const t = useTranslations('shell.admin.topbar');
  const locale = useLocale() as Locale;

  return (
    <header className="spa-admin-topbar">
      <div className="spa-admin-topbar__context">
        <span className="spa-admin-topbar__eyebrow">{salonName}</span>
        {/* Pas de date sans fuseau : elle serait celle d'un autre endroit. */}
        {timeZone === null ? null : (
          <span className="spa-admin-topbar__date">{todayIn(timeZone, locale)}</span>
        )}
      </div>
      <div className="spa-admin-topbar__actions">
        <BillingPill billing={billing} role={role} tenantSlug={tenantSlug} />
        <a className="spa-admin-topbar__link" href={`/${tenantSlug}`} rel="noopener" target="_blank">
          <Icon name="external" />
          <span>{t('storefront')}</span>
          <span className="spa-visually-hidden">{t('newTab')}</span>
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
