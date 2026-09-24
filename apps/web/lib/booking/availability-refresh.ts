/**
 * La cadence à laquelle l'étape créneau repose sa question au serveur (#1153).
 *
 * ## Le défaut corrigé
 *
 * `slot-step.tsx` revalidait toutes les **soixante secondes**, et c'était trop
 * long : un horaire pris dans un autre onglet ou au comptoir restait proposé
 * dix-sept secondes après coup, et la collision n'apparaissait qu'à la
 * confirmation. Le CDC §1.4 parle de *calendrier de disponibilité temps réel*
 * et §2.3 de *créneaux en direct* ; l'issue chiffre l'attente tolérable à cinq
 * secondes.
 *
 * ## Pourquoi une cadence variable, et non simplement « cinq secondes »
 *
 * La minute d'avant ne tenait pas à la paresse mais à un coût : une page laissée
 * ouverte une après-midi ferait, à cinq secondes, quelques milliers d'appels sur
 * une route qui **calcule** — six lectures et un découpage par pas de quinze
 * minutes sur trente et un jours. Et ce coût n'est pas seulement du serveur :
 * `GET /public/{slug}/availability` porte un quota de cent vingt appels par
 * minute **et par adresse**, or une action serveur Next sort par l'adresse du
 * serveur Next. L'API y voit une seule adresse pour tous les visiteurs du tunnel
 * — c'est le défaut de comptage que #860 puis #1127 ont corrigé sur les routes
 * d'authentification, et qui subsiste ici.
 *
 * La cadence courte est donc réservée aux écrans devant lesquels **il y a
 * quelqu'un**, et trois conditions la relâchent :
 *
 * 1. l'onglet est caché — personne ne regarde, on ne demande rien du tout ;
 * 2. aucun geste depuis `PRESENCE_WINDOW_MS` — l'écran a été laissé ouvert ;
 * 3. la dernière revalidation a été **refusée** — panne, ou quota atteint : la
 *    reprise s'élargit au lieu d'insister.
 *
 * Le repli ne dépasse jamais `MAX_REFRESH_MS`, qui est la minute d'avant : quoi
 * qu'il arrive, cette correction ne peut pas rendre l'écran plus périmé qu'il ne
 * l'était.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne sait rien des créneaux : il appelle ce qu'on lui donne et lit un
 * booléen. C'est ce qui le rend éprouvable seul, minuteries en main, là où la
 * même logique fondue dans l'effet du composant ne se vérifiait qu'au travers
 * d'un rendu complet.
 *
 * ## Et le flux SSE des rendez-vous ?
 *
 * `GET /v1/appointments/stream` existe (#1116) et livre ses événements en un
 * ou deux dixièmes de seconde — mais il ne peut pas servir **cet** écran :
 * `AppointmentFeed.reaches` ne laisse passer à un périmètre `client` que les
 * rendez-vous de la cliente elle-même, et le tunnel est de toute façon public
 * (`reservation/layout.tsx`). Un créneau pris par **une autre** cliente n'y est
 * donc jamais annoncé. Le rendre visible demanderait un périmètre de flux
 * « disponibilité », côté API.
 */

/** Cadence tant que quelqu'un regarde l'écran — le seuil que #1153 fixe. */
export const PRESENT_REFRESH_MS = 5_000;

/** Cadence de repli, celle d'avant #1153, quand l'écran est resté seul. */
export const IDLE_REFRESH_MS = 60_000;

/** Plafond absolu : le repli ne rend jamais l'écran plus périmé qu'avant #1153. */
export const MAX_REFRESH_MS = 60_000;

/**
 * Durée pendant laquelle un geste vaut présence.
 *
 * Deux minutes : c'est plus long que l'hésitation devant une grille d'horaires,
 * et assez court pour qu'un onglet oublié retombe vite sur la cadence lente. Le
 * moindre mouvement de souris, frappe ou défilement la rouvre — on ne demande
 * pas à la visiteuse de cliquer pour prouver qu'elle est là.
 */
export const PRESENCE_WINDOW_MS = 120_000;

/**
 * Nombre de doublements pris en compte après des refus successifs.
 *
 * Le plafond suffirait à borner le délai ; ce clamp borne l'**exposant**, pour
 * qu'un écran refusé pendant une heure ne calcule pas `2 ** 700`.
 */
const REFUSAL_BACKOFF_STEPS = 5;

/**
 * Les gestes qui valent présence.
 *
 * `pointermove` en fait partie et ce n'est pas un excès : poser sa souris sur
 * l'écran en lisant les horaires est le geste le plus courant de cette étape, et
 * il ne produit aucun clic. Tous les écouteurs sont passifs et n'écrivent qu'un
 * horodatage — ils ne peuvent ni retarder un défilement ni provoquer un rendu.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel'] as const;

/** Ce dont dépend le prochain délai — tout ce qui le décide, et rien d'autre. */
export interface RefreshCadence {
  /** Temps écoulé depuis le dernier geste de la visiteuse, en millisecondes. */
  readonly sinceLastActivityMs: number;
  /** Nombre de revalidations refusées d'affilée — zéro après une réponse. */
  readonly consecutiveRefusals: number;
}

/**
 * Le délai avant la prochaine revalidation.
 *
 * Pure, et exportée pour être éprouvée telle quelle : c'est la seule décision de
 * ce module, et elle tient en trois lignes qu'on ne veut pas relire au travers
 * d'un composant.
 */
export function nextRefreshDelay(cadence: RefreshCadence): number {
  const base =
    cadence.sinceLastActivityMs < PRESENCE_WINDOW_MS ? PRESENT_REFRESH_MS : IDLE_REFRESH_MS;
  const widened = base * 2 ** Math.min(Math.max(cadence.consecutiveRefusals, 0), REFUSAL_BACKOFF_STEPS);

  return Math.min(widened, MAX_REFRESH_MS);
}

/**
 * Ce que la boucle appelle : une revalidation, et le fait de savoir si elle a
 * abouti.
 *
 * `false` couvre aussi bien une panne qu'un quota atteint — la conduite est la
 * même, on s'écarte. La distinction appartient à l'écran, qui a une phrase à
 * afficher ; la boucle, elle, n'a qu'un rythme à choisir.
 */
export type Revalidate = () => Promise<boolean>;

/**
 * Arme la revalidation périodique de l'étape créneau, et rend de quoi la
 * débrancher.
 *
 * Elle ne déclenche **rien** à l'armement : le premier chargement appartient à
 * l'écran, qui doit d'abord vider ce qu'il affichait. Elle prend la suite.
 *
 * Deux garanties tiennent le coût :
 *
 * - une seule minuterie en vol à tout instant — `schedule` efface avant de
 *   poser ;
 * - jamais deux appels en parallèle : tant qu'une revalidation n'a pas rendu, le
 *   battement suivant se contente de reprogrammer. Sans cela, une API lente à
 *   plus de cinq secondes verrait les requêtes s'empiler.
 */
export function startAvailabilityRefresh(revalidate: Revalidate): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivityAt = Date.now();
  let consecutiveRefusals = 0;
  let inFlight = false;
  let stopped = false;

  /** Le battement suivant, à la cadence que l'état du moment commande. */
  function schedule(): void {
    scheduleIn(
      nextRefreshDelay({
        sinceLastActivityMs: Date.now() - lastActivityAt,
        consecutiveRefusals,
      }),
    );
  }

  /** Pose l'unique minuterie en vol — elle efface celle qu'elle remplace. */
  function scheduleIn(delay: number): void {
    if (stopped) {
      return;
    }

    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  function tick(): void {
    // Un onglet caché n'a personne devant lui : le rafraîchir consommerait des
    // requêtes pour un écran que nul ne regarde. Et le repos se prend au
    // plafond, pas à la cadence de présence : sans cela, les deux premières
    // minutes d'un onglet caché réveilleraient le fil toutes les cinq secondes
    // pour ne rien faire — `lastActivityAt` ne bouge plus une fois l'onglet
    // quitté, mais il lui faut encore `PRESENCE_WINDOW_MS` pour le dire. Le
    // retour sur l'onglet ne patiente pas pour autant : `onVisibility`
    // revalide sur-le-champ.
    if (document.visibilityState !== 'visible') {
      scheduleIn(MAX_REFRESH_MS);
      return;
    }

    if (inFlight) {
      schedule();
      return;
    }

    run();
  }

  function run(): void {
    inFlight = true;

    void revalidate()
      .then((answered) => {
        consecutiveRefusals = answered ? 0 : consecutiveRefusals + 1;
      })
      .catch(() => {
        consecutiveRefusals += 1;
      })
      .finally(() => {
        inFlight = false;
        schedule();
      });
  }

  function seen(): void {
    lastActivityAt = Date.now();
  }

  function onVisibility(): void {
    if (document.visibilityState !== 'visible') {
      // Rien à débrancher : le battement suivant verra l'onglet caché et se
      // repliera au plafond de lui-même.
      return;
    }

    // Revenir sur l'onglet est un geste, et ce qu'on y lit peut dater de
    // plusieurs minutes : on ne patiente pas jusqu'au prochain battement.
    //
    // Le compteur de refus n'est **pas** remis à zéro pour autant : revenir sur
    // l'onglet ne prouve rien de l'API. Le remettre à zéro rendait le repli
    // inopérant dans le seul cas pour lequel il existe — un quota atteint, que
    // l'on partage avec tous les visiteurs du tunnel : une visiteuse qui fait
    // l'aller-retour entre deux onglets repartait à cinq secondes à chaque
    // retour, donc réalimentait la saturation qu'on cherche à dégonfler. La
    // revalidation ci-dessous tranche d'elle-même : elle remet le compteur à
    // zéro dès qu'une réponse arrive.
    seen();

    if (inFlight) {
      schedule();
      return;
    }

    run();
  }

  for (const type of ACTIVITY_EVENTS) {
    document.addEventListener(type, seen, { passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);

    for (const type of ACTIVITY_EVENTS) {
      document.removeEventListener(type, seen);
    }
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
