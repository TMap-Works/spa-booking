import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/*
 * Aucune clé d'`admin-checkout` n'est orpheline — #1240, quatrième critère.
 *
 * ## Ce qu'une clé orpheline coûte
 *
 * Elle se périme sans bruit. `failure.terminalReferenceRefused` portait, dans
 * les deux langues, la phrase exacte qui nomme le champ et la règle — et un
 * numéro de ticket TPE refusé par la clé de Luhn retombait pendant des semaines
 * sur « La requête est invalide. » Le catalogue avait raison, personne ne le
 * lisait. #1241 l'a branchée ; ce test est ce qui empêche la suivante de
 * s'installer aussi longtemps.
 *
 * Le risque symétrique existe aussi : une clé que rien ne lit n'est traduite par
 * personne, et sa version anglaise dérive de sa version française sans qu'aucun
 * écran ne montre l'écart. La parité des deux catalogues est tenue ailleurs
 * (`admin-checkout-i18n`, `messages-parity`) ; ce que ce test ajoute est qu'elles
 * portent l'une et l'autre sur des clés **vivantes**.
 *
 * ## Ce qui compte comme lecture
 *
 * Les deux formes que le comptoir emploie, et il n'y en a pas d'autre :
 *
 * | Forme | Où |
 * |---|---|
 * | `t('failure.notFound')` | les composants, par `useTranslations`/`getTranslations` |
 * | `checkoutWords(locale).failure.notFound` | `lib/admin/checkout-summary.ts`, hors de React |
 *
 * La seconde n'existe jamais comme chaîne : elle se lit sur le **chemin
 * d'accès**. La chercher dans tout le dépôt accuserait à tort — l'aperçu du
 * ticket de caisse a une prop nommée `receipt`, et un `receipt.client` y désigne
 * une cliente, pas une phrase de catalogue. Elle n'est donc cherchée que dans
 * les modules qui **importent `checkoutWords`**, aujourd'hui deux, et le
 * périmètre se maintient tout seul : un troisième module qui emploierait la forme
 * entrerait dans le scan du seul fait qu'il nomme la fonction.
 *
 * Reste une approximation, dans le sens inoffensif : un groupe ramené à une
 * variable (`const words = checkoutWords(locale).sale;`) fait accepter ses
 * feuilles sur le seul suffixe (`words.total`). Elle peut rater une orpheline,
 * jamais accuser une clé lue.
 */

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Les extensions qui portent du code — le JSON lu ici n'en est pas. */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'];

/**
 * Les clés que le **ticket imprimé** attend, et que personne ne lit encore.
 *
 * `app/(admin)/[tenantSlug]/admin/components/receipt-ticket.tsx` écrit ses
 * libellés en dur, en français — « Client », « Praticien », « Article », « Qté »,
 * « Total TTC », « Merci de votre visite ! » — alors que le catalogue porte déjà
 * les treize phrases dans les deux langues. Ce n'est donc pas un catalogue en
 * trop : c'est un composant en retard, et retirer les clés entérinerait les
 * libellés en dur que `CLAUDE.md` interdit.
 *
 * La dérogation est nominative et vouée à disparaître avec l'issue de suivi qui
 * la porte. Toute clé orpheline hors de cette liste fait échouer ce test.
 */
const PENDING_RECEIPT_KEYS: readonly string[] = [
  'receipt.label',
  'receipt.finalTitle',
  'receipt.client',
  'receipt.staff',
  'receipt.linesCaption',
  'receipt.item',
  'receipt.quantity',
  'receipt.amount',
  'receipt.refunded',
  'receipt.total',
  'receipt.kept',
  'receipt.payment',
  'receipt.thanks',
];

/**
 * Ce qui n'est pas lu — et `tests/` en fait partie, délibérément.
 *
 * Une clé que seule une suite cite reste orpheline **dans le produit** : c'est
 * précisément le cas qu'on veut voir échouer, et non se justifier tout seul. La
 * liste ci-dessous en serait d'ailleurs la première victime, elle qui nomme onze
 * clés en clair.
 */
const IGNORED_DIRS: readonly string[] = ['node_modules', '.next', 'messages', 'tests', 'mockups'];

/** Tous les modules de production sous `apps/web`. */
function sources(): string[] {
  const found: string[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_DIRS.includes(entry.name)) {
        continue;
      }

      const child = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(child);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(child);
      }
    }
  }

  walk(webDir);

  return found;
}

/** Les chemins de clés d'un catalogue, à plat — `failure.notFound`. */
function keysOf(tree: unknown, prefix = ''): string[] {
  return typeof tree === 'object' && tree !== null
    ? Object.entries(tree).flatMap(([key, value]) =>
        keysOf(value, prefix === '' ? key : `${prefix}.${key}`),
      )
    : [prefix];
}

const SOURCES = sources().map((file) => readFileSync(file, 'utf8'));

/** Tout le code de production — la forme `t('groupe.feuille')` s'y cherche. */
const CODE = SOURCES.join('\n');

/** Les seuls modules où la forme d'accès objet a un sens : ceux qui l'importent. */
const WORD_ACCESS = SOURCES.filter((source) => source.includes('checkoutWords')).join('\n');

/**
 * Les groupes ramenés à une variable — `const words = checkoutWords(locale).sale;`.
 *
 * Le point-virgule est exigé : sans lui, la chaîne complète
 * `checkoutWords(locale).receipt.cashDisclaimer` ferait passer `receipt` pour un
 * groupe restreint, et ses treize feuilles pour lues.
 */
const NARROWED = new Set(
  [...WORD_ACCESS.matchAll(/checkoutWords\([^)]*\)\s*\.\s*([A-Za-z]+)\s*;/g)].map(
    (match) => match[1] ?? '',
  ),
);

const CATALOG = JSON.parse(
  readFileSync(path.join(webDir, 'messages', 'en', 'admin-checkout.json'), 'utf8'),
) as unknown;

/** `true` si un module de production nomme cette clé, par l'une ou l'autre forme. */
function isRead(key: string): boolean {
  if (CODE.includes(`'${key}'`) || CODE.includes(`"${key}"`) || CODE.includes(`\`${key}\``)) {
    return true;
  }

  if (!key.includes('.')) {
    return false;
  }

  const group = key.slice(0, key.lastIndexOf('.'));
  const leaf = key.slice(key.lastIndexOf('.') + 1);

  // La chaîne entière, groupe et feuille **adjacents** — `.failure.notFound`.
  if (new RegExp(`\\.\\s*${group.split('.').join('\\.')}\\s*\\.\\s*${leaf}\\b`).test(WORD_ACCESS)) {
    return true;
  }

  // À défaut, la feuille seule, et seulement sous un groupe déjà ramené à une
  // variable : c'est la forme `words.notFound`, qui n'écrit plus le groupe.
  return NARROWED.has(group) && new RegExp(`\\.\\s*${leaf}\\b`).test(WORD_ACCESS);
}

describe('les clés du catalogue d’encaissement', () => {
  const keys = keysOf(CATALOG);

  it('en compte assez pour que ce test veuille dire quelque chose', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it('n’en laisse aucune que personne ne lise', () => {
    const orphans = keys.filter((key) => !isRead(key) && !PENDING_RECEIPT_KEYS.includes(key));

    expect(orphans).toEqual([]);
  });

  it('branche le refus du n° de ticket TPE, que le générique remplaçait', () => {
    // Troisième critère de #1240, livré par #1241 : la clé est lue par
    // `terminalReferenceRefusal`, et le panneau la pose **sur le champ**.
    expect(isRead('failure.terminalReferenceRefused')).toBe(true);
  });

  it('nomme le règlement partiel de la liste de la journée', () => {
    expect(isRead('badge.partiallySettled')).toBe(true);
  });

  it('garde la dérogation du ticket imprimé nominative, et vraiment orpheline', () => {
    // Le jour où `receipt-ticket.tsx` lira ces clés, cette liste doit rétrécir.
    // Sans cette assertion, elle resterait en place comme une exemption
    // permanente — et une clé retirée du catalogue y survivrait en silence.
    for (const key of PENDING_RECEIPT_KEYS) {
      expect(keys).toContain(key);
      expect(isRead(key)).toBe(false);
    }
  });
});
