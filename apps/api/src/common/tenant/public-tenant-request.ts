/**
 * Lecture de l'établissement **désigné** par une requête publique.
 *
 * Une page de réservation est servie à un visiteur qui n'a pas de compte : il
 * n'y a pas de jeton d'où tirer le tenant, et il faut bien que l'URL le dise
 * (tenant-isolation §2). Ce fichier est le seul qui lise cette désignation, et
 * il ne fait que la **lire** : il ne résout rien, n'interroge aucune base et ne
 * décide d'aucun accès. Le slug qui en sort est une chaîne fournie par le
 * client, exactement au même titre qu'un champ de formulaire — c'est la
 * résolution contre la table `tenants`, ailleurs, qui en fait une donnée
 * serveur.
 *
 * La séparation n'est pas cosmétique : elle rend cette logique — la seule du
 * chemin public qui manipule de l'entrée non vérifiée — exerçable sans HTTP,
 * sans Nest et sans base, donc réellement testable cas par cas.
 *
 * ## Deux sources, et pourquoi elles doivent s'accorder
 *
 * Le CDC prévoit les deux formes d'adressage d'un salon : le **sous-domaine**
 * (`salon-des-lilas.exemple.test`) et le **segment d'URL**
 * (`/api/v1/public/salon-des-lilas/...`). Quand les deux sont présentes et se
 * contredisent, la requête est refusée plutôt qu'arbitrée : une page servie sur
 * le domaine d'un salon qui interrogerait les données d'un autre est soit une
 * erreur de câblage, soit une tentative — dans les deux cas, il n'y a pas de
 * bonne façon d'en choisir un.
 */

import {
  DNS_LABEL_PATTERN,
  SLUG_MAX_LENGTH,
  isReservedTenantSlug,
  tenantBaseHost,
} from '@spa/shared';

/** Segment qui ouvre l'espace d'URL public, juste après le préfixe et la version. */
export const PUBLIC_ROUTE_SEGMENT = 'public';

/**
 * `/api/v1/public`, `/api/v2/public/...` — le préfixe et le versionnement sont
 * ceux que `configureApp` pose (`bootstrap.ts`).
 *
 * Recopiés ici plutôt qu'importés : `bootstrap.ts` tire `@nestjs/swagger` et la
 * configuration derrière lui, et ce fichier doit rester exerçable seul. La
 * recopie est tenue par `public-tenant-request.spec.ts`, qui compare ces
 * constantes aux vraies — une divergence casse un test, elle ne dort pas.
 *
 * **Insensible à la casse**, et ce n'est pas de la complaisance : Express route
 * sans tenir compte de la casse (`case sensitive routing` est désactivé par
 * défaut, et rien ne l'active ici). `/api/v1/PUBLIC/salon-des-lilas` atteint donc
 * le contrôleur public. Un motif sensible à la casse ne le reconnaîtrait pas,
 * laisserait la portée vide, et le repository lèverait
 * `MissingTenantContextError` — un 500 déclenchable à volonté depuis l'extérieur
 * sur une surface non authentifiée, là où la réponse juste est 200 ou 404.
 * `normalizeSlug` abaisse ensuite la casse du segment, si bien que les deux
 * écritures désignent bien le même établissement.
 */
const PUBLIC_PATH_PATTERN = new RegExp(
  `^/api/v\\d+/${PUBLIC_ROUTE_SEGMENT}(?:/(?<slug>[^/]*))?(?:/|$)`,
  'i',
);

/**
 * ## Les noms réservés viennent du contrat partagé — #837
 *
 * `RESERVED_TENANT_SLUGS` et `DNS_LABEL_PATTERN` vivaient ici, en copies
 * locales. Ils vivent désormais dans `@spa/shared`, et ce fichier les
 * **importe** : la même liste sert à refuser la création d'un salon
 * (`slugSchema`), à refuser sa résolution ici, et à ne pas router son
 * sous-domaine côté web (#838). Trois copies d'une liste de noms se
 * désynchronisent au premier ajout, et le symptôme — un salon créable puis
 * injoignable — n'apparaît qu'en déployé.
 *
 * Sans cette liste, déployer l'API sur `api.exemple.test` alors que le front est
 * sur `exemple.test` ferait lire « établissement *api* » à chaque requête — donc
 * un désaccord avec le segment d'URL, donc **404 sur tout l'espace public**.
 * C'est un piège d'exploitation, pas une hypothèse : c'est la topologie normale
 * d'un déploiement, et `origin` s'y ajoute depuis l'ADR 0009, qui le réserve
 * pour joindre l'équilibreur derrière le CDN.
 *
 * ## Elle s'applique maintenant aux deux sources, et pas seulement à l'hôte
 *
 * Jusqu'à #837, un slug **en chemin** échappait à la liste, au motif qu'un
 * établissement pouvait légitimement s'appeler ainsi. Ce motif est tombé avec le
 * critère 2 : `slugSchema` refuse désormais ces noms à la création, donc aucun
 * établissement légitime ne peut plus en porter un. Ce qui reste — une ligne
 * écrite avant ce ticket — est précisément ce que le critère 5 demande de
 * refuser : « une requête publique reçue sur un label réservé rend 404 », quelle
 * que soit la source qui l'a désigné.
 *
 * `SLUG_MAX_LENGTH` vient de la même source : `Tenant.slug` est un
 * `VARCHAR(63)`, et c'est aussi la borne d'un label DNS (RFC 1035 §2.3.4).
 * Au-delà, aucun établissement ne peut correspondre.
 */

/** Ce que la requête dit de l'établissement — avant toute vérification. */
export type PublicTenantDesignation =
  /** Requête hors de l'espace public : rien à résoudre, la portée reste vide. */
  | { readonly kind: 'none' }
  /**
   * Requête publique dont aucun établissement ne peut être tiré : slug absent,
   * mal formé, trop long, **réservé**, ou sources qui se contredisent. L'appelant répond
   * 404 — **le même** 404 qu'un slug inconnu, pour ne pas distinguer « mal
   * écrit » de « n'existe pas ».
   */
  | { readonly kind: 'unresolvable' }
  | { readonly kind: 'slug'; readonly slug: string; readonly source: 'path' | 'subdomain' };

/** Le chemin seul — sans la chaîne de requête, qui peut porter n'importe quoi. */
function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * La forme canonique d'un slug, ou `null` si ce n'en est pas un.
 *
 * Le décodage vient en premier : `%73alon` et `salon` désignent le même chemin
 * pour Express, et deux réponses différentes ici seraient une incohérence
 * exploitable. Un décodage impossible (`%zz`) n'est pas une erreur à remonter —
 * c'est simplement une chaîne qui n'est pas un slug.
 */
function normalizeSlug(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }

  const slug = decoded.trim().toLowerCase();
  if (slug.length === 0 || slug.length > SLUG_MAX_LENGTH) {
    return null;
  }
  return DNS_LABEL_PATTERN.test(slug) ? slug : null;
}

/**
 * Le nom d'hôte nu — sans port, sans point final, en minuscules.
 *
 * Un littéral IPv6 (`[::1]:3000`) rend `null` : il n'a pas d'étiquettes, donc
 * pas de sous-domaine, et le découper sur `:` produirait n'importe quoi.
 */
function hostnameOf(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith('[')) {
    return null;
  }

  const withoutPort = trimmed.split(':', 1)[0] ?? '';
  // Le point final d'un FQDN (`exemple.test.`) désigne le même hôte.
  const host = withoutPort.toLowerCase().replace(/\.$/, '');
  return host.length === 0 ? null : host;
}

/**
 * Le domaine sous lequel un sous-domaine désigne un établissement, tiré de
 * `APP_URL`.
 *
 * Le borner à un domaine connu est ce qui rend la lecture du sous-domaine sûre.
 * Sans cette borne, « la première étiquette de l'hôte » désignerait un
 * établissement sur **n'importe quel** hôte — à commencer par le DNS de
 * l'équilibreur de charge (`spa-prod-alb-1.eu-west-3.elb.amazonaws.com`), dont
 * la première étiquette a la forme d'un slug. Tout l'espace public répondrait
 * alors 404 en déployé, et jamais en local.
 *
 * `www.` est retiré : le front servi sur `www.exemple.test` n'empêche pas
 * `salon-des-lilas.exemple.test` de désigner un salon.
 *
 * ## Une seule règle pour lire et pour écrire — #837
 *
 * Le calcul est délégué à `tenantBaseHost` de `@spa/shared`, qui sert aussi à
 * **composer** l'adresse publique d'un salon (`tenantPublicUrl`, le lien
 * d'annulation des e-mails). Deux implémentations de « l'hôte de base » — l'une
 * qui lit, l'autre qui écrit — finiraient par diverger sur le `www.`, et le
 * symptôme serait un lien d'e-mail que le middleware ne sait pas relire.
 * `publicBaseHost` reste le nom sous lequel l'API l'appelle : c'est lui qui dit
 * *à quoi* la valeur sert de ce côté-ci.
 */
export function publicBaseHost(appUrl: string): string | null {
  return tenantBaseHost(appUrl);
}

/**
 * L'établissement désigné par le sous-domaine, ou `null`.
 *
 * Une seule étiquette au-dessus du domaine de base : `a.b.exemple.test` ne
 * désigne pas l'établissement « a.b », ni « a ». Accepter un préfixe de
 * plusieurs étiquettes reviendrait à laisser un hôte arbitraire choisir son
 * établissement pourvu qu'il finisse bien.
 */
export function readSubdomainSlug(host: string | undefined, baseHost: string | null): string | null {
  const requestHost = hostnameOf(host);
  if (requestHost === null || baseHost === null) {
    return null;
  }

  const suffix = `.${baseHost}`;
  if (!requestHost.endsWith(suffix)) {
    return null;
  }

  const label = requestHost.slice(0, requestHost.length - suffix.length);
  if (label.length === 0 || label.includes('.')) {
    return null;
  }

  const slug = normalizeSlug(label);
  if (slug === null || isReservedTenantSlug(slug)) {
    return null;
  }
  return slug;
}

/**
 * Ce que la requête désigne comme établissement.
 *
 * `url` est l'URL **d'origine** (`request.originalUrl`) : Express réécrit
 * `request.url` selon le point de montage du middleware, et une lecture qui en
 * dépendrait changerait de sens le jour où le montage change.
 */
export function describePublicTenantRequest(
  url: string,
  host: string | undefined,
  baseHost: string | null,
): PublicTenantDesignation {
  const match = PUBLIC_PATH_PATTERN.exec(pathOf(url));
  if (match === null) {
    return { kind: 'none' };
  }

  const subdomainSlug = readSubdomainSlug(host, baseHost);
  const rawSegment = match.groups?.['slug'] ?? '';

  // Pas de segment d'établissement (`/api/v1/public`, ou une route publique qui
  // n'en porte pas) : le sous-domaine est alors la seule désignation possible.
  if (rawSegment.length === 0) {
    return subdomainSlug === null
      ? { kind: 'unresolvable' }
      : { kind: 'slug', slug: subdomainSlug, source: 'subdomain' };
  }

  // Un label réservé ne désigne aucun établissement, d'où qu'il vienne
  // (critère 5 de #837). Le refuser **ici** plutôt qu'à la résolution en base
  // est ce qui le fait rendre 404 même pour une ligne écrite avant que
  // `slugSchema` ne refuse ces noms à la création.
  const pathSlug = normalizeSlug(rawSegment);
  if (pathSlug === null || isReservedTenantSlug(pathSlug)) {
    return { kind: 'unresolvable' };
  }

  // Les deux sources désignent un établissement, et pas le même. On ne tranche
  // pas : la requête est refusée.
  if (subdomainSlug !== null && subdomainSlug !== pathSlug) {
    return { kind: 'unresolvable' };
  }

  return { kind: 'slug', slug: pathSlug, source: 'path' };
}
