import { ApiClientError, refreshSession, type ApiSession } from '@/lib/api-client';
import { sitePath } from '@/lib/site-path';

/**
 * Le renouvellement de session côté serveur Next, commun au back-office et à
 * l'espace client (#856).
 *
 * Les deux surfaces gardent leurs cookies, leurs chemins et leurs refus : ce
 * module ne porte que ce qu'elles décidaient chacune de leur côté, et qui ne
 * doit pas diverger — **quand** un renouvellement raté ferme la session, et
 * **comment** une action serveur se renouvelle avant d'appeler l'API.
 */

/**
 * `true` si l'API a refusé le jeton de rafraîchissement — la seule issue d'un
 * renouvellement qui ferme la session.
 *
 * Un 429 du limiteur de débit, un 503, une coupure réseau ne disent rien du
 * jeton : effacer les cookies sur cette foi-là déconnecterait pour de bon une
 * session valide. Le limiteur n'est pas hypothétique — il compte désormais par
 * session et non plus par adresse (#860), mais un quota par session reste un
 * quota, et deux onglets d'un même poste savent l'atteindre.
 *
 * Le perdant d'une course entre deux renouvellements n'est pas un refus non
 * plus : l'API lui rend un jeton d'accès, sans cookie de rafraîchissement
 * (voir `AuthService.refresh`), et son renouvellement aboutit.
 */
export function isRefreshRefused(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

/**
 * Les motifs qu'un écran de connexion sait expliquer — et le vocabulaire des
 * deux surfaces, écrit une fois (#860).
 *
 * Il n'y en avait qu'un, et c'était le défaut : `session-expiree` s'affichait,
 * ou rien du tout, quelle que soit la raison. Une session que le limiteur
 * refuse de renouveler n'est pas une session expirée — elle est parfaitement
 * valide, ses cookies sont en place, et lui dire le contraire envoie ressaisir
 * un mot de passe dont personne n'avait besoin.
 *
 * Le motif voyage dans l'URL (`?motif=`) parce que c'est une **redirection** qui
 * l'émet : une route ne rend pas d'écran, elle en désigne un, et ce qu'elle a à
 * transmettre ne peut passer que par là.
 */
export const SESSION_NOTICES = ['session-expiree', 'renouvellement-indisponible'] as const;

export type SessionNotice = (typeof SESSION_NOTICES)[number];

/**
 * Le motif qu'un renouvellement échoué doit afficher.
 *
 * Les deux branches sont exactement celles d'`isRefreshRefused` : seul un refus
 * du jeton ferme la session, tout le reste est momentané.
 */
export function sessionNoticeFor(error: unknown): SessionNotice {
  return isRefreshRefused(error) ? 'session-expiree' : 'renouvellement-indisponible';
}

/**
 * Le motif porté par `?motif=`, ou `null` si le paramètre n'en nomme aucun.
 *
 * Un paramètre d'URL est fourni par l'appelant : il peut être absent, répété
 * (`?motif=a&motif=b`, que Next rend comme un tableau) ou inventé. Rien n'en
 * sort qui ne soit l'un des motifs déclarés — un écran ne doit pas pouvoir
 * afficher un encart que personne n'a écrit.
 */
export function readSessionNotice(
  value: string | readonly string[] | undefined,
): SessionNotice | null {
  const candidate = typeof value === 'string' ? value : value?.[0];

  return SESSION_NOTICES.find((notice) => notice === candidate) ?? null;
}

/**
 * Le paramètre d'URL qui dit qu'un écran revient déjà d'un renouvellement
 * déclenché par un 401 (#861).
 *
 * ## Pourquoi un marqueur, et pourquoi dans l'URL
 *
 * Un 401 reçu **avec** un cookie d'accès en main vaut un renouvellement : le
 * secret de l'API a pu changer au déploiement, son horloge dériver, ou le rendu
 * durer plus longtemps que la marge de trente secondes du cookie. Aucune de ces
 * trois causes ne survit à une session neuve — mais une quatrième, elle, y
 * survivrait : une API qui refuse jusqu'aux jetons qu'elle vient d'émettre.
 * Renvoyer l'écran au renouvellement à chaque passage produirait alors une
 * chaîne de redirections que le navigateur coupe par une page d'erreur.
 *
 * Le marqueur borne la tentative à **une seule** : il part avec le chemin de
 * retour confié à la route de renouvellement, revient avec lui, et le second
 * 401 mène à la connexion — c'est-à-dire exactement ce que faisait le premier
 * avant ce ticket.
 *
 * Il voyage par l'URL et non par un cookie parce que la session est **deux
 * cookies `httpOnly`, et rien d'autre** (#47, cinquième critère) : un troisième,
 * fût-il transitoire, ouvrirait cette porte-là. Le prix est un paramètre qui
 * reste dans la barre d'adresse après un renouvellement réussi ; il est ignoré
 * de tous les écrans, et disparaît à la première navigation.
 */
export const RENEWAL_PARAM = 'session';

/** La seule valeur que `RENEWAL_PARAM` porte jamais. */
const RENEWAL_ATTEMPTED = 'renouvelee';

/**
 * `true` si l'écran courant revient d'un renouvellement déclenché par un 401.
 *
 * Le paramètre vient de l'URL : il peut être absent, répété (`?session=a&session=b`,
 * que Next rend comme un tableau) ou inventé. Seule la valeur déclarée compte —
 * tout le reste vaut « aucune tentative », c'est-à-dire la branche qui renouvelle.
 */
export function isRenewalReturn(value: string | readonly string[] | undefined): boolean {
  return (typeof value === 'string' ? value : value?.[0]) === RENEWAL_ATTEMPTED;
}

/** Une origine factice : elle ne sert qu'à recomposer un chemin, jamais émise. */
const MARKER_ORIGIN = 'http://site.invalid';

/**
 * Le chemin de retour à confier à la route de renouvellement — celui de l'écran,
 * marqué.
 *
 * Le marqueur est **posé** et non ajouté : un chemin qui le porterait déjà ne
 * doit pas en recevoir un second, sans quoi `?session=renouvelee&session=renouvelee`
 * finirait par rallonger l'URL à chaque tour.
 *
 * Un chemin que `sitePath` refuse est rendu tel quel : la route de renouvellement
 * le revalide de toute façon et retombe sur l'accueil de sa surface, et c'est
 * elle qui doit trancher — pas ce calcul de chaîne.
 */
export function renewalReturnTo(currentPath: string): string {
  const path = sitePath(currentPath);

  if (path === null) {
    return currentPath;
  }

  const url = new URL(path, MARKER_ORIGIN);
  url.searchParams.set(RENEWAL_PARAM, RENEWAL_ATTEMPTED);

  return `${url.pathname}${url.search}${url.hash}`;
}

/** Ce qu'une surface expose de sa session à une action serveur. */
export interface ActionSessionStore {
  readAccessToken(): Promise<string | null>;
  readRefreshToken(): Promise<string | null>;
  /** Pose la session renouvelée — une action serveur a le droit d'écrire un cookie. */
  write(renewed: ApiSession): Promise<void>;
}

/** Le jeton d'une action, ou la raison pour laquelle elle n'en a pas. */
export type ActionAccess =
  | { readonly kind: 'ready'; readonly accessToken: string }
  /** Plus rien à renouveler : l'écran part vers la route de renouvellement, qui tranche. */
  | { readonly kind: 'expired' }
  /** Le renouvellement a échoué sans rien dire du jeton — l'écran affiche l'erreur. */
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Le jeton d'accès d'une action serveur — **renouvelé sur place** quand le
 * cookie a expiré.
 *
 * ## Pourquoi l'action se renouvelle elle-même
 *
 * Le cookie d'accès vit un quart d'heure, un écran de comptoir reste ouvert une
 * journée. Sans renouvellement ici, l'enregistrement tenté après la pause
 * revenait en `UNAUTHORIZED`, l'écran partait se renouveler et revenait vide :
 * la saisie était perdue alors que la session, elle, était parfaitement
 * valide. Une action serveur a le droit de poser un cookie — un Server
 * Component ne l'a pas, d'où la route de renouvellement des pages —, rien ne
 * l'oblige donc à sortir pour cela.
 *
 * ## Ce qui reste à l'écran
 *
 * - `expired` : pas de cookie de rafraîchissement, ou l'API le refuse. L'action
 *   rend `UNAUTHORIZED`, et l'écran part vers la route de renouvellement, qui
 *   efface les cookies et mène à la connexion. Les cookies ne sont **pas**
 *   effacés ici : un seul endroit en décide, et c'est la route ;
 * - `failed` : limiteur, panne, coupure. L'écran affiche l'erreur et la saisie
 *   reste en place — un nouvel essai pourra aboutir.
 */
export async function accessTokenForAction(store: ActionSessionStore): Promise<ActionAccess> {
  const accessToken = await store.readAccessToken();

  if (accessToken !== null) {
    return { kind: 'ready', accessToken };
  }

  const refreshToken = await store.readRefreshToken();

  if (refreshToken === null) {
    return { kind: 'expired' };
  }

  try {
    const renewed = await refreshSession(refreshToken);
    await store.write(renewed);
    return { kind: 'ready', accessToken: renewed.session.accessToken };
  } catch (error) {
    return isRefreshRefused(error) ? { kind: 'expired' } : { kind: 'failed', error };
  }
}
