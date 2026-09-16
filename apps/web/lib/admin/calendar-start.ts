/**
 * L'amorce de démarrage du planning — ce qui manque, et où aller le poser (#751).
 *
 * ## Le défaut que ce module corrige
 *
 * Le planning n'avait qu'un seul état vide, et il tenait le même discours à
 * deux situations qui n'ont rien à voir :
 *
 * - **une journée creuse** dans un salon installé — le lendemain, ou la vue
 *   semaine, montreront effectivement autre chose ;
 * - **un établissement neuf**, sans prestation ni fiche praticien — où le
 *   lendemain et la vue semaine sont vides à l'identique, indéfiniment.
 *
 * Renvoyer la gérante au jour suivant dans le second cas est un cul-de-sac :
 * l'action proposée ne peut rien changer, et ce dont elle a besoin — créer une
 * prestation, ouvrir une fiche praticien — n'était ni nommé ni atteignable
 * depuis cet écran. `docs/design/appointments/states.md`, « Règles générales » :
 * *« Vide : toujours accompagné d'une explication et d'au moins une action pour
 * sortir de l'impasse. Un cul-de-sac muet fait abandonner. »*
 *
 * ## Ce qui décide, et ce qui ne décide pas
 *
 * Deux comptes, et rien d'autre : combien de prestations actives, combien de
 * fiches praticien. Ni la vue, ni la date — précisément parce que le défaut
 * était de laisser croire qu'en changer suffirait.
 *
 * Les quatre combinaisons sont couvertes, et chacune arrive vraiment :
 *
 * | catalogue | praticiens | ce que l'écran dit |
 * |---|---|---|
 * | vide | vide | le salon n'est pas installé — deux liens |
 * | garni | vide | aucun agenda pour accueillir un rendez-vous — un lien |
 * | vide | garni | le catalogue est vide — un lien (c'est l'état du tiroir) |
 * | garni | garni | la période est creuse — aucun lien, l'écran garde sa flèche |
 *
 * La dernière ligne est ce qui laisse au planning sa navigation de période : sans
 * lien à proposer, l'état vide reste celui d'avant ce ticket, et son conseil
 * — changer de période — redevient vrai. Elle ne lui vient pourtant jamais de
 * cet écran : depuis #758 le planning bascule sur son état vide dès que la
 * période est creuse **et** qu'un lien manque à poser (`hasNothingToPlan`), si
 * bien que la dernière ligne — rien ne manque — n'y est par construction pas
 * atteignable. Ce qui lui rend alors son bouton de période, c'est
 * `calendarPeriodEmptyState` : l'écran s'y replie dès qu'un doute pèse sur les
 * comptes. Les trois premières lignes, elles, s'atteignent bel et bien depuis le
 * planning — y compris « le catalogue est vide », qu'un salon pourvu de fiches
 * praticien mais sans prestation y rend depuis #758. La quatrième reste vraie
 * pour le tiroir et pour tout appelant qui décide autrement.
 *
 * ## Pourquoi les chemins sont passés plutôt qu'importés
 *
 * `lib/` ne remonte pas vers `app/` : les chemins du back-office vivent dans
 * `app/(admin)/[tenantSlug]/admin/paths.ts` et `…/personnel/paths.ts`, et c'est
 * l'appelant qui les lit. Ce module reste alors du calcul pur — testable sans
 * routeur, sans établissement, et sans monter un seul composant.
 */

/** Une amorce : un libellé, et l'écran où elle mène. */
export interface CalendarStartLink {
  /** Clé de rendu stable — jamais l'index d'un tableau. */
  readonly key: 'catalogue' | 'personnel';
  readonly label: string;
  readonly href: string;
}

/** Ce que l'état vide du planning affiche. */
export interface CalendarStartState {
  readonly title: string;
  readonly description: string;
  /**
   * Les amorces, dans l'ordre où on les pose : le catalogue d'abord — une
   * prestation existe avant l'agenda qui la vend. Vide quand rien ne manque : la
   * période est alors simplement creuse, et l'écran garde son propre bouton.
   */
  readonly links: readonly CalendarStartLink[];
}

/** Les deux écrans vers lesquels l'amorce peut mener. */
export interface CalendarStartPaths {
  /** Catalogue des prestations. */
  readonly catalog: string;
  /** Personnel et horaires. */
  readonly staff: string;
}

/** Combien de prestations actives et de fiches praticien l'écran a reçues. */
export interface CalendarStartCounts {
  readonly serviceCount: number;
  readonly staffCount: number;
}

/**
 * Le lien vers le catalogue — partagé par le planning et par le tiroir.
 *
 * Il mène à la **liste** et non au formulaire de création : celui-ci est réservé
 * au rang gérant, tandis que le planning s'ouvre dès le rang praticien. Une
 * amorce qui finirait sur « accès réservé » serait un second cul-de-sac.
 */
export function catalogStartLink(catalogHref: string): CalendarStartLink {
  return { key: 'catalogue', label: 'Ouvrir le catalogue', href: catalogHref };
}

/** Le lien vers le personnel — même règle : la liste, lisible à tout rang. */
export function staffStartLink(staffHref: string): CalendarStartLink {
  return { key: 'personnel', label: 'Ouvrir le personnel', href: staffHref };
}

/**
 * L'énoncé du catalogue vide — écrit **une fois**, pour la grille et pour le
 * tiroir.
 *
 * C'est la même impasse, vue depuis la grille plutôt que depuis le formulaire,
 * et deux formulations rivales pour une seule cause feraient douter qu'il
 * s'agisse de la même chose. Le tiroir le recopiait : la première correction
 * apportée à l'une des deux copies aurait fait diverger l'autre en silence.
 */
export const CATALOG_EMPTY_TITLE = 'Le catalogue est vide';
export const CATALOG_EMPTY_DESCRIPTION =
  'Un rendez-vous se pose sur une prestation. Créez-en au moins une — durée et prix compris — avant de planifier.';

/**
 * L'état vide d'avant ce ticket : la période est creuse, et rien n'est affirmé
 * de l'installation du salon.
 *
 * C'est ce que l'écran doit dire quand il **ne sait pas** ce qui manque — un
 * catalogue ou un répertoire que l'API n'a pas rendus arrivent vides jusqu'ici
 * (`calendrier/page.tsx` retombe sur une liste vide plutôt que de fermer
 * l'agenda), et un salon installé s'entendrait alors dire qu'il ne l'est pas.
 * Sans lien à proposer, l'écran garde son bouton de période.
 *
 * Son conseil — « changez de période, ou passez en vue semaine » — reste vrai
 * dans les deux vues du planning après #758 : c'est justement parce que ce bloc
 * ne porte aucun lien que la vue semaine y garde sa grille, et qu'on peut donc
 * l'y envoyer. Seule la vue jour le rend, faute de colonne à dessiner.
 */
export function calendarPeriodEmptyState(): CalendarStartState {
  return {
    title: 'Aucun rendez-vous sur cette période',
    description:
      'Rien n’est encore posé ici. Changez de période, ou passez en vue semaine pour voir plus large.',
    links: [],
  };
}

/**
 * Ce qu'un planning vide doit dire, et ce qu'il doit proposer.
 *
 * Le titre nomme la situation plutôt que son symptôme : « ce salon n'est pas
 * encore installé » explique pourquoi demain sera identique, là où « aucun
 * rendez-vous sur cette période » laissait croire à un creux passager.
 */
export function calendarStartState(
  counts: CalendarStartCounts,
  paths: CalendarStartPaths,
): CalendarStartState {
  const missingCatalog = counts.serviceCount === 0;
  const missingStaff = counts.staffCount === 0;

  if (missingCatalog && missingStaff) {
    return {
      title: 'Ce salon n’est pas encore installé',
      description:
        'Un rendez-vous se pose sur une prestation, dans l’agenda d’un praticien. Tant que l’un des deux manque, ce planning reste vide — demain comme la semaine prochaine.',
      links: [catalogStartLink(paths.catalog), staffStartLink(paths.staff)],
    };
  }

  if (missingStaff) {
    return {
      title: 'Aucune fiche praticien n’est ouverte',
      description:
        'Le catalogue est prêt, mais un rendez-vous a besoin de l’agenda de quelqu’un. Ouvrez une fiche praticien : le planning lui donnera sa colonne.',
      links: [staffStartLink(paths.staff)],
    };
  }

  if (missingCatalog) {
    // Le même énoncé que le tiroir, et littéralement le même texte : voir
    // `CATALOG_EMPTY_TITLE`.
    return {
      title: CATALOG_EMPTY_TITLE,
      description: CATALOG_EMPTY_DESCRIPTION,
      links: [catalogStartLink(paths.catalog)],
    };
  }

  return calendarPeriodEmptyState();
}
