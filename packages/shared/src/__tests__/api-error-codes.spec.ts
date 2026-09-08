/**
 * Le contrat couvre-t-il vraiment ce que l'API émet ?
 *
 * ## Pourquoi ce test existe
 *
 * `ERROR_CODES` est déclaré source de vérité de l'énumération sur laquelle le
 * front branche son comportement. Rien ne le vérifiait. Les deux écritures — le
 * contrat ici, les huit familles de modules dans `apps/api` — ont donc divergé
 * pendant des mois sans qu'aucune barrière ne le dise : le contrat annonçait
 * `PAYMENT_ALREADY_CAPTURED` quand l'API servait `PAYMENT_ALREADY_SETTLED`, et
 * la branche du front ne se déclenchait jamais (#510, #536).
 *
 * Le rapatriement des familles supprime la seconde écriture. Ce test empêche
 * qu'elle revienne.
 *
 * ## Les deux côtés du contrat
 *
 * Le premier bloc garde `apps/api`, qui **émet** les codes. Le second garde
 * `apps/web`, qui les **lit** : #546 y a trouvé huit littéraux pour des codes que
 * le contrat portait déjà, et rien n'aurait empêché le neuvième. Le producteur
 * comme le consommateur n'ont plus qu'une écriture, celle d'ici.
 *
 * ## Pourquoi ici, dans `packages/shared`
 *
 * Parce que la propriété gardée est une propriété **du contrat** : c'est lui qui
 * ne doit pas perdre un code que l'API sert. La mettre dans `apps/api`
 * l'aurait rangée sous l'un des huit modules alors qu'elle les concerne tous —
 * et elle concerne désormais une application de plus.
 *
 * Ce test **lit** les sources d'`apps/api` et d'`apps/web`, il ne les importe
 * pas : le paquet partagé ne gagne aucune dépendance de code sur les
 * applications, et l'ordre de compilation ne change pas. C'est le même procédé
 * que `contract-surface.spec.ts`, qui remonte déjà à la racine du dépôt pour
 * vérifier la résolution de `@spa/shared` depuis `apps/api` et `apps/web`.
 *
 * ## Ce qu'il ne prouve pas
 *
 * Que tout code d'`ERROR_CODES` est émis — le sens inverse. Il ne peut pas : les
 * codes de transport sortent du `DomainExceptionFilter` par un statut HTTP, pas
 * d'une classe, et `CURRENCY_MISMATCH` est porté par `CurrencyMismatchError` de
 * ce paquet. La chasse aux orphelins reste une revue, faite en #536 et écrite en
 * tête de `error-codes.ts`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  APPOINTMENTS_ERROR_CODES,
  AVAILABILITY_ERROR_CODES,
  CATALOG_ERROR_CODES,
  CRM_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  PAYMENT_ERROR_CODES,
  REPORTING_ERROR_CODES,
  TRANSPORT_ERROR_CODES,
  isKnownErrorCode,
} from '../errors/error-codes';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const API_SRC = join(REPO_ROOT, 'apps', 'api', 'src');
const API_MODULES = join(API_SRC, 'modules');

/**
 * Les huit modules du CDC §2.3, et la famille du contrat que chacun possède.
 * Écrits en clair plutôt que déduits du disque : un module supprimé par accident
 * doit faire échouer ce test, pas rétrécir son périmètre en silence.
 */
const FAMILY_BY_MODULE = {
  appointments: 'APPOINTMENTS_ERROR_CODES',
  availability: 'AVAILABILITY_ERROR_CODES',
  catalog: 'CATALOG_ERROR_CODES',
  crm: 'CRM_ERROR_CODES',
  identity: 'IDENTITY_ERROR_CODES',
  notifications: 'NOTIFICATION_ERROR_CODES',
  payments: 'PAYMENT_ERROR_CODES',
  reporting: 'REPORTING_ERROR_CODES',
} as const satisfies Readonly<Record<string, string>>;

const MODULES = Object.keys(FAMILY_BY_MODULE) as readonly (keyof typeof FAMILY_BY_MODULE)[];

/**
 * Les familles du contrat, indexées par le nom sous lequel un module les écrit.
 *
 * Résoudre `FOO_ERROR_CODES.BAR` **dans la famille nommée**, et non dans
 * l'aplatissement `ERROR_CODES`, est ce qui donne son mordant au test : sans
 * cela, n'importe quelle clé du contrat passerait sous n'importe quel nom de
 * famille, et un module empruntant la famille d'un voisin ne se verrait pas.
 */
const FAMILY_BY_NAME: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  APPOINTMENTS_ERROR_CODES,
  AVAILABILITY_ERROR_CODES,
  CATALOG_ERROR_CODES,
  CRM_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  NOTIFICATION_ERROR_CODES,
  PAYMENT_ERROR_CODES,
  REPORTING_ERROR_CODES,
  TRANSPORT_ERROR_CODES,
};

/** Le `code` figé par une sous-classe de `DomainError`, et sa valeur textuelle. */
interface CodeDeclaration {
  readonly file: string;
  readonly expression: string;
}

/** Le module d'`apps/api` d'où vient ce fichier, ou `undefined` hors des modules. */
function moduleOf(file: string): string | undefined {
  return /^apps\/api\/src\/modules\/([^/]+)\//.exec(file)?.[1];
}

/** `public override readonly code = <expression>;` — la seule forme employée. */
const CODE_DECLARATION = /readonly\s+code\s*=\s*([^;]+);/g;

/** `'UN_CODE'` ou `"UN_CODE"` — un littéral, donc une seconde écriture. */
const STRING_LITERAL = /^'([^']*)'$|^"([^"]*)"$/;

/** `PAYMENT_ERROR_CODES.SALE_ITEM_UNAVAILABLE` — la forme attendue d'un module. */
const FAMILY_MEMBER = /^([A-Z][A-Z0-9_]*)\.([A-Z][A-Z0-9_]*)$/;

function tsFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      // Les suites de tests fabriquent des doublures d'erreurs : leurs codes ne
      // sont pas ceux que l'API sert.
      return entry.name === '__tests__' || entry.name === 'node_modules'
        ? []
        : tsFilesUnder(full);
    }

    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [full]
      : [];
  });
}

function codeDeclarationsIn(files: readonly string[]): CodeDeclaration[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const declarations: CodeDeclaration[] = [];

    for (const match of source.matchAll(CODE_DECLARATION)) {
      const expression = (match[1] ?? '').trim();

      // `public abstract readonly code: string;` de la classe racine n'a pas de
      // valeur : le motif ne le capture pas, faute de `=`. Ce qui reste est une
      // affectation.
      declarations.push({ file: relative(REPO_ROOT, file).split(sep).join('/'), expression });
    }

    return declarations;
  });
}

const ALL_FILES = tsFilesUnder(API_SRC);
const MODULE_FILES = ALL_FILES.filter((file) => file.startsWith(API_MODULES + sep));
const ALL_DECLARATIONS = codeDeclarationsIn(ALL_FILES);
const MODULE_DECLARATIONS = codeDeclarationsIn(MODULE_FILES);

/* --- Le second consommateur du contrat : `apps/web` (#546) ---------------- */

const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');

/**
 * Les suites du front sont exclues, pour la raison qui exclut `__tests__` côté
 * API : elles fabriquent des **corps d'erreur du fil**, et un corps du fil porte
 * la valeur textuelle, pas une référence au contrat. Un test qui pose
 * `{ code: 'NOT_FOUND' }` dans un `fetch` simulé écrit ce que l'API écrirait —
 * l'y interdire l'obligerait à prouver le contrat par le contrat.
 */
const WEB_TESTS = join(WEB_ROOT, 'tests');

function webSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '.next' || full === WEB_TESTS
        ? []
        : webSourceFiles(full);
    }

    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Un littéral en **position de jeton**, et non n'importe quelle apostrophe.
 *
 * Le caractère qui précède le guillemet ouvrant ne doit pas être alphanumérique.
 * C'est ce qui écarte l'élision française — `l'`, `d'`, `qu'` — dont les
 * commentaires de ce dépôt sont pleins : sans cette contrainte, une phrase comme
 * « l'ERROR_CODES' » suffirait à faire échouer le garde pour une raison de
 * typographie. Le code, lui, fait toujours précéder un littéral d'un espace,
 * d'une parenthèse, d'une virgule ou d'un crochet.
 *
 * Le balayage lit le fichier brut, commentaires compris — écarter les
 * commentaires demanderait un vrai découpage lexical, qu'un remplacement par
 * expression régulière ne sait pas faire sans manger la fin de toute ligne
 * portant `//` dans une chaîne. Un garde bruyant vaut mieux qu'un garde aveugle,
 * et le bruit se corrige d'un geste : une prose qui **cite** un code l'écrit
 * `` `PAYMENT_ALREADY_SETTLED` `` — entre accents graves, sans guillemets —,
 * comme le fait déjà tout le reste du dépôt.
 */
const WEB_CODE_LITERAL = /(?:^|[^A-Za-z0-9_$])(['"])([A-Z][A-Z0-9_]*)\1/gm;

const WEB_FILES = webSourceFiles(WEB_ROOT);

/** Chaque littéral de code du contrat écrit en clair dans `apps/web`, localisé. */
function webCodeLiterals(): string[] {
  return WEB_FILES.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const found: string[] = [];

    for (const match of source.matchAll(WEB_CODE_LITERAL)) {
      const value = match[2] ?? '';

      if (!isKnownErrorCode(value)) {
        continue;
      }

      // Compté jusqu'à la **fin** du littéral, et non jusqu'au début du motif :
      // celui-ci commence un cran plus tôt, sur le caractère qui précède le
      // guillemet — et ce caractère est le saut de ligne lui-même quand le
      // littéral ouvre la ligne. Partir de `match.index` désignerait alors la
      // ligne précédente. Un code n'ayant ni guillemet ni retour à la ligne, la
      // fin du motif est toujours sur la ligne du littéral.
      const line = source.slice(0, (match.index ?? 0) + match[0].length).split('\n').length;

      found.push(`${relative(REPO_ROOT, file).split(sep).join('/')}:${line} : '${value}'`);
    }

    return found;
  });
}

/**
 * Le code du contrat que cette affectation sert, ou `undefined` si elle n'en
 * sert aucun — expression d'une forme imprévue, littéral hors contrat, ou membre
 * d'une famille inconnue du contrat, ou d'une famille connue qui ne porte pas
 * cette clé.
 *
 * Les deux formes admises sont le littéral (`'NOT_FOUND'`, réservé au tronc
 * commun) et le membre de famille (`CRM_ERROR_CODES.CUSTOMER_EMAIL_TAKEN`). La
 * seconde se résout **dans la famille nommée** : `FOO_ERROR_CODES.BAR` ne vaut
 * que si le contrat exporte `FOO_ERROR_CODES` *et* que celle-ci porte `BAR`.
 * Résoudre par la seule clé, contre l'aplatissement `ERROR_CODES`, aurait laissé
 * passer n'importe quelle clé sous n'importe quel nom de famille.
 */
function contractCodeOf(expression: string): string | undefined {
  const literal = STRING_LITERAL.exec(expression);
  if (literal !== null) {
    const value = literal[1] ?? literal[2];

    return isKnownErrorCode(value) ? value : undefined;
  }

  const member = FAMILY_MEMBER.exec(expression);
  if (member === null) {
    return undefined;
  }

  const value = FAMILY_BY_NAME[member[1] ?? '']?.[member[2] ?? ''];

  return isKnownErrorCode(value) ? value : undefined;
}

describe('couverture des codes d’erreur d’apps/api par le contrat', () => {
  /**
   * Garde contre un test qui se viderait de lui-même. Un chemin faux, une
   * arborescence déplacée ou un motif qui ne correspond plus rendraient une
   * liste vide — et une boucle sur rien passe au vert. Les bornes sont larges :
   * elles constatent que le balayage a bien eu lieu, pas un décompte à figer.
   */
  it('a bien balayé les sources de l’API', () => {
    expect(ALL_FILES.length).toBeGreaterThan(100);
    expect(ALL_DECLARATIONS.length).toBeGreaterThanOrEqual(40);
    expect(MODULE_DECLARATIONS.length).toBeGreaterThanOrEqual(30);

    for (const module of MODULES) {
      const errorsFile = join(API_MODULES, module, `${module}.errors.ts`);

      expect(readFileSync(errorsFile, 'utf8')).toContain("from '@spa/shared'");
    }
  });

  it('déclare dans ERROR_CODES chaque code porté par une sous-classe de DomainError', () => {
    const unknown = ALL_DECLARATIONS.filter(
      ({ expression }) => contractCodeOf(expression) === undefined,
    ).map(({ file, expression }) => `${file} : ${expression}`);

    expect(unknown).toEqual([]);
  });

  /**
   * Le critère qui referme la divergence : plus aucun module ne **déclare** de
   * code. Un littéral y serait une seconde écriture, et c'est ainsi que les deux
   * familles de paiement ont fini par porter deux noms pour un même refus.
   *
   * Le tronc commun (`common/errors/domain-error.ts`) fait exception : ses cinq
   * codes sont ceux du transport et des refus transverses, et il ne peut pas
   * importer `@spa/shared` sans que toute erreur de domaine dépende du contrat.
   * Ils sont couverts par le test précédent, qui les résout comme littéraux.
   */
  it('ne laisse aucun littéral de code dans les modules', () => {
    const literals = MODULE_DECLARATIONS.filter(({ expression }) =>
      STRING_LITERAL.test(expression),
    ).map(({ file, expression }) => `${file} : ${expression}`);

    expect(literals).toEqual([]);
  });

  /**
   * Le corollaire : un module ne redéclare pas non plus la **famille** elle-même.
   * Un `export const CATALOG_ERROR_CODES = { … }` recompose la seconde écriture
   * sans qu'aucun littéral n'apparaisse dans un `readonly code`.
   */
  it('ne laisse aucune famille de codes redéclarée dans les modules', () => {
    const redeclared = MODULE_FILES.filter((file) =>
      /export\s+const\s+[A-Z][A-Z0-9_]*_ERROR_CODES\s*=\s*\{/.test(readFileSync(file, 'utf8')),
    ).map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

    expect(redeclared).toEqual([]);
  });

  /**
   * Ce qui donne un propriétaire à chaque code : un module ne sert que **sa**
   * famille. Sans ce test, `catalog` pourrait lever
   * `CRM_ERROR_CODES.CUSTOMER_EMAIL_TAKEN` — la compilation l'accepte, la clé
   * existe bien au contrat, et plus rien ne dirait quel module possède ce refus.
   * C'est exactement l'ambiguïté que le découpage par module de #536 supprime.
   */
  it('ne laisse aucun module servir la famille d’un voisin', () => {
    const borrowed = MODULE_DECLARATIONS.filter(({ file, expression }) => {
      const module = moduleOf(file);
      const family = FAMILY_MEMBER.exec(expression)?.[1];

      return (
        module !== undefined &&
        module in FAMILY_BY_MODULE &&
        family !== undefined &&
        family !== FAMILY_BY_MODULE[module as keyof typeof FAMILY_BY_MODULE]
      );
    }).map(({ file, expression }) => `${file} : ${expression}`);

    expect(borrowed).toEqual([]);
  });
});

/**
 * L'autre côté du contrat — #546.
 *
 * ## Pourquoi le garde ne pouvait pas s'arrêter à `apps/api`
 *
 * Le rapatriement de #536 a supprimé la seconde écriture **côté serveur**. Elle
 * subsistait côté front : `apps/web/lib/admin/checkout-summary.ts` déclarait huit
 * constantes locales — `const PAYMENT_ALREADY_SETTLED = 'PAYMENT_ALREADY_SETTLED'`
 * et sept sœurs — pour des codes que `PAYMENT_ERROR_CODES` porte désormais. Rien
 * ne l'en empêchait, et rien n'aurait empêché la neuvième.
 *
 * Le dégât n'est pas cosmétique. Un littéral **compile toujours** : le jour où
 * l'API renomme un refus, le `case` du front cesse simplement de correspondre, la
 * branche devient morte, et le message précis est remplacé par le repli
 * générique. C'est exactement l'histoire de `PAYMENT_ALREADY_CAPTURED`, restée
 * invisible des mois durant. Passer par le contrat transforme ce silence en
 * erreur de compilation.
 *
 * ## Ce qui reste licite
 *
 * Les `HTTP_<statut>` du repli — `'HTTP_404'`, `'HTTP_429'` — ne sont pas des
 * codes du contrat et n'ont pas vocation à le devenir : `isKnownErrorCode` les
 * rejette, ce garde les ignore. Voir la note d'`ApiClientError` dans
 * `apps/web/lib/api-client.ts`, où la question du type de `code` est tranchée.
 */
describe('couverture des codes d’erreur d’apps/web par le contrat', () => {
  /** Même garde anti-vidage que ci-dessus : une liste vide passerait au vert. */
  it('a bien balayé les sources du front', () => {
    expect(WEB_FILES.length).toBeGreaterThan(50);
    expect(WEB_FILES.some((file) => file.endsWith(`admin${sep}checkout-summary.ts`))).toBe(true);
    expect(WEB_FILES.some((file) => file.endsWith(`lib${sep}api-client.ts`))).toBe(true);
    expect(WEB_FILES.every((file) => !file.startsWith(WEB_TESTS + sep))).toBe(true);
  });

  it('ne laisse aucun littéral de code du contrat dans apps/web', () => {
    expect(webCodeLiterals()).toEqual([]);
  });
});
