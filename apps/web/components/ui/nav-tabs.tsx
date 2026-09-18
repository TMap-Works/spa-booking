import Link from 'next/link';

export interface NavTabItem {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}

interface NavTabsProps {
  /** Nom du repère de navigation — « Mon compte ». */
  readonly label: string;
  readonly items: readonly NavTabItem[];
}

/**
 * Onglets qui mènent à des pages (#1044) — la navigation de l'espace client.
 *
 * Même allure que `Tabs`, mais ce sont des liens dans un `<nav>` : l'onglet
 * actif porte `aria-current="page"`, qui dit « vous êtes ici » là où
 * `aria-selected` promettrait un panneau dans la page. Server Component : aucun
 * état, l'onglet actif vient de l'adresse.
 */
export function NavTabs({ label, items }: NavTabsProps) {
  return (
    <nav className="spa-tabs spa-tabs--underline spa-tabs--nav" aria-label={label}>
      <ul className="spa-tabs__list">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              className="spa-tabs__tab"
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
