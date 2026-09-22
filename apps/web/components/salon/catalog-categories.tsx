'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Tabs, tabPanelId, tabPanelProps } from '@/components/ui/tabs';

/** Une rubrique et le panneau, **rendu côté serveur**, qui la contient. */
export interface CatalogPanel {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly content: ReactNode;
}

/** `decodeURIComponent` ne jette pas sur une adresse bricolée. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface CatalogCategoriesProps {
  readonly panels: readonly CatalogPanel[];
  /** Préfixe des `id` — relie chaque onglet à son panneau. */
  readonly idPrefix: string;
}

/**
 * Les rubriques du catalogue en onglets (#1046, BM-SERVICE-02 et BM-SERVICE-05).
 *
 * ## Pourquoi cet îlot existe
 *
 * L'audit `d20260918-1` relève que le catalogue s'empile en une seule coulée :
 * « avec plus de trois catégories, peut-on sauter à l'une d'elles sans défiler
 * tout le catalogue ? » BM-SERVICE-02 y répond par une rangée de pastilles qui
 * défile horizontalement au pouce, et BM-SERVICE-05 demande que chacune dise
 * combien elle contient. `Tabs` (#1044) fait les deux, clavier compris — motif
 * « tabs » de l'APG.
 *
 * ## Ce qui reste rendu par le serveur, et pourquoi c'est l'essentiel
 *
 * `content` n'est pas une fonction de rendu : ce sont des éléments **déjà
 * rendus** par `ServiceCatalog`, qui est un Server Component, et qui traversent
 * la frontière comme n'importe quel enfant. Aucune ligne de prestation n'est
 * donc peinte par le navigateur, et le catalogue — la partie indexable de la
 * page — part du serveur en entier, tous panneaux compris. L'îlot ne porte que
 * l'état « quelle rubrique est ouverte », c'est-à-dire quelques octets.
 *
 * C'est aussi ce qui garde le référencement : les panneaux masqués sont dans le
 * HTML servi, `hidden` ne les en retire pas. Et les données structurées
 * (`structured-data.tsx`) publient de toute façon le catalogue complet.
 *
 * ## L'ancre d'une prestation ouvre sa rubrique
 *
 * Chaque offre du graphe porte `…/salon#{slug}` (`structured-data.tsx`), et
 * cette adresse-là circule : un résultat de recherche, un lien partagé. Sans
 * rien de plus, l'ancre d'une prestation rangée hors de la première rubrique
 * tomberait dans un panneau `hidden` — donc `display: none` —, le navigateur
 * renoncerait à l'atteindre, et la visiteuse arriverait en haut d'une page qui
 * ne montre même pas la prestation qu'on lui a promise. L'îlot ouvre donc la
 * rubrique qui contient l'ancre, puis l'y mène.
 *
 * Un hachage n'est traité qu'une fois : sans cette garde, un changement d'onglet
 * ultérieur serait immédiatement défait par l'effet, et la rangée d'onglets ne
 * répondrait plus tant que l'adresse porterait son ancre.
 *
 * ## Une seule rubrique n'a pas d'onglet
 *
 * L'appelant ne monte cet îlot qu'à partir de deux rubriques : un onglet unique
 * n'offre aucun choix et ajouterait une rangée de contrôles là où il n'y a rien
 * à contrôler.
 *
 * ## La langue (#846)
 *
 * Un seul mot est à lui : le nom accessible de la rangée d'onglets. Les
 * **libellés des onglets**, eux, sont les rubriques du salon — ils arrivent dans
 * `panels` et ne se traduisent pas. Client Component, donc `useTranslations` :
 * les messages lui viennent du `NextIntlClientProvider` posé par le layout
 * racine.
 */
export function CatalogCategories({ panels, idPrefix }: CatalogCategoriesProps) {
  const t = useTranslations('booking');
  // Le premier panneau, et non « toutes les rubriques » : un onglet « Toutes »
  // aurait rendu chaque prestation deux fois dans le document — une fois dans
  // son panneau, une fois dans celui du tout —, donc deux `id` d'ancre
  // identiques, que les données structurées désignent (`#massage-suedois`).
  const [current, setCurrent] = useState(panels[0]?.id ?? '');
  const handledHash = useRef<string | null>(null);

  useEffect(() => {
    const openHashedPanel = (): void => {
      const hash = window.location.hash.slice(1);

      if (hash === '' || handledHash.current === hash) {
        return;
      }

      handledHash.current = hash;

      // Un slug ne porte que de l'ASCII, mais l'adresse peut avoir été
      // pourcent-encodée en chemin : on tente les deux lectures.
      const target =
        document.getElementById(hash) ?? document.getElementById(safeDecode(hash));
      const panel = target?.closest('[role="tabpanel"]') ?? null;

      if (panel === null) {
        return;
      }

      const owner = panels.find((candidate) => tabPanelId(idPrefix, candidate.id) === panel.id);

      if (owner === undefined) {
        return;
      }

      setCurrent(owner.id);
      // Le navigateur a déjà renoncé à l'ancre — elle n'était pas peinte au
      // chargement. On l'y mène une fois le panneau ouvert.
      requestAnimationFrame(() => {
        target?.scrollIntoView();
      });
    };

    openHashedPanel();
    window.addEventListener('hashchange', openHashedPanel);

    return () => {
      window.removeEventListener('hashchange', openHashedPanel);
    };
  }, [panels, idPrefix]);

  return (
    <>
      <Tabs
        idPrefix={idPrefix}
        items={panels.map((panel) => ({ id: panel.id, label: panel.label, count: panel.count }))}
        label={t('salon.catalog.categoriesLabel')}
        onChange={setCurrent}
        value={current}
      />

      {panels.map((panel) => (
        // `spa-salon__panel` porte sa propre règle `[hidden] { display: none }` :
        // une classe qui pose `display` l'emporterait sinon sur la feuille de
        // l'agent utilisateur, et tous les panneaux resteraient visibles à la
        // fois — un défaut qu'aucun test de rendu ne voit, jsdom ne peignant
        // rien.
        <div
          key={panel.id}
          {...tabPanelProps(idPrefix, panel.id)}
          className="spa-salon__panel"
          hidden={panel.id !== current}
        >
          {panel.content}
        </div>
      ))}
    </>
  );
}
