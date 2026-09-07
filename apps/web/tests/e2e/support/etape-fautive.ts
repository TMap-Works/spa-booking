/**
 * Désigner l'étape fautive — cinquième critère de #80.
 *
 * ## Le problème que ce module résout
 *
 * Un parcours critique qui rougit en CI ne rend, par défaut, qu'une pile
 * d'assertions et un `expect(locator).toBeVisible() failed`. Le relecteur doit
 * alors ouvrir la trace pour savoir si la réservation n'a pas abouti, si la
 * confirmation n'est pas passée, ou si c'est l'encaissement qui a lâché — trois
 * pannes de gravités très différentes, qui ne se traitent pas de la même façon
 * et n'appellent pas les mêmes gens.
 *
 * Le critère demande que le rapport « identifie l'étape fautive sans
 * ambiguïté ». Ce module extrait cette étape de l'arbre d'exécution que
 * Playwright rend, et la met en toutes lettres en tête du rapport.
 *
 * ## Pourquoi il ne dépend pas de Playwright
 *
 * Les types sont déclarés ici, structurellement compatibles avec `TestStep` et
 * `TestResult`. Deux effets, tous deux voulus :
 *
 * - la logique se teste **au harnais unitaire du dépôt**
 *   (`apps/web/tests/unit/e2e-etape-fautive.test.ts`, joué par `npm run verify`)
 *   plutôt que d'exiger une exécution E2E en échec pour être vérifiée — un
 *   rapport d'échec qu'on ne sait éprouver qu'en cassant le produit n'est pas un
 *   rapport auquel on peut se fier ;
 * - le module reste lisible sans connaître l'API des rapporteurs.
 */

/**
 * Une étape telle que Playwright la rend, réduite à ce dont ce module a besoin.
 *
 * `category` vaut `'test.step'` pour les étapes que la suite déclare
 * elle-même, et `'expect'`, `'pw:api'` ou `'hook'` pour celles que le moteur
 * insère. La distinction porte tout le module : c'est la première qui nomme le
 * parcours en termes métier, la seconde qui dit ce qui a matériellement lâché.
 */
export interface EtapeExecutee {
  readonly title: string;
  readonly category: string;
  readonly error?: { readonly message?: string | undefined } | undefined;
  readonly location?:
    | { readonly file: string; readonly line: number; readonly column: number }
    | undefined;
  readonly steps?: readonly EtapeExecutee[] | undefined;
}

/** Le verdict : où le parcours s'est arrêté, et sur quoi. */
export interface EtapeFautive {
  /** Les étapes déclarées, de la plus englobante à la plus fine. */
  readonly chemin: readonly string[];
  /** L'étape déclarée la plus fine — celle à nommer dans le rapport. */
  readonly titre: string;
  /** Ce qui a matériellement lâché, quand ce n'est pas l'étape déclarée elle-même. */
  readonly detail: string | null;
  /** La première ligne du message d'erreur, débarrassée des codes ANSI. */
  readonly message: string | null;
  /** `fichier:ligne:colonne`, quand Playwright l'a rendue. */
  readonly emplacement: string | null;
}

const ETAPE_DECLAREE = 'test.step';

/**
 * Retire les séquences ANSI que Playwright met dans ses messages.
 *
 * Sans cela, le rapport recopié dans un commentaire de PR ou dans un journal de
 * jalon porte des `ESC[2m` au milieu des phrases — et la ligne censée être la
 * plus lisible du rapport devient la moins lisible.
 */
// ESC construit par code plutot que litteral : un octet de controle dans une
// source TypeScript se recopie mal d'un editeur a l'autre, et obligerait a
// desactiver no-control-regex pour une regex qui se lit tres bien ainsi.
const SEQUENCES_ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function nettoyer(message: string): string {
  return message.replace(SEQUENCES_ANSI, '').trim();
}

function premiereLigne(message: string | undefined): string | null {
  if (message === undefined) {
    return null;
  }
  const propre = nettoyer(message);
  if (propre === '') {
    return null;
  }
  return propre.split('\n')[0] ?? null;
}

function emplacementDe(etape: EtapeExecutee): string | null {
  const { location } = etape;
  if (location === undefined) {
    return null;
  }
  return `${location.file}:${location.line}:${location.column}`;
}

/**
 * La branche en échec, de la racine à la feuille.
 *
 * Playwright propage l'erreur d'une étape à ses parents : la branche fautive est
 * donc celle qu'on suit en descendant toujours dans le **premier** enfant en
 * erreur. Descendre dans tous les enfants donnerait la liste des conséquences,
 * pas la cause.
 */
function brancheEnEchec(etapes: readonly EtapeExecutee[]): EtapeExecutee[] {
  const fautive = etapes.find((etape) => etape.error !== undefined);
  if (fautive === undefined) {
    return [];
  }
  return [fautive, ...brancheEnEchec(fautive.steps ?? [])];
}

/**
 * L'étape fautive d'une exécution, ou `null` si aucune étape n'a échoué.
 *
 * `null` n'est pas un cas dégénéré à masquer : il couvre l'échec survenu hors de
 * toute étape — délai global dépassé, `beforeAll` qui lève, processus tué. Le
 * rapport doit alors le dire, et c'est `formaterEtapeFautive` qui s'en charge.
 */
export function etapeFautive(etapes: readonly EtapeExecutee[]): EtapeFautive | null {
  const branche = brancheEnEchec(etapes);
  if (branche.length === 0) {
    return null;
  }

  const declarees = branche.filter((etape) => etape.category === ETAPE_DECLAREE);
  const feuille = branche[branche.length - 1];
  if (feuille === undefined) {
    return null;
  }

  const derniereDeclaree = declarees[declarees.length - 1];
  const titre = derniereDeclaree?.title ?? feuille.title;
  const ancrage = derniereDeclaree ?? feuille;

  return {
    chemin: declarees.map((etape) => etape.title),
    titre,
    detail: feuille === derniereDeclaree ? null : feuille.title,
    message: premiereLigne(feuille.error?.message),
    emplacement: emplacementDe(ancrage) ?? emplacementDe(feuille),
  };
}

/** Ce qu'il faut savoir du test pour en écrire l'en-tête. */
export interface TestEnEchec {
  /** Le chemin du test : fichier, `describe` imbriqués, titre. */
  readonly titres: readonly string[];
  /** L'erreur de plus haut niveau, quand aucune étape ne porte la faute. */
  readonly message?: string | undefined;
  /** Les pièces jointes à signaler au relecteur — trace, capture, vidéo. */
  readonly artefacts?: readonly string[] | undefined;
}

const LARGEUR = 78;
const FILET = '─'.repeat(LARGEUR);

/**
 * Le bloc que la CI affiche, et que le relecteur lit sans ouvrir la trace.
 *
 * Une seule ligne compte vraiment — `ÉTAPE FAUTIVE :`. Tout le reste la
 * qualifie. C'est délibérément verbeux au regard d'un rapporteur habituel : ce
 * qu'on optimise ici n'est pas la place prise dans le journal, c'est le temps
 * qu'un humain met à comprendre lequel des trois maillons du parcours a cédé.
 */
export function formaterEtapeFautive(test: TestEnEchec, fautive: EtapeFautive | null): string {
  const lignes: string[] = [FILET, `ÉCHEC — ${test.titres.join(' › ')}`];

  if (fautive === null) {
    lignes.push(
      'ÉTAPE FAUTIVE : aucune — le test a échoué hors de toute étape déclarée.',
      "  ↳ délai global dépassé, échec d'un hook, ou processus interrompu.",
    );
    const message = premiereLigne(test.message);
    if (message !== null) {
      lignes.push(`  erreur : ${message}`);
    }
  } else {
    lignes.push(`ÉTAPE FAUTIVE : ${fautive.titre}`);

    if (fautive.chemin.length > 1) {
      lignes.push(`  ↳ dans : ${fautive.chemin.slice(0, -1).join(' › ')}`);
    }
    if (fautive.detail !== null) {
      lignes.push(`  ↳ a lâché sur : ${fautive.detail}`);
    }
    if (fautive.emplacement !== null) {
      lignes.push(`  fichier : ${fautive.emplacement}`);
    }
    if (fautive.message !== null) {
      lignes.push(`  erreur : ${fautive.message}`);
    }
  }

  const artefacts = test.artefacts ?? [];
  if (artefacts.length > 0) {
    lignes.push(`  artefacts : ${artefacts.join(', ')}`);
  }

  lignes.push(FILET);
  return lignes.join('\n');
}
