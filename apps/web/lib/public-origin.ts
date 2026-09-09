/**
 * Origine publique du front — celle sous laquelle un visiteur, un moteur de
 * recherche ou un lien de notification voit ce déploiement (#345).
 *
 * ## Pourquoi une garde, et pas seulement une valeur par défaut
 *
 * La page publique du salon (#43) compose son `metadataBase`, sa balise
 * canonique, l'`@id` et l'`url` de son graphe schema.org, ainsi que l'`url` de
 * chaque `Offer`, à partir de cette origine. Sans `APP_URL`, elle retombait
 * silencieusement sur `http://localhost:3000` : le rendu restait correct, la
 * page s'affichait, les tests passaient — et le référencement publiait des
 * canoniques pointant sur la machine de personne. Une panne sans erreur, sans
 * log et sans symptôme visible avant que le mal ne soit fait.
 *
 * D'où le partage en deux fonctions :
 *
 *   * {@link resolvePublicOrigin} lit la valeur, avec le repli de développement
 *     — c'est ce que les pages appellent, à chaque rendu ;
 *   * {@link publicOriginProblem} dit ce qui cloche, et {@link assertPublicOrigin}
 *     le transforme en arrêt du processus (`instrumentation.ts`). Le serveur
 *     meurt plutôt que de servir des canoniques fausses.
 *
 * La vérification est dans le hook d'instrumentation et non dans le rendu d'une
 * page : elle est ainsi la **même pour toutes les routes** et elle tombe sur la
 * toute première requête servie — en déployé, le contrôle de santé de l'ALB. La
 * tâche s'arrête sans jamais entrer dans le groupe cible, et le disjoncteur de
 * déploiement ECS revient de lui-même à la révision précédente. Attention : en
 * production le hook n'est pas joué à l'ouverture du port mais à cette première
 * requête — voir l'en-tête d'`instrumentation.ts`.
 *
 * ## Ce qui est refusé, et seulement hors développement
 *
 * `next dev` et les tests tournent sur `http://localhost:3000` : les y refuser
 * empêcherait de travailler. La garde ne s'arme donc que lorsque `NODE_ENV` vaut
 * autre chose que `development` ou `test` — ce que pose l'image d'exécution
 * (`apps/web/Dockerfile` : `ENV NODE_ENV=production`).
 */

/** Nom de la variable qui porte l'origine publique, ici et dans Terraform. */
export const PUBLIC_ORIGIN_ENV = 'APP_URL';

/** Repli employé en développement et en test, où il n'y a pas d'origine publique. */
export const DEVELOPMENT_PUBLIC_ORIGIN = 'http://localhost:3000';

/**
 * Hôtes qui ne désignent que la machine courante. Un déploiement qui les publie
 * envoie chaque visiteur — et chaque robot d'indexation — chez lui-même.
 *
 * `0.0.0.0` et `::` sont des adresses d'écoute, pas des adresses de destination :
 * les voir ici veut dire que quelqu'un a recopié la valeur de `HOSTNAME`.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '0.0.0.0', '[::]', '[::1]']);

/** Sous-réseau de bouclage IPv4 — `127.0.0.1`, mais aussi tout le `/8`. */
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

/**
 * Environnement lu par les fonctions de ce module. `process.env` s'y conforme ;
 * le prendre en paramètre est ce qui rend la garde testable sans toucher au
 * processus, donc sans que deux tests parallèles se marchent dessus.
 */
export type OriginEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Vrai en développement et en test, les deux seuls modes où `localhost` est
 * légitime — `next dev` pose `development`, Vitest pose `test`, et le banc E2E
 * force `development` pour que les cookies de session ne soient pas `secure`
 * (`apps/web/playwright.config.ts`).
 *
 * Un `NODE_ENV` absent **arme** la garde plutôt que de la relâcher : la seule
 * façon de se retrouver là est de lancer le serveur autonome sans la variable
 * que l'image pose (`apps/web/Dockerfile`), et c'est exactement le cas où l'on
 * veut échouer bruyamment.
 */
function isDevelopmentLike(env: OriginEnvironment): boolean {
  const mode = env['NODE_ENV'];

  return mode === 'development' || mode === 'test';
}

/** L'origine sans sa barre oblique finale — `https://x.fr/` et `https://x.fr` sont la même. */
function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Ce qui empêche cette valeur d'être une origine publique utilisable, ou `null`
 * si elle en est une. La phrase rendue est destinée aux journaux du conteneur :
 * elle nomme la variable, ce qu'elle vaut et ce qu'on en attend.
 *
 * Elle ne consulte **pas** `NODE_ENV` : elle décrit ce qui cloche, où qu'on soit.
 * C'est {@link assertPublicOrigin} qui décide de n'en tenir compte qu'hors
 * développement. Un appelant qui journaliserait ce verdict tel quel parlerait
 * donc aussi en `next dev`, où `localhost` est légitime — il lui faut
 * {@link assertPublicOrigin}, ou sa propre garde sur le mode.
 */
export function publicOriginProblem(env: OriginEnvironment): string | null {
  const raw = env[PUBLIC_ORIGIN_ENV];

  if (raw === undefined || raw.trim() === '') {
    return `${PUBLIC_ORIGIN_ENV} est absente : les canoniques et les données structurées de la page publique du salon retomberaient sur ${DEVELOPMENT_PUBLIC_ORIGIN}.`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return `${PUBLIC_ORIGIN_ENV} vaut « ${raw} », qui n'est pas une URL absolue. Attendu : l'origine publique de l'environnement, par exemple https://reservation.exemple.fr.`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${PUBLIC_ORIGIN_ENV} vaut « ${raw} », dont le schéma « ${parsed.protocol} » n'est ni http ni https.`;
  }

  // `hostname` d'une URL IPv6 rend `[::1]` crochets compris ; la comparaison se
  // fait donc sur la forme entre crochets, celle que porte l'ensemble.
  //
  // Rien ne garde contre un hôte vide, et rien n'a à le faire : `http` et
  // `https` sont des schémas « spéciaux » au sens de la norme URL, pour lesquels
  // l'analyseur exige un hôte — `new URL('http://')` lève, et `http:///x` voit
  // ses barres obliques repliées en `http://x/`.
  const host = parsed.hostname.toLowerCase();

  if (LOCAL_HOSTNAMES.has(host) || host.endsWith('.localhost') || IPV4_LOOPBACK.test(host)) {
    return `${PUBLIC_ORIGIN_ENV} vaut « ${raw} », qui ne désigne que la machine courante. Un déploiement doit porter l'origine publique de son environnement.`;
  }

  // Des identifiants dans l'URL finiraient en clair dans chaque balise canonique
  // et dans chaque `Offer` du graphe schema.org — c'est-à-dire publiés.
  if (parsed.username !== '' || parsed.password !== '') {
    return `${PUBLIC_ORIGIN_ENV} vaut « ${raw} », qui porte des identifiants. Une origine publique est publiée telle quelle dans les balises canoniques : elle ne doit rien contenir de personnel.`;
  }

  // Une **origine**, pas une URL de base : `salonUrl` concatène cette valeur et
  // le chemin de la page. Un `https://exemple.fr/reservation` produirait des
  // canoniques `https://exemple.fr/reservation/maison-lotus`, qui ne répondent
  // nulle part. C'est la contrainte qu'exprime déjà la variable Terraform
  // `public_base_url` ; elle vaut aussi quand la valeur vient d'un `.env` ou
  // d'une variable de dépôt, que Terraform ne relit pas.
  if (withoutTrailingSlash(parsed.pathname) !== '' || parsed.search !== '' || parsed.hash !== '') {
    return `${PUBLIC_ORIGIN_ENV} vaut « ${raw} », qui porte un chemin, une requête ou un fragment. Attendu : l'origine seule, par exemple https://reservation.exemple.fr.`;
  }

  return null;
}

/**
 * Origine publique de ce déploiement, sans barre oblique finale.
 *
 * Lue d'`APP_URL` et **non** de l'en-tête `Host` de la requête : un en-tête est
 * fourni par l'appelant, et le recopier dans une URL canonique ou dans des
 * données structurées laisserait un tiers désigner le domaine que les moteurs
 * associeront au salon.
 *
 * Sans préfixe `NEXT_PUBLIC_` : elle n'est lue que côté serveur, au rendu.
 */
export function resolvePublicOrigin(env: OriginEnvironment = process.env): string {
  const raw = env[PUBLIC_ORIGIN_ENV];

  if (raw === undefined || raw.trim() === '') {
    return DEVELOPMENT_PUBLIC_ORIGIN;
  }

  return withoutTrailingSlash(raw.trim());
}

/**
 * Lève quand l'origine publique est inutilisable, hors développement. Appelée
 * par `instrumentation.ts`, qui traduit l'exception en `process.exit(1)` — c'est
 * là, et non ici, que se décide l'arrêt du conteneur, parce que lever ne suffit
 * pas à faire sortir le serveur autonome de Next (voir son en-tête).
 */
export function assertPublicOrigin(env: OriginEnvironment = process.env): void {
  if (isDevelopmentLike(env)) {
    return;
  }

  const problem = publicOriginProblem(env);

  if (problem !== null) {
    throw new Error(
      `Origine publique inutilisable — le front s'arrête au lieu de servir. ${problem} ` +
        `En déployé, cette variable est posée par la définition de tâche ECS du service web (infra/terraform/envs/*).`,
    );
  }
}
