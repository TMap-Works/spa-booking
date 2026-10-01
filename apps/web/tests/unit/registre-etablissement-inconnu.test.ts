import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * Le registre des émetteurs de `TENANT_NOT_FOUND` compte-t-il juste ? — #1397
 *
 * ## Pourquoi cette suite existe
 *
 * `WEB_ACTION_ERROR_CODES` est la onzième famille du contrat partagé, et la seule
 * dont l'émetteur n'est pas `apps/api`. L'invariant de `error-codes.ts` — *« tout
 * code de ce fichier a un émetteur nommé »* — y est tenu par une **notice**, parce
 * que le garde des dix autres familles ne peut pas la tenir :
 * `packages/shared/src/__tests__/api-error-codes.spec.ts` reconnaît un émetteur à sa
 * sous-classe de `DomainError`, et il chasse dans `apps/web` les littéraux de codes,
 * où il ne trouvera jamais qu'une lecture de la constante.
 *
 * Une notice pour seule barrière, c'est une barrière que personne ne franchit en
 * rouge — et le fil #1372 → #1375 → #1379 → #1391 → #1394 l'a montré quatre fois :
 * le total des émetteurs s'est périmé à chaque maillon. #1391 s'est annoncé
 * « neuvième et dernier » après avoir compté #1372 pour un module au lieu de deux,
 * deux en-têtes disaient encore « huit autres » quand il y en avait neuf, et deux
 * écritures d'un même ticket se contredisaient sur « dix » et « douze » fois corrigé.
 *
 * #1397 n'a donc pas corrigé un chiffre, il a décidé **où un chiffre a le droit de
 * vivre** : dans la notice de `TENANT_NOT_FOUND`, qui est la seule écriture portant
 * aussi la **liste** qu'il totalise, et nulle part ailleurs. Cette suite est ce qui
 * rend la décision exécutoire.
 *
 * ## Ce qu'elle prouve
 *
 * - les émetteurs **mesurés sur le disque** sont ceux que la décision déclare, et
 *   leur nombre est celui que la notice écrit — les trois nombres de sa phrase de
 *   clôture, pas seulement le total ;
 * - la notice nomme encore **par leur chemin** ceux qu'elle désigne ainsi : un
 *   fichier déplacé fait échouer ici, au lieu de laisser une notice pointer dans le
 *   vide ;
 * - **aucun autre fichier du fil ne compte la classe.** C'est la règle même que le
 *   ticket a posée, et un commentaire est le seul endroit où elle peut se rompre.
 *
 * ## Ce qu'elle ne prouve pas, et pourquoi
 *
 * Que la notice décrive juste ce que chaque émetteur *fait* : c'est l'objet des
 * suites `etablissement-inconnu-*`, qui exercent les actions et les routes. Ici on
 * ne garde que le **registre**, c'est-à-dire la seule chose qu'aucun test ne
 * gardait.
 *
 * Et elle ne refuse pas tout nombre : une **paire nommée** — « ces deux Route
 * Handlers », suivi des deux chemins — est une liste, pas un total, et rien ne peut
 * l'en faire diverger. Ce qui est refusé est le compte de la classe entière, celui
 * qu'on ne peut vérifier qu'en relisant douze fichiers.
 */

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(testsDir, '..', '..');
const errorCodesFile = path.join(
  webRoot,
  '..',
  '..',
  'packages',
  'shared',
  'src',
  'errors',
  'error-codes.ts',
);

/**
 * La fabrique partagée du back-office — elle n'est pas un émetteur, elle est ce que
 * les émetteurs du back-office appellent. Elle porte tout de même la règle du
 * ticket : son en-tête est l'endroit où la classe se tient.
 */
const FACTORY = 'app/(admin)/[tenantSlug]/admin/action-result.ts';

/**
 * La fabrique **partagée aux trois surfaces** (#1395) — pas davantage un émetteur :
 * les trois fabricants l'appellent, et son nom (`unknownTenantRefusal`) la tient hors
 * du dénombrement sans qu'une exception ait à l'en sortir.
 *
 * Elle est tout de même relue par la règle « aucun autre fichier du fil ne compte la
 * classe » : son en-tête porte l'arbitrage du partage, c'est-à-dire exactement le
 * genre d'écriture où un total se recopie — et sans cette ligne, elle serait le seul
 * fichier du fil où il pourrait le faire sans rougir.
 */
const SHARED_FACTORY = 'lib/tenant-refusal.ts';

/**
 * Les dix modules d'actions serveur, et les deux Route Handlers.
 *
 * Écrits en clair plutôt que déduits du disque, pour la raison qui fait écrire les
 * huit modules du CDC dans `api-error-codes.spec.ts` : un émetteur supprimé par
 * accident doit faire échouer cette suite, pas rétrécir son périmètre en silence.
 */
const EXPECTED_ACTION_MODULES: readonly string[] = [
  'app/(account)/[tenantSlug]/compte/actions.ts',
  'app/(admin)/[tenantSlug]/admin/actions.ts',
  'app/(admin)/[tenantSlug]/admin/calendrier/actions.ts',
  'app/(admin)/[tenantSlug]/admin/catalogue/actions.ts',
  'app/(admin)/[tenantSlug]/admin/clients/actions.ts',
  'app/(admin)/[tenantSlug]/admin/encaissement/actions.ts',
  'app/(admin)/[tenantSlug]/admin/personnel/actions.ts',
  'app/(admin)/[tenantSlug]/admin/reglages/actions.ts',
  'app/(admin)/[tenantSlug]/admin/reporting/actions.ts',
  'app/(booking)/[tenantSlug]/reservation/actions.ts',
];

const EXPECTED_ROUTES: readonly string[] = [
  'app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/route.ts',
  'app/(account)/[tenantSlug]/compte/reservation/route.ts',
];

/**
 * Les émetteurs que la notice désigne **par leur chemin**, et non par leur rôle.
 *
 * Les autres y sont nommés « le planning », « le comptoir », « le catalogue », « les
 * fiches clientes », « le personnel », « le reporting », « l'espace client » : une
 * désignation qu'aucun test ne peut rattacher à un fichier, et qu'il n'y a donc pas
 * lieu de garder ici. Ceux-ci, si.
 */
const PATHS_NAMED_BY_THE_NOTICE: readonly string[] = [
  'admin/actions.ts',
  'admin/reglages/actions.ts',
  'app/(booking)/[tenantSlug]/reservation/actions.ts',
  'app/(account)/[tenantSlug]/compte/reservation/route.ts',
  'compte/rendez-vous/[appointmentId]/annulation/route.ts',
];

/** Les dossiers qu'il ne sert à rien de parcourir, et qui coûtent cher. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.next', 'tests', 'mockups', 'public']);

/** Les sources d'`apps/web`, en chemins relatifs à `apps/web` et séparés par `/`. */
function webSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name) ? [] : webSources(full);
    }

    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')
      ? [path.relative(webRoot, full).split(path.sep).join('/')]
      : [];
  });
}

/**
 * Un appel — ou une déclaration — de `unknownTenant`, et non une simple mention.
 *
 * `{@link unknownTenant}` dans une phrase ne fait pas un émetteur : c'est ce qui
 * distingue un fichier qui **rend** ce refus d'un fichier qui en parle.
 */
const EMITS = /unknownTenant\s*\(/;

const SOURCES = webSources(webRoot);
const EMITTER_FILES = SOURCES.filter(
  (file) => file !== FACTORY && EMITS.test(readFileSync(path.join(webRoot, file), 'utf8')),
).sort();

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
};

/** Le texte de `error-codes.ts`, ses préfixes de commentaire retirés et replié. */
function proseOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/^\s*\*\s?/gm, '')
    .replace(/\s+/g, ' ');
}

/**
 * La phrase de clôture de la notice — le seul endroit du dépôt qui compte la classe.
 *
 * Trois nombres, et ils sont lus plutôt que supposés : un total qui ne serait pas la
 * somme de ses deux parts serait un registre faux d'une autre façon.
 */
const CLOSING_TALLY =
  /sans réserve\s*:\s*(\p{L}+) émetteurs,\s*(\p{L}+) modules d['’]actions serveur et (\p{L}+) Route Handlers/u;

/**
 * Un compte de la classe : un nombre, puis ce qu'il dénombre.
 *
 * `précédents` et `modules repris` y sont parce que c'est sous ces tournures que le
 * total s'est périmé — « les dix précédents », « les huit modules repris » — et non
 * sous le mot « émetteurs », que les en-têtes n'employaient pas.
 *
 * La seconde alternative est là pour la tournure **elliptique**, où le nombre ne
 * dénombre rien explicitement et porte la classe à lui seul : « le plus net des
 * douze », « ce qui se dit ici vaut pour les douze ». #1394 l'avait employée deux
 * fois, et un motif qui exige un nom après le nombre ne la voit pas. Les totaux
 * atteignables y sont seuls — « les onze gestes » de `personnel/actions.ts` compte
 * autre chose que cette classe.
 *
 * Le drapeau `g` est voulu : un fichier peut recompter deux fois, et n'en montrer
 * qu'une ferait croire le second corrigé.
 */
const CLASS_COUNT =
  /\b(?:(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|\d+)\s+(?:\*\*)?(?:autres|derniers|premiers)?\s*(?:\*\*)?(?:modules d['’]actions|modules repris|émetteurs|précédents)|(?:les|des|aux)\s+(?:douze|treize|quatorze|quinze))\b/giu;

describe('Le registre des émetteurs de WEB_ACTION_ERROR_CODES.TENANT_NOT_FOUND', () => {
  it('mesure sur le disque exactement les émetteurs que la décision déclare', () => {
    expect(EMITTER_FILES).toEqual([...EXPECTED_ACTION_MODULES, ...EXPECTED_ROUTES].sort());

    // La fabrique est bien là, et bien exclue du compte : sans elle, le décompte
    // passerait de douze à treize sans qu'un émetteur ait été ajouté. C'est
    // exactement l'erreur que #1394 a eu à défaire.
    expect(SOURCES).toContain(FACTORY);
    expect(EMITTER_FILES).not.toContain(FACTORY);

    // La fabrique partagée, elle, est hors du compte par son **nom** : relue ici pour
    // qu'un déplacement ne retire pas en silence le seul fichier du fil que la règle
    // des comptes ne surveillerait plus.
    expect(SOURCES).toContain(SHARED_FACTORY);
    expect(EMITTER_FILES).not.toContain(SHARED_FACTORY);
  });

  it("les Route Handlers se distinguent des modules d'actions par leur nom de fichier", () => {
    // La notice compte les deux familles séparément, parce qu'une route a eu à
    // trancher un statut HTTP qu'un module d'actions ne porte pas. Le test les
    // sépare de la même façon, et sur le seul critère observable.
    expect(EMITTER_FILES.filter((file) => file.endsWith('/actions.ts')).sort()).toEqual(
      [...EXPECTED_ACTION_MODULES].sort(),
    );
    expect(EMITTER_FILES.filter((file) => file.endsWith('/route.ts')).sort()).toEqual(
      [...EXPECTED_ROUTES].sort(),
    );
  });

  it('écrit dans la notice les trois nombres que la mesure donne', () => {
    const tally = CLOSING_TALLY.exec(proseOf(errorCodesFile));

    expect(
      tally,
      "la phrase de clôture de la notice de TENANT_NOT_FOUND n'est plus reconnaissable : " +
        'elle est le seul endroit du dépôt qui compte les émetteurs, et ce test la lit',
    ).not.toBeNull();

    const [total, modules, routes] = (tally ?? []).slice(1).map((word) => NUMBER_WORDS[word]);

    expect(modules).toBe(EXPECTED_ACTION_MODULES.length);
    expect(routes).toBe(EXPECTED_ROUTES.length);
    expect(total).toBe(EMITTER_FILES.length);
    expect(total).toBe((modules ?? 0) + (routes ?? 0));
  });

  it('nomme encore par leur chemin les émetteurs qu’elle désigne ainsi', () => {
    const prose = proseOf(errorCodesFile);

    for (const named of PATHS_NAMED_BY_THE_NOTICE) {
      expect(prose, `la notice ne nomme plus ${named}`).toContain(named);
    }
  });

  it('ne laisse aucun autre fichier du fil compter la classe', () => {
    const offenders = [FACTORY, SHARED_FACTORY, ...EMITTER_FILES].flatMap((file) => {
      const source = readFileSync(path.join(webRoot, file), 'utf8');

      return [...source.matchAll(CLASS_COUNT)].map((found) => `${file} : « ${found[0]} »`);
    });

    expect(
      offenders,
      "un compte de la classe est réapparu hors de la notice de WEB_ACTION_ERROR_CODES. " +
        'C’est ainsi que le total s’est périmé à quatre maillons du fil (#1375, #1379, ' +
        '#1391, #1394) : nommer la liste, ou renvoyer à la notice, mais ne pas recompter.',
    ).toEqual([]);
  });

  it('ne laisse la notice compter que dans sa phrase de clôture', () => {
    // La règle est « un seul endroit a le droit de compter » — ce qui veut dire une
    // seule **écriture**, pas un seul fichier. `error-codes.ts` portait un second
    // compte à l'autre bout de la même notice (« les dix précédents », section du
    // statut) : recopié loin de la liste, donc exactement ce que la règle refuse, et
    // le seul endroit du dépôt qu'aucun test ne relisait.
    const prose = proseOf(errorCodesFile);
    const sanctioned = CLOSING_TALLY.exec(prose);

    expect(sanctioned).not.toBeNull();

    const elsewhere = [...prose.replace(sanctioned?.[0] ?? '', ' ').matchAll(CLASS_COUNT)];

    expect(
      elsewhere.map((found) => `« ${found[0]} »`),
      'la notice compte la classe ailleurs que dans sa phrase de clôture : un total ' +
        'recopié loin de la liste qu’il totalise se périme, même à quelques lignes d’elle.',
    ).toEqual([]);
  });
});
