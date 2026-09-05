'use client';

import type { UserRole } from '@spa/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AdminLogoutButton } from './admin-logout-button';
import { EstablishmentSwitcher, type AdminEstablishment } from './establishment-switcher';
import { adminNavigation, isCurrentEntry, roleLabel } from './navigation';

/**
 * La barre latérale du back-office — navigation, contexte du salon, session
 * (#48).
 *
 * ## Pourquoi ce composant est client, et lui seul
 *
 * Il lui faut `usePathname()` : marquer l'entrée courante est la seule chose
 * qu'un rendu serveur ne sait pas faire ici, un layout n'étant pas rejoué à
 * chaque navigation. Le repère resterait donc figé sur la première page ouverte
 * — précisément l'écran qu'on quitte.
 *
 * Tout ce qui pouvait rester serveur y est resté : le layout lit la session et
 * l'établissement, et ne passe ici que des chaînes. **Aucun jeton ne traverse
 * cette frontière** — ce composant n'en reçoit pas, n'en lit pas, et les props
 * d'un Client Component sont sérialisées dans le HTML (web-frontend §2).
 *
 * ## Ce que le rail ne fait pas
 *
 * Il ne garde rien. Un menu qui masque une entrée n'interdit pas d'en taper
 * l'URL, et la seule frontière qui compte est celle de l'API. Le rail n'est pas
 * non plus rendu du tout tant qu'il n'y a pas de session : c'est le layout qui
 * en décide, et l'écran de connexion se sert donc sans navigation — il n'y a
 * nulle part où aller.
 */
interface AdminRailProps {
  readonly tenantSlug: string;
  readonly establishments: readonly AdminEstablishment[];
  /** Fuseau de l'établissement — toutes les heures du back-office y sont écrites. */
  readonly timeZone: string;
  /** Le compte connecté, tel qu'on l'annonce : « Hasina R. ». */
  readonly userName: string;
  readonly role: UserRole;
}

export function AdminRail({
  tenantSlug,
  establishments,
  timeZone,
  userName,
  role,
}: AdminRailProps) {
  const pathname = usePathname();
  const entries = adminNavigation(tenantSlug, role);
  const brand = establishments.find((salon) => salon.slug === tenantSlug)?.name ?? tenantSlug;

  return (
    <nav className="spa-admin__rail" aria-label="Sections du tableau de bord">
      <span className="spa-admin__brand">{brand}</span>

      <div className="spa-admin__nav">
        {entries.map((entry) =>
          entry.href === null ? (
            /*
             * Une entrée sans écran est annoncée, pas cliquable : un `<span>`
             * plutôt qu'un `<a>` la sort de l'ordre de tabulation et du rôle
             * « lien », et `aria-disabled` le dit à qui écoute. Le texte masqué
             * porte la raison — sans lui, un lecteur d'écran n'annoncerait qu'un
             * mot inerte, sans expliquer pourquoi il ne mène nulle part.
             */
            <span aria-disabled="true" className="spa-admin__nav-link" key={entry.key}>
              {entry.label}
              <span className="spa-visually-hidden">
                {` — ${entry.upcoming ?? 'écran à venir'}`}
              </span>
            </span>
          ) : (
            <Link
              aria-current={isCurrentEntry(pathname, entry.href) ? 'page' : undefined}
              className="spa-admin__nav-link"
              href={entry.href}
              key={entry.key}
            >
              {entry.label}
            </Link>
          ),
        )}
      </div>

      <div className="spa-admin__rail-footer">
        <EstablishmentSwitcher currentSlug={tenantSlug} establishments={establishments} />
        {/*
         * Le fuseau est affiché en permanence et non au survol : toutes les
         * heures du back-office sont écrites dans celui du salon, et un
         * opérateur qui consulte depuis ailleurs doit pouvoir le constater sans
         * le chercher.
         */}
        <span>Fuseau du salon : {timeZone}</span>
        <span>
          Connecté·e : {userName}, {roleLabel(role)}
        </span>
        <AdminLogoutButton tenantSlug={tenantSlug} />
      </div>
    </nav>
  );
}
