'use client';

import { useTranslations } from 'next-intl';
import { useRef, type KeyboardEvent } from 'react';

import { Icon } from '@/components/ui/icon';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  /** Effectif affiché à côté du libellé — « Massages · 4 » (BM-SERVICE-05). */
  readonly count?: number;
  /**
   * L'onglet porte la **marque** : ce qui a été retenu est dans son panneau,
   * ouvert ou non (`BM-SERVICE-06`, « la catégorie porte aussi la marque »).
   *
   * Sans état retenu, l'écran oublie le choix dès qu'on change d'onglet. C'est
   * un état distinct de `aria-selected` : l'onglet ouvert est celui qu'on
   * regarde, l'onglet marqué celui où se trouve ce qu'on a choisi.
   */
  readonly marked?: boolean;
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
  /**
   * Ce que dit la marque d'un onglet `marked`, en toutes lettres.
   *
   * Le glyphe est décoratif (`aria-hidden`) : une coche lue « coche » à la suite
   * d'un libellé n'apprend rien, et `label` est une `string` où l'on ne peut pas
   * glisser de texte alternatif. La phrase se range donc en lecture d'écran
   * seule, à la suite du libellé et de l'effectif — « Massages · 2 · contient
   * votre choix ». À préciser quand « choix » ne nomme pas ce qui est retenu.
   *
   * **Facultatif**, et son absence n'est plus un littéral français (#1234) : le
   * défaut vient de `ui.tabs.marked`, comme les autres mots de cette brique
   * partagée. Un appelant qui le précise reste responsable de le traduire dans
   * son propre namespace — c'est justement parce que le mot juste dépend de
   * l'écran que cette propriété existe.
   */
  readonly markedLabel?: string;
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
 *
 * Un onglet peut porter la **marque** de ce qui a été retenu dans son panneau
 * (`marked`, #1079) : une coche, le même signe que les lignes et les cartes du
 * tunnel emploient déjà pour dire « retenu ». Un signe, et non une nuance de
 * couleur — WCAG 1.4.1 refuse que la couleur seule porte une information.
 */
export function Tabs({
  label,
  items,
  value,
  onChange,
  idPrefix,
  variant = 'underline',
  markedLabel,
}: TabsProps) {
  const t = useTranslations('ui');
  const list = useRef<HTMLDivElement>(null);
  // Le défaut est lu ici et non en valeur par défaut de paramètre : un crochet
  // ne s'appelle pas dans une liste de paramètres, et `ui.tabs.marked` doit
  // suivre la langue de la session comme le reste de la brique.
  const marked = markedLabel ?? t('tabs.marked');

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
            {item.marked !== true ? null : (
              <span className="spa-tabs__mark">
                <Icon name="check" className="spa-tabs__mark-icon" />
                <span className="spa-visually-hidden"> · {marked}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
