import type { Locale } from '@spa/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

import en from '@/messages/en/public-exits.json';
import fr from '@/messages/fr/public-exits.json';

/**
 * Les **sorties** d'un écran du parcours public (#739).
 *
 * ## Ce qu'elle répare
 *
 * La vitrine d'un établissement n'avait qu'un seul lien sortant, « Prendre
 * rendez-vous ». Une cliente déjà inscrite qui arrivait sur `/{slug}` ne pouvait
 * atteindre son espace qu'en connaissant l'URL, ou en entrant d'abord dans le
 * tunnel — dont le pied de page, lui, portait le lien. Or le compte client avec
 * historique est dans le périmètre MVP (CDC §1.4), et la porte d'entrée publique
 * de l'établissement doit y mener comme elle mène à la réservation.
 *
 * ## Pourquoi un composant partagé plutôt qu'un lien de plus
 *
 * Trois écrans du parcours client nomment déjà les mêmes destinations — la
 * vitrine, le tunnel, l'espace client. Les laisser écrire chacun leur libellé,
 * c'est ce qui produit « Mes rendez-vous » ici et « Mon compte » là pour la même
 * page — et c'est précisément ce que l'espace client faisait encore, son pied de
 * page réécrivant la chaîne au lieu de la lire ici (#749). Les libellés sont donc
 * tenus ici, une fois, et une destination s'attrape par sa clé.
 *
 * Les **chemins**, eux, restent à l'appelant : les composants de ce dossier ne
 * connaissent pas l'arborescence des routes, c'est la page qui la tient
 * (`salon-data.ts`). Même règle que `SalonHeader` et son `reservationHref`.
 *
 * ## Server Component
 *
 * Rien ici n'a d'état ni d'écouteur : ce sont des `<Link>`. Sur la vitrine, ce
 * bandeau précède le LCP — un `"use client"` le ferait rendre deux fois pour
 * deux ancres (skill web-frontend §1).
 *
 * ## Les mots viennent du catalogue (#845)
 *
 * Le namespace `public-exits` les tient, dans les deux langues. Il est lu de
 * deux façons, pour la même raison que `lib/appointment-status.ts` : le
 * composant passe par `useTranslations`, et `publicExitLabels(locale)` par un
 * **import direct des deux fichiers JSON** — ce registre est lu depuis
 * `app/salon-doors.ts`, un module sans React qu'un crochet rendrait
 * inappelable. Les deux lectures visent les mêmes fichiers : il n'y a qu'une
 * écriture de ces libellés.
 */

/** Les destinations que le parcours public sait nommer. */
export type PublicExitKey = 'vitrine' | 'reservation' | 'compte';

/** Les catalogues, dans les deux langues — la même source que le composant. */
const CATALOG = { fr, en } as const;

/**
 * La langue employée quand l'appelant n'en passe pas.
 *
 * `'fr'`, et c'est **transitoire** — même arbitrage que `FALLBACK_LOCALE` de
 * `lib/appointment-status.ts`, et pour les mêmes raisons : les six surfaces qui
 * lisent ce registre (vitrine, tunnel, accueil de la plateforme, connexion et
 * invitation du back-office, page d'erreur de l'espace client) sont hors de
 * l'empreinte de #845 et passeront la langue résolue dans leur propre ticket de
 * l'épique #843. Ce n'est pas `DEFAULT_LOCALE` du contrat, qui vaut `en` : le
 * défaut d'ici garde le comportement d'avant le ticket plutôt que de basculer
 * en anglais des écrans dont personne n'a encore relu la traduction.
 */
const FALLBACK_LOCALE: Locale = 'fr';

/**
 * Le libellé de chaque destination — **source unique**.
 *
 * Toujours pas « Se connecter » : `/{slug}/compte` redirige de lui-même vers la
 * connexion quand aucune session n'est ouverte (`compte/session.ts`). Un seul
 * libellé sert donc la cliente inscrite et celle qui ne l'est pas, et il dit où
 * elle va plutôt que la formalité qu'il faut traverser pour y arriver.
 *
 * ## « Mon compte » et non plus « Mes rendez-vous » (#749)
 *
 * L'audit `d20260916-1` relève au titre de `ds:libelles` qu'un lien nommait
 * « Mes rendez-vous » une destination dont le titre est « Mon compte »
 * (`(account)/…/compte/layout.tsx`, `<h1>` et `metadata.title`). Un lien porte le
 * nom de sa destination — WCAG 2.4.4, et 3.2.4 pour la constance d'un écran à
 * l'autre —, et des deux côtés de l'écart c'est le libellé qui bouge : le titre
 * couvre les **cinq** écrans de l'espace — liste, coordonnées, report, connexion,
 * inscription —, dont trois ne montrent aucun rendez-vous.
 *
 * Le CDC §1.4 nomme d'ailleurs la fonctionnalité « compte client avec
 * historique », et le benchmark (BM-COMPTE-01) décrit « Mes rendez-vous » comme
 * une **entrée du menu** de l'espace, pas comme le nom de l'espace lui-même.
 *
 * Exporté parce que deux destinations sont aussi nommées hors d'une barre de
 * sorties — l'appel à l'action de `SalonHeader` est un bouton, pas un lien de
 * navigation, et le pied de page de l'espace client rend ses sorties lui-même —
 * mais désignent les mêmes pages. Les laisser réécrire la chaîne, c'est
 * exactement ce que ce registre existe pour empêcher.
 */
export function publicExitLabels(
  locale: Locale = FALLBACK_LOCALE,
): Readonly<Record<PublicExitKey, string>> {
  return CATALOG[locale].exits;
}

/**
 * La même table, figée en français.
 *
 * @deprecated Transitoire (#845). Les six surfaces qui la lisent passeront à
 * `publicExitLabels(locale)` dans leur propre ticket de l'épique #843 ; elle
 * disparaît avec la dernière. La garder évite de basculer en anglais des écrans
 * dont la traduction n'a pas encore été relue, et surtout de sortir de
 * l'empreinte de ce ticket pour aller les réécrire.
 */
export const PUBLIC_EXIT_LABELS: Readonly<Record<PublicExitKey, string>> =
  CATALOG[FALLBACK_LOCALE].exits;

export interface PublicExit {
  readonly key: PublicExitKey;
  /** Chemin construit par l'appelant, qui seul connaît les routes. */
  readonly href: string;
}

interface PublicExitsProps {
  readonly exits: readonly PublicExit[];
  /**
   * `header` pose la barre au-dessus du contenu, `footer` en dessous.
   *
   * L'élément rendu suit : un `<nav>` en tête — c'est une navigation, et un
   * lecteur d'écran doit pouvoir l'atteindre par sa liste de repères — et un
   * `<footer>` en pied, où le même jeu de liens n'est plus qu'un pied de page.
   */
  readonly variant: 'header' | 'footer';
}

export function PublicExits({ exits, variant }: PublicExitsProps) {
  // Appelé avant le retour anticipé : un crochet de React ne se saute pas
  // (`react-hooks/rules-of-hooks`), et `useTranslations` en est un.
  const t = useTranslations('public-exits');

  if (exits.length === 0) {
    return null;
  }

  const className = `spa-public-exits spa-public-exits--${variant}`;
  const links = exits.map((exit) => (
    <Link className="spa-public-exits__link" key={exit.key} href={exit.href}>
      {t(`exits.${exit.key}`)}
    </Link>
  ));

  if (variant === 'footer') {
    return <footer className={className}>{links}</footer>;
  }

  return (
    <nav className={className} aria-label={t('navLabel')}>
      {links}
    </nav>
  );
}
