import type { ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';

interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: string;
  /** Le niveau du titre dépend de l'écran : `p` quand il n'ouvre pas de section. */
  readonly titleAs?: 'h2' | 'h3' | 'p';
  /** Une phrase : pourquoi c'est vide, ou ce qu'on peut faire. */
  readonly children?: ReactNode;
  /** L'action qui sort de l'état vide — un lien ou un bouton. */
  readonly action?: ReactNode;
}

/**
 * État vide (#1044).
 *
 * « Un écran vide sans explication est un bug d'UX » (skill web-frontend §6) —
 * et un texte centré sans repère ne se voit guère mieux. Le pictogramme dit
 * l'objet absent au premier coup d'œil, le titre le nomme, l'action en sort.
 */
export function EmptyState({ icon = 'calendar', title, titleAs: Title = 'p', children, action }: EmptyStateProps) {
  return (
    <div className="spa-empty">
      <span className="spa-empty__icon">
        <Icon name={icon} />
      </span>
      <Title className="spa-empty__title">{title}</Title>
      {children === undefined ? null : <div className="spa-empty__text">{children}</div>}
      {action === undefined ? null : <div className="spa-empty__action">{action}</div>}
    </div>
  );
}
