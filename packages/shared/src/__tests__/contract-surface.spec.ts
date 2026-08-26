/**
 * Surface publique du contrat.
 *
 * Deux propriétés se vérifient ici, et nulle part ailleurs :
 *
 * 1. **Le baril racine expose vraiment ce qu'il croit exposer.** `src/index.ts`
 *    réexporte quatre familles par `export *`. En ES modules, deux familles qui
 *    exporteraient le même nom le voient exclu du baril — *sans erreur*. Le
 *    symbole disparaîtrait alors de `@spa/shared` et le seul signe serait un
 *    « has no exported member » chez celui qui importe, à des semaines de là.
 *
 * 2. **`@spa/shared` se résout depuis `apps/api` et depuis `apps/web`.** C'est le
 *    critère d'acceptation de l'issue #26, et il ne se démontre pas en modifiant
 *    les applications : le lien de workspace npm et le champ `exports` du paquet
 *    suffisent, ce test le constate depuis leurs répertoires respectifs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import * as commonFamily from '../common/index';
import * as constantsFamily from '../constants/index';
import * as errorsFamily from '../errors/index';
import * as contract from '../index';
import * as schemasFamily from '../schemas/index';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * Un représentant de chaque famille et de chaque module. Volontairement une
 * liste courte et non la totalité de la surface : elle doit rester exacte sans
 * devenir un doublon des barils qu'elle garde.
 */
const EXPECTED_EXPORTS = [
  // common
  'money',
  'moneySchema',
  'CurrencyMismatchError',
  'utcInstantSchema',
  'calendarDateSchema',
  'calendarDaysBetween',
  'uuidSchema',
  'emailSchema',
  'paginationMeta',
  'paginatedSchema',
  // constants
  'APPOINTMENT_STATUSES',
  'APPOINTMENT_STATUS_TRANSITIONS',
  'USER_ROLES',
  'hasAtLeastRole',
  'NOTIFICATION_CHANNELS',
  'PAYMENT_STATUSES',
  'MAX_AVAILABILITY_RANGE_DAYS',
  // errors
  'ERROR_CODES',
  'isKnownErrorCode',
  'apiErrorSchema',
  'errorCodeOf',
  // schemas
  'appointmentSchema',
  'createAppointmentRequestSchema',
  'availabilityQuerySchema',
  'serviceSchema',
  'serviceCategorySchema',
  'userSchema',
  'notificationSchema',
  'paymentSchema',
  'publicTenantSchema',
] as const;

/**
 * Les quatre familles réexportées par `src/index.ts`, sous la forme où la
 * collision se constate : leurs jeux de noms.
 */
const FAMILIES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['common', commonFamily],
  ['constants', constantsFamily],
  ['errors', errorsFamily],
  ['schemas', schemasFamily],
];

describe('baril racine', () => {
  it.each(EXPECTED_EXPORTS)('expose %s', (name) => {
    expect(contract).toHaveProperty(name);
    expect((contract as Record<string, unknown>)[name]).toBeDefined();
  });

  /**
   * Le vrai garde-fou du `export *`.
   *
   * Compter les clés du baril racine ne prouve rien : `Object.keys` ne rend
   * jamais deux fois le même nom, donc un test de doublon sur ce seul objet est
   * une tautologie. La collision se cherche **entre familles** : deux familles
   * qui exportent le même nom le voient exclu du baril racine côté types —
   * `@spa/shared` perd le symbole avec un simple « has no exported member » chez
   * l'appelant — pendant qu'à l'exécution `__exportStar` conserve le premier
   * arrivé et laisse tout paraître normal.
   *
   * Limite assumée : seuls les exports de **valeurs** sont visibles ici. Une
   * collision entre deux `export type` ne se voit qu'à la compilation.
   */
  it('n’exporte pas le même nom depuis deux familles', () => {
    const owners = new Map<string, string>();
    const collisions: string[] = [];

    for (const [family, namespace] of FAMILIES) {
      for (const name of Object.keys(namespace)) {
        if (name === '__esModule') {
          continue;
        }
        const previous = owners.get(name);
        if (previous === undefined) {
          owners.set(name, family);
        } else {
          collisions.push(`${name} : ${previous} et ${family}`);
        }
      }
    }

    // Garde contre un test qui se viderait de lui-même : si les quatre familles
    // ne rendaient plus aucun nom (changement d'interopérabilité de modules), la
    // boucle ci-dessus n'aurait plus rien à comparer et passerait au vert.
    expect(owners.size).toBeGreaterThan(EXPECTED_EXPORTS.length);
    expect(collisions).toEqual([]);
    // Chaque nom d'une famille arrive bien jusqu'au baril racine.
    for (const name of owners.keys()) {
      expect(contract).toHaveProperty(name);
    }
  });
});

describe('résolution de @spa/shared', () => {
  it.each(['apps/api', 'apps/web'])('se résout depuis %s', (app) => {
    const from = join(REPO_ROOT, app, 'package.json');

    // `createRequire` depuis le `package.json` de l'application : c'est
    // exactement l'algorithme que suivront Node, Nest et Next à l'exécution.
    const manifestPath = createRequire(from).resolve('@spa/shared/package.json');

    expect(dirname(manifestPath)).toBe(PACKAGE_ROOT);
  });

  it('déclare des points d’entrée que la compilation produit vraiment', () => {
    // Lu sur le disque plutôt qu'importé : un `import` de `package.json`
    // l'entraînerait dans le programme TypeScript du paquet, hors de `rootDir`.
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as {
      main: string;
      types: string;
      exports: Record<string, { types: string; default: string }>;
    };

    // Les chemins déclarés sont ceux qu'émettra `tsc -p tsconfig.build.json`
    // (`outDir: dist`, `declaration: true`). On vérifie la cohérence du manifeste
    // avec lui-même — l'existence du `dist` relève de la cible `build`, qui
    // s'exécute avant `test:unit` dans `npm run verify` mais pas isolément.
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
    expect(existsSync(join(PACKAGE_ROOT, 'tsconfig.build.json'))).toBe(true);
  });
});
