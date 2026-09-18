'use client';

import { useRef, type KeyboardEvent } from 'react';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** Effectif affiché à côté du libellé — « Massages · 4 » (BM-SERVICE-05). */
  readonly count?: number;
}

interface TabsProps {
  /** Nom de la liste d'onglets pour les lecteurs d'écran. */
  readonly label: string;
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  /** Préfixe des `id` — relie chaque onglet à son panneau (`tabPanelProps`). */
  readonly idPrefix: string;
  /** `underline` pour des rubriques, `segmented` pour un filtre de liste. */
  readonly variant?: 'underline' | 'segmented';
}

export function tabId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`;
}

export function tabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`;
}

/** Les attributs du panneau que commande l'onglet `id`. */
export function tabPanelProps(idPrefix: string, id: string) {
  return {
    id: tabPanelId(idPrefix, id),
    role: 'tabpanel',
    'aria-labelledby': tabId(idPrefix, id),
    tabIndex: 0,
  } as const;
}

/**
 * Onglets d'une même page (#1044) — catégories de prestations, filtre d'une
 * liste. Pour naviguer entre des pages, c'est `NavTabs` : un onglet ARIA
 * promet un panneau dans la page, pas un changement d'adresse.
 *
 * Motif « tabs » de l'APG : un seul arrêt de tabulation (l'onglet actif), les
 * flèches passent d'un onglet à l'autre et l'activent, Début et Fin vont aux
 * extrémités. À 360 px, la rangée défile horizontalement plutôt que de passer
 * à la ligne (BM-SERVICE-02).
 */
export function Tabs({ label, items, value, onChange, idPrefix, variant = 'underline' }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);

  const focusTab = (index: number): void => {
    const target = items[index];
    if (target === undefined) {
      return;
    }
    onChange(target.id);
    const tabs = list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = items.findIndex((item) => item.id === value);
    const last = items.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: current >= last ? 0 : current + 1,
      ArrowLeft: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    focusTab(next);
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={`spa-tabs spa-tabs--${variant}`}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.id)}
            className="spa-tabs__tab"
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, item.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count === undefined ? null : (
              <span className="spa-tabs__count">
                <span className="spa-visually-hidden"> · </span>
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
