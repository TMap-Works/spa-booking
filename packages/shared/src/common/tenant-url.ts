/**
 * L'adresse publique d'un établissement — les noms qu'elle ne peut pas porter,
 * et la façon de la composer.
 *
 * Le CDC prévoit deux formes d'adressage d'un salon : le **sous-domaine**
 * (`maison-lotus.exemple.test`) et le **segment d'URL** (`/maison-lotus/…`).
 * L'arbitrage du 16/09/2026 tranche en faveur du premier — « un sous-domaine par
 * salon » (#832) —, ce qui fait entrer deux règles dans le contrat partagé
 * plutôt que dans l'une des deux applications.
 *
 * ## Pourquoi ici, et pas dans l'API
 *
 * La liste des noms réservés vivait dans `apps/api/src/common/tenant/public-tenant-request.ts`,
 * où elle ne servait qu'à la **lecture** d'une requête entrante. Trois surfaces
 * en ont désormais besoin, et elles doivent s'accorder au nom près :
 *
 * | Surface | Ce qu'elle en fait |
 * |---|---|
 * | `slugSchema` (ce paquet) | refuse de **créer** un salon portant un nom réservé |
 * | `public-tenant-request.ts` (API) | refuse de **résoudre** un label réservé — 404 |
 * | middleware de sous-domaine (web, #838) | ne route pas un label réservé vers un salon |
 *
 * Une liste recopiée trois fois se désynchronise au premier ajout : un nom
 * réservé côté routage mais accepté à la création produit un salon injoignable,
 * et un nom réservé à la création mais routé côté web produit une page de salon
 * servie sur le domaine de la console. C'est exactement la classe de défaut que
 * `packages/shared` existe pour empêcher.
 */

import { SLUG_MAX_LENGTH } from '../constants/limits';
import { RESERVED_TENANT_SLUGS } from '../constants/reserved-slugs';

/**
 * Motif d'un **label DNS** minuscule : lettres, chiffres et tirets **simples**,
 * ni en tête ni en fin.
 *
 * Il porte à lui seul trois des quatre règles de la RFC 1123 §2.1 que le slug
 * d'un salon doit respecter pour qu'un sous-domaine puisse être servi — la
 * quatrième, la longueur, est `SLUG_MAX_LENGTH`.
 *
 * Il en porte une quatrième sans le dire : **`xn--` est structurellement
 * impossible**. Le préfixe des domaines internationalisés (Punycode, RFC 3492)
 * demande deux tirets consécutifs, et ce motif n'en accepte jamais deux. Un slug
 * `xn--n3h` serait un salon dont le nom d'hôte se résout en un caractère
 * arbitraire chez le client et en une chaîne littérale chez nous — deux lectures
 * d'une même adresse, donc deux salons pour le même certificat. Le refuser n'a
 * pas demandé de règle supplémentaire, mais il demande d'être **testé**, sans
 * quoi un assouplissement du motif le rouvrirait en silence.
 *
 * Exporté plutôt que recopié : `apps/api` en avait déjà deux copies
 * (`public-tenant-request.ts`, `catalog.slug.ts`), chacune commentée d'un « faute
 * que `@spa/shared` publie le motif seul ».
 */
export const DNS_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * L'ensemble, construit une fois : la liste est parcourue à chaque requête publique.
 *
 * Déclaré **avant** la fonction qui le lit : `isReservedTenantSlug` est hissée,
 * pas lui. Le jour où un import circulaire ferait évaluer un module qui appelle
 * la fonction pendant que celui-ci est encore en cours d'initialisation, l'ordre
 * inverse lèverait un `ReferenceError` de zone morte temporelle — une panne au
 * démarrage, sur une ligne qui n'aurait pas bougé.
 */
const RESERVED_SLUG_SET: ReadonlySet<string> = new Set<string>(RESERVED_TENANT_SLUGS);

/**
 * Ce nom est-il réservé à la plateforme ?
 *
 * La comparaison porte sur la forme canonique du slug — minuscules, sans espaces
 * autour. Les appelants qui reçoivent une chaîne brute la normalisent avant
 * (c'est ce que fait `slugSchema` par son `.trim().toLowerCase()`).
 */
export function isReservedTenantSlug(slug: string): boolean {
  return RESERVED_SLUG_SET.has(slug);
}

/**
 * Ce slug peut-il désigner un salon dans un **nom d'hôte** ?
 *
 * C'est la conjonction des deux règles précédentes : un label DNS valide, borné,
 * et non réservé. Elle sert au constructeur d'URL ci-dessous, qui ne doit jamais
 * composer un hôte dont il sait déjà qu'aucun salon ne peut y répondre.
 */
export function isTenantSubdomainLabel(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= SLUG_MAX_LENGTH &&
    DNS_LABEL_PATTERN.test(slug) &&
    !isReservedTenantSlug(slug)
  );
}

/**
 * Les trois réglages du mode d'adressage d'un salon.
 *
 * - `subdomain` — `https://maison-lotus.exemple.test/compte`, la forme retenue
 *   par l'arbitrage du PO ;
 * - `path` — `https://exemple.test/maison-lotus/compte`, le **repli** des
 *   environnements où aucun sous-domaine ne se résout ;
 * - `auto` — le défaut : `path` quand l'hôte de base ne peut porter aucune
 *   étiquette supplémentaire, `subdomain` partout ailleurs.
 *
 * `auto` est le défaut parce que le seul cas de repli réellement rencontré est
 * mécaniquement détectable : une adresse IP littérale ou un hôte d'une seule
 * étiquette (`localhost`) n'a pas de sous-domaine résolvable. Exiger un réglage
 * explicite aurait voulu dire qu'un oubli produit un lien mort dans un e-mail —
 * et un lien d'annulation mort ne se constate qu'au moment où une cliente
 * essaie de s'en servir.
 */
export const TENANT_URL_MODES = ['auto', 'subdomain', 'path'] as const;

export type TenantUrlMode = (typeof TENANT_URL_MODES)[number];

/** Le mode effectivement appliqué, une fois `auto` résolu. */
export type ResolvedTenantUrlMode = Exclude<TenantUrlMode, 'auto'>;

/** Adresse IPv4 en notation pointée — `127.0.0.1`, `10.0.0.12`. */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * L'hôte sous lequel un sous-domaine désigne un établissement, tiré d'`APP_URL`.
 *
 * `www.` est retiré : le front servi sur `www.exemple.test` n'empêche pas
 * `maison-lotus.exemple.test` de désigner un salon. C'est la règle qu'applique
 * déjà `publicBaseHost` côté API, à la **lecture** d'une requête entrante ; la
 * partager ici est ce qui garantit que le lien écrit dans un e-mail tombe sur
 * l'hôte que le middleware sait relire.
 *
 * Rend `null` sur une URL illisible plutôt que de lever : les appelants la
 * calculent au démarrage, et lever y empêcherait l'application de démarrer pour
 * une fonctionnalité qui, sans domaine de base, doit simplement se taire.
 */
export function tenantBaseHost(appUrl: string): string | null {
  const url = parseUrl(appUrl);
  return url === null ? null : hostAsTenantBase(url);
}

/**
 * La même règle, mais sur une URL déjà analysée — le constructeur d'adresse en a
 * besoin sans reparser la base qu'il vient de lire.
 */
function hostAsTenantBase(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Un littéral IPv6 (`[::1]`) n'a pas d'étiquettes : il ne peut ni porter un
  // sous-domaine, ni servir de suffixe à comparer.
  if (host.length === 0 || host.startsWith('[')) {
    return null;
  }
  return host.startsWith('www.') ? host.slice('www.'.length) : host;
}

/**
 * Cet hôte peut-il porter une étiquette de salon devant lui ?
 *
 * Non pour une adresse IP — `maison-lotus.127.0.0.1` n'est pas un nom —, non
 * pour un littéral IPv6, et non pour un hôte d'une seule étiquette :
 * `maison-lotus.localhost` n'est résolu que par certains navigateurs et par
 * aucun client HTTP en ligne de commande. C'est précisément la situation des
 * suites d'intégration et de la recette, qui tapent sur `127.0.0.1`.
 */
export function canHostTenantSubdomain(baseHost: string): boolean {
  return (
    baseHost.length > 0 &&
    !baseHost.startsWith('[') &&
    !IPV4_PATTERN.test(baseHost) &&
    baseHost.includes('.')
  );
}

/**
 * Le mode effectif pour une base donnée.
 *
 * `subdomain` et `path` sont rendus tels quels : un opérateur qui force un mode
 * sait ce qu'il fait, et le silence de `auto` ne doit pas pouvoir le contredire.
 * Seul `auto` regarde l'hôte.
 */
export function resolveTenantUrlMode(
  appUrl: string,
  mode: TenantUrlMode = 'auto',
): ResolvedTenantUrlMode {
  return modeForBaseHost(tenantBaseHost(appUrl), mode);
}

/**
 * La même décision, prise sur un hôte de base déjà calculé — c'est par là que
 * passe `tenantPublicUrl`, qui l'a sous la main et n'a pas à reparser `APP_URL`
 * pour l'obtenir une seconde fois.
 */
function modeForBaseHost(
  baseHost: string | null,
  mode: TenantUrlMode = 'auto',
): ResolvedTenantUrlMode {
  if (mode !== 'auto') {
    return mode;
  }
  return baseHost !== null && canHostTenantSubdomain(baseHost) ? 'subdomain' : 'path';
}

/** Ce que `tenantPublicUrl` a besoin de savoir en plus du salon et du chemin. */
export interface TenantPublicUrlOptions {
  /**
   * L'origine du front — `APP_URL`. C'est d'elle que viennent le protocole,
   * l'hôte de base, le port et l'éventuel préfixe de chemin.
   */
  readonly baseUrl: string;
  /** Le mode d'adressage. `auto` par défaut — voir `TENANT_URL_MODES`. */
  readonly mode?: TenantUrlMode;
}

/**
 * L'URL publique d'une page d'un salon — critère 3 de #837.
 *
 * `tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'https://exemple.test' })`
 * rend `https://maison-lotus.exemple.test/compte`.
 *
 * ## Le repli n'est pas seulement un réglage
 *
 * Deux choses le déclenchent, et la seconde n'est pas configurable :
 *
 * 1. le **mode**, `path` explicitement ou `auto` sur un hôte sans sous-domaine ;
 * 2. un **slug qui ne peut pas être une étiquette d'hôte** — mal formé, trop
 *    long, ou réservé.
 *
 * Le second point est ce qui empêche d'écrire une adresse cassée. Un slug qui
 * n'est pas un label DNS ne peut pas entrer dans un nom d'hôte : `salon/évasion`
 * y produirait `salon/évasion.exemple.test`, c'est-à-dire un lien qui n'est même
 * pas une URL. En mode chemin il redevient un segment encodable, et le lien
 * reste cliquable — il mène à un 404 si le salon n'existe pas, ce qui est le bon
 * échec. Un label **réservé** suit la même règle pour une raison voisine :
 * `www.exemple.test` est déjà refusé par la résolution publique (404), donc
 * l'écrire dans un e-mail serait écrire un lien mort en connaissance de cause.
 *
 * Le chemin est concaténé tel quel après l'hôte, préfixe d'`APP_URL` compris :
 * une base `https://exemple.test/app` rend `https://maison-lotus.exemple.test/app/compte`.
 */
export function tenantPublicUrl(
  slug: string,
  path: string,
  options: TenantPublicUrlOptions,
): string {
  const url = parseUrl(options.baseUrl);
  if (url === null) {
    // Une base illisible n'a pas de forme juste à produire. On rend la
    // concaténation la plus littérale possible plutôt que de lever : ce
    // constructeur sert à écrire des e-mails, et un envoi ne doit pas échouer
    // sur la configuration d'un autre.
    return `${options.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}${normalizePath(path)}`;
  }

  const prefix = url.pathname.replace(/\/+$/, '');
  const suffix = `${prefix}${normalizePath(path)}`;
  // L'hôte de base est tiré une fois : le passer à `modeForBaseHost` évite de
  // reparser `baseUrl` deux fois de plus pour la même réponse.
  const baseHost = hostAsTenantBase(url);
  const mode = modeForBaseHost(baseHost, options.mode);

  if (mode === 'subdomain' && baseHost !== null && isTenantSubdomainLabel(slug)) {
    const port = url.port === '' ? '' : `:${url.port}`;
    return `${url.protocol}//${slug}.${baseHost}${port}${suffix}`;
  }

  return `${url.origin}${prefix}/${encodeURIComponent(slug)}${normalizePath(path)}`;
}

/** `compte` et `/compte` désignent la même page ; `''` ne désigne que la racine. */
function normalizePath(path: string): string {
  if (path.length === 0) {
    return '';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

/** `new URL` sans l'exception — une base illisible est une absence, pas une panne. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
