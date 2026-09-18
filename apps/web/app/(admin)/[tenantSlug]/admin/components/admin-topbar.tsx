import { Icon } from '@/components/ui/icon';
import { ThemeToggle } from '@/components/ui/theme-toggle';

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

export function AdminTopbar({ tenantSlug, salonName, timeZone }: AdminTopbarProps) {
  return (
    <header className="spa-admin-topbar">
      <div className="spa-admin-topbar__context">
        <span className="spa-admin-topbar__eyebrow">{salonName}</span>
        {/* Pas de date sans fuseau : elle serait celle d'un autre endroit. */}
        {timeZone === null ? null : <span className="spa-admin-topbar__date">{todayIn(timeZone)}</span>}
      </div>
      <div className="spa-admin-topbar__actions">
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
