import type { UserRole } from '@spa/shared';
import Link from 'next/link';

import { Icon } from '@/components/ui/icon';
import { ThemeToggle } from '@/components/ui/theme-toggle';

import type { AdminShellBilling } from '../layout';
import { adminBillingPath } from '../paths';

/**
 * La barre haute du back-office : où l'on est (le salon, la date du jour dans
 * son fuseau), et deux gestes transverses — ouvrir la vitrine publique telle
 * que les clientes la voient, et choisir le thème d'affichage (#855).
 *
 * Elle ne porte **pas** le titre de l'écran : chaque page rend déjà son
 * `<h1 className="spa-admin__title">`.
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
  if (billing === null) {
    return null;
  }

  let label: string;
  let tone: 'trial' | 'closed';
  if (billing.status === 'trialing' && billing.trialEndsAt !== null) {
    const days = trialDaysLeft(billing.trialEndsAt);
    label = days <= 1 ? 'Essai gratuit · dernier jour' : `Essai gratuit · ${String(days)} jours restants`;
    tone = 'trial';
  } else if (billing.status === 'pending' || billing.status === 'canceled') {
    label = billing.status === 'pending' ? 'Abonnement à activer' : 'Abonnement inactif';
    tone = 'closed';
  } else if (billing.status === 'past_due') {
    label = 'Paiement à régulariser';
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

function todayIn(timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(new Date());
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

export function AdminTopbar({ tenantSlug, salonName, timeZone, billing, role }: AdminTopbarProps) {
  return (
    <header className="spa-admin-topbar">
      <div className="spa-admin-topbar__context">
        <span className="spa-admin-topbar__eyebrow">{salonName}</span>
        {/* Pas de date sans fuseau : elle serait celle d'un autre endroit. */}
        {timeZone === null ? null : <span className="spa-admin-topbar__date">{todayIn(timeZone)}</span>}
      </div>
      <div className="spa-admin-topbar__actions">
        <BillingPill billing={billing} role={role} tenantSlug={tenantSlug} />
        <a className="spa-admin-topbar__link" href={`/${tenantSlug}`} rel="noopener" target="_blank">
          <Icon name="external" />
          <span>Voir ma vitrine</span>
          <span className="spa-visually-hidden"> (nouvel onglet)</span>
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
