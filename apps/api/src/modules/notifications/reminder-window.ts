/**
 * La règle horaire du rappel J-1 — **fonctions pures**, sans Nest, sans Prisma,
 * sans horloge implicite.
 *
 * Quatre des cinq critères d'acceptation de #71 se décident ici et nulle part
 * ailleurs : la fenêtre `now+24h → now+25h`, l'exclusion d'un rendez-vous pris à
 * moins de 24 h, la revérification au moment de l'envoi, et l'interdiction du
 * rappel « en retard ». Les mettre dans un service injectable aurait obligé
 * chaque assertion à monter un module Nest pour comparer deux instants ; ce sont
 * des fonctions de `(instants) → verdict`, et leurs tests le sont aussi.
 *
 * ## Tout est UTC, et il n'y a rien à convertir
 *
 * CLAUDE.md pose la règle — « tout est stocké en UTC, converti à l'affichage
 * selon le fuseau du tenant » — et notifications §3 la précise pour ce
 * message-ci : « le rappel est calculé dans le fuseau du tenant pour l'affichage
 * de l'heure, mais **la sélection se fait en UTC** ».
 *
 * Ce fichier ne fait que de la sélection. Il ne manipule que des `Date`, qui
 * sont des **instants** — un nombre de millisecondes depuis l'époque, sans
 * fuseau — et n'appelle ni `getHours()`, ni `toISOString()`, ni `Intl` : autant
 * de fonctions qui feraient entrer un calendrier local dans un calcul qui n'en a
 * pas besoin. La conséquence est qu'un changement d'heure ne peut pas décaler la
 * fenêtre : « dans 24 heures » vaut 24 heures partout, y compris la nuit où le
 * salon en vit 23 ou 25. L'affichage du message, lui, passe bien par le fuseau
 * de l'établissement — c'est le travail de `notification-content.ts`.
 */

/** Une heure en millisecondes. */
const HOUR_MS = 3_600_000;

/**
 * L'avance du rappel : 24 heures, le J-1 du CDC §1.4.
 *
 * C'est la borne **basse** de la fenêtre de sélection, et c'est aussi elle qui
 * fonde le deuxième critère d'acceptation : un rendez-vous pris à moins de 24 h
 * ne peut, par construction, jamais entrer dans une fenêtre à venir — l'écart
 * entre l'instant présent et son début ne fait que décroître, et il est déjà
 * sous la borne. Aucune règle supplémentaire n'est nécessaire pour l'exclure, et
 * c'est bien ainsi : une seconde règle aurait pu diverger de celle-ci.
 */
export const REMINDER_LEAD_MS = 24 * HOUR_MS;

/**
 * La largeur de la fenêtre — une heure, soit la période du balayage.
 *
 * Les deux valeurs sont **la même chose** vue de deux côtés, et c'est ce qui
 * rend le balayage exhaustif sans être redondant : les fenêtres successives
 * `[T+24h, T+25h)`, `[T+25h, T+26h)`, … pavent le temps sans trou ni
 * recouvrement. Une fenêtre plus étroite que la période laisserait des
 * rendez-vous sans rappel ; plus large, elle en sélectionnerait deux fois — que
 * l'idempotence de #68 rattraperait, au prix d'un appel de trop.
 *
 * Changer cette constante **oblige** à changer `reminder_schedule_expression`
 * côté Terraform, et réciproquement. La sortie `reminder_window_hours` du module
 * d'infrastructure existe pour que l'écart se voie.
 */
export const REMINDER_WINDOW_MS = HOUR_MS;

/**
 * La borne exclusive haute de la fenêtre, exprimée en avance : 25 heures.
 */
export const REMINDER_MAX_LEAD_MS = REMINDER_LEAD_MS + REMINDER_WINDOW_MS;

/**
 * La fenêtre de sélection d'un balayage : `[now+24h, now+25h)`.
 *
 * Borne basse **incluse**, borne haute **exclue** — la même convention que tous
 * les intervalles de ce dépôt (`appointments.time_range`, les créneaux du moteur
 * de disponibilité). C'est elle qui garantit le pavage : un rendez-vous qui
 * commence exactement à `now+25h` appartient au balayage suivant, jamais aux
 * deux.
 */
export function reminderWindow(now: Date): { readonly from: Date; readonly to: Date } {
  const base = now.getTime();

  return {
    from: new Date(base + REMINDER_LEAD_MS),
    to: new Date(base + REMINDER_MAX_LEAD_MS),
  };
}

/**
 * Ce qu'un rappel vaut encore **au moment de l'envoi**.
 *
 * - `due` — il part ;
 * - `late` — il est arrivé trop tard, et ne doit **pas** partir ;
 * - `ahead-of-window` — le rendez-vous a été repoussé au-delà de la fenêtre ; il
 *   ne part pas non plus.
 */
export type ReminderTiming = 'due' | 'late' | 'ahead-of-window';

/**
 * Le rappel est-il encore à l'heure ?
 *
 * ## Pourquoi cette vérification existe, alors que la sélection l'a déjà faite
 *
 * Parce que la sélection et l'envoi ne sont pas le même instant. Entre les deux
 * il y a une publication SQS, une invocation de Lambda, un appel HTTP, et — le
 * cas qui compte — jusqu'à cinq réceptions infructueuses avant la file d'attente
 * morte. notifications §3 le dit sans détour : « la Lambda revérifie le statut
 * au moment de l'envoi, pas seulement au moment de la sélection ; l'écart entre
 * les deux peut atteindre une heure ».
 *
 * ## La tolérance vaut une période de balayage, ni plus ni moins
 *
 * Un rappel sélectionné à `T` pour un rendez-vous à `T+24h` doit pouvoir partir
 * quelques minutes plus tard : exiger strictement 24 heures d'avance à l'envoi
 * ferait perdre **tous** les rendez-vous situés au bas de la fenêtre, pour un
 * retard de quelques secondes. La tolérance ne peut pas pour autant être libre :
 * au-delà d'une période de balayage, le message est celui d'un balayage qu'on
 * n'aurait pas dû rejouer, et l'envoyer serait exactement le « rappel en
 * retard » que notifications §3 interdit — un message qui annonce J-1 alors
 * qu'il ne reste que quelques heures désoriente plus qu'il n'aide, et il ne
 * réduit aucun no-show puisque la cliente n'a plus le temps de se décommander.
 *
 * La période du balayage est donc la tolérance : c'est la seule durée du système
 * qui ait un sens ici, et la prendre ailleurs aurait introduit un troisième
 * réglage à tenir d'accord avec les deux autres.
 *
 * ## Un rendez-vous repoussé ne perd pas son rappel
 *
 * `ahead-of-window` refuse l'envoi sans rien perdre : si le rendez-vous commence
 * plus tard que la fenêtre ne le permet, c'est qu'il n'y est pas encore entré —
 * un balayage à venir le sélectionnera à son heure. Le refus est donc un report,
 * pas une suppression. (Le cas est rare : un report crée un **nouveau**
 * rendez-vous et annule l'ancien, que la revérification de statut arrête déjà.)
 */
export function reminderTiming(startsAt: Date, now: Date): ReminderTiming {
  const lead = startsAt.getTime() - now.getTime();

  if (lead < REMINDER_LEAD_MS - REMINDER_WINDOW_MS) {
    return 'late';
  }

  if (lead > REMINDER_MAX_LEAD_MS) {
    return 'ahead-of-window';
  }

  return 'due';
}
