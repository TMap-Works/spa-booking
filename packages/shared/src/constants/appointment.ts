/**
 * Cycle de vie du rendez-vous — booking-engine §5.
 *
 * ```
 *                  ┌──────────► cancelled
 *                  │
 * pending ──► confirmed ──► completed
 *    │              │
 *    │              └──────────► no_show
 *    └──► cancelled
 * ```
 *
 * `cancelled` et `no_show` sont des **statuts**, pas des suppressions : le
 * reporting du CDC §1.4 compte les no-shows, et la contrainte d'exclusion
 * anti-double-réservation ne porte que sur `pending` et `confirmed` — un
 * rendez-vous annulé libère son créneau.
 */

import { ERROR_CODES } from '../errors/error-codes';

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Statuts qui **occupent** le créneau du praticien.
 *
 * Le front s'en sert pour griser un créneau, le back pour le prédicat partiel
 * de la contrainte d'exclusion. Les deux doivent lire la même liste, sans quoi
 * l'agenda affiché et l'agenda réel divergent.
 */
export const BLOCKING_APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
] as const satisfies readonly AppointmentStatus[];

/** Statuts terminaux : plus aucune transition n'en part. */
export const TERMINAL_APPOINTMENT_STATUSES = [
  'completed',
  'cancelled',
  'no_show',
] as const satisfies readonly AppointmentStatus[];

/**
 * Les deux **constats** : ce qu'on dit d'un rendez-vous une fois l'heure venue.
 *
 * Ce ne sont pas des statuts comme les autres. `pending`, `confirmed` et
 * `cancelled` décrivent un rendez-vous **à venir** — pris, confirmé, renoncé —,
 * ces deux-ci constatent le passé : `completed` « honoré, encaissé »,
 * `no_show` « client absent » (booking-engine §5).
 *
 * `cancelled` n'en fait pas partie, quoiqu'il soit terminal lui aussi : annuler
 * est une **décision**, et elle se prend précisément *avant* l'heure du soin.
 */
export const OUTCOME_APPOINTMENT_STATUSES = [
  'completed',
  'no_show',
] as const satisfies readonly AppointmentStatus[];

export type OutcomeAppointmentStatus = (typeof OUTCOME_APPOINTMENT_STATUSES)[number];

/**
 * Transitions autorisées. Tout ce qui n'y figure pas est refusé par un
 * `INVALID_STATE_TRANSITION` (422) : en particulier le passage direct
 * `pending → completed` et tout retour en arrière depuis `completed`.
 */
export const APPOINTMENT_STATUS_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Qui est à l'origine d'une annulation — booking-engine §5.
 *
 * `system` couvre l'annulation automatique (paiement jamais confirmé, tâche
 * planifiée). La distinction alimente le reporting : une annulation salon et un
 * no-show client ne se pilotent pas de la même manière.
 */
export const CANCELLATION_ACTORS = ['client', 'staff', 'system'] as const;

export type CancellationActor = (typeof CANCELLATION_ACTORS)[number];

// ---------------------------------------------------------------------------
// La référence citable d'un rendez-vous — #736, #796
// ---------------------------------------------------------------------------

/**
 * `RDV-XXXX-NN` — le code qu'une cliente lit sur sa confirmation, dicte au
 * téléphone, et que le comptoir résout.
 *
 * ## Elle est **posée à la réservation**, elle ne se dérive plus (#796)
 *
 * #736 la calculait côté front à partir de l'identifiant du rendez-vous :
 * déterministe, sans colonne ni contrat, mais avec un peu plus de cent millions
 * de valeurs pour un espace **non contraint** — deux rendez-vous d'un même salon
 * pouvaient porter la même. C'était tenable tant que la référence servait
 * seulement à *reconnaître* son propre rendez-vous sur un écran ; cela cesse de
 * l'être dès qu'on veut le *retrouver* avec, ce qui est tout l'objet de #796 :
 * un code ambigu résolu par le comptoir désigne la mauvaise cliente.
 *
 * La référence est donc une **colonne**, `appointments.reference`, unique par
 * établissement (tenant-isolation §1 : « les clés uniques métier sont composites
 * avec le tenant »). Le format ci-dessous ne change pas — c'est celui du
 * wireframe, `docs/design/appointments/wireframes.md` Étape 6 — mais ce qui le
 * garantit unique n'est plus une probabilité, c'est un index.
 *
 * ## Ce que la forme doit au fait qu'on la dicte
 *
 * Trente-deux symboles, ceux de Crockford : chiffres et lettres, moins `I`, `L`,
 * `O` et `U`. Les trois premières se confondent avec `1` et `0` dans la plupart
 * des fontes ; `U` part avec elles pour la raison qu'a Crockford — l'écarter met
 * un obscène de moins dans les références qu'on tirera.
 *
 * Quatre symboles et deux chiffres, groupés : six caractères se retiennent le
 * temps d'un appel, et la coupure les rend recopiables sans compter.
 */
export const APPOINTMENT_REFERENCE_PREFIX = 'RDV';

/** Les trente-deux symboles de Crockford — sans `I`, `L`, `O` ni `U`. */
export const APPOINTMENT_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Le groupe alphanumérique du milieu : `RDV-8F3K-27`. */
export const APPOINTMENT_REFERENCE_GROUP_LENGTH = 4;

/** Le suffixe décimal de fin : `RDV-8F3K-27`. */
export const APPOINTMENT_REFERENCE_SUFFIX_LENGTH = 2;

/** `RDV-XXXX-NN` : onze caractères, et c'est la largeur de la colonne. */
export const APPOINTMENT_REFERENCE_LENGTH = 11;

/**
 * La forme **émise** — la seule que l'API rend et que la base stocke.
 *
 * La classe de caractères reprend l'alphabet ci-dessus symbole pour symbole :
 * `I`, `L`, `O` et `U` n'y sont pas, si bien qu'une référence qui en porterait
 * une n'a pas pu être tirée par ce produit.
 */
export const APPOINTMENT_REFERENCE_PATTERN = /^RDV-[0-9A-HJKMNP-TV-Z]{4}-[0-9]{2}$/;

/**
 * La référence telle qu'on vient de la **dicter**, ramenée à sa forme émise.
 *
 * Ce qui est absorbé ici est exactement ce qu'un comptoir reçoit au téléphone,
 * et rien de plus :
 *
 * - la **casse** et les séparateurs — `rdv a5hy 14`, `A5HY-14`, `RDV-A5HY-14` ;
 * - le **préfixe absent**, parce qu'une cliente lit souvent les six caractères
 *   seuls ;
 * - les **confusions de fonte** que l'alphabet évite d'émettre mais qu'une
 *   personne produit en recopiant : `I` et `L` pour `1`, `O` pour `0`. C'est le
 *   décodage que Crockford prescrit, et c'est la contrepartie de l'alphabet : ne
 *   pas les émettre ne sert à rien si on refuse de les lire.
 *
 * Ce qui n'est **pas** absorbé : `U`, que Crockford ne replie sur rien, et toute
 * longueur qui n'est pas la bonne. La chaîne est alors rendue telle qu'elle a
 * été nettoyée — au schéma de la refuser en nommant le champ, plutôt qu'à cette
 * fonction de deviner ce qui manque.
 *
 * Le préfixe n'est retiré que si la **longueur** dit qu'il est là : une
 * référence dont le groupe commence par `RDV` — `RDV-RDVA-14` — se dicte aussi
 * sans son préfixe, et un retrait par simple préfixe de chaîne l'aurait
 * amputée.
 */
export function normalizeAppointmentReference(cited: string): string {
  const symbols = cited.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const bare = APPOINTMENT_REFERENCE_GROUP_LENGTH + APPOINTMENT_REFERENCE_SUFFIX_LENGTH;
  const body =
    symbols.length === APPOINTMENT_REFERENCE_PREFIX.length + bare &&
    symbols.startsWith(APPOINTMENT_REFERENCE_PREFIX)
      ? symbols.slice(APPOINTMENT_REFERENCE_PREFIX.length)
      : symbols;

  if (body.length !== bare) {
    return symbols;
  }

  const folded = body.replace(/[ILO]/g, (symbol) => (symbol === 'O' ? '0' : '1'));

  return [
    APPOINTMENT_REFERENCE_PREFIX,
    folded.slice(0, APPOINTMENT_REFERENCE_GROUP_LENGTH),
    folded.slice(APPOINTMENT_REFERENCE_GROUP_LENGTH),
  ].join('-');
}

/** `true` si `value` est une référence de rendez-vous sous sa forme émise. */
export function isAppointmentReference(value: unknown): value is string {
  return typeof value === 'string' && APPOINTMENT_REFERENCE_PATTERN.test(value);
}

/** `true` si `value` est un statut de rendez-vous connu. */
export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/** `true` si le rendez-vous occupe encore le créneau de son praticien. */
export function isBlockingAppointmentStatus(status: AppointmentStatus): boolean {
  return (BLOCKING_APPOINTMENT_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/**
 * `true` si la transition est autorisée par le cycle de vie.
 *
 * Ce n'est pas une autorisation : le droit de faire la transition relève du
 * rôle de l'appelant, la validité de la transition relève d'ici. Les deux se
 * vérifient, dans cet ordre.
 */
export function canTransitionAppointment(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return APPOINTMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** `true` si `status` constate ce qui a eu lieu, plutôt que d'annoncer ce qui vient. */
export function isOutcomeAppointmentStatus(
  status: AppointmentStatus,
): status is OutcomeAppointmentStatus {
  return (OUTCOME_APPOINTMENT_STATUSES as readonly AppointmentStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
// On ne constate pas ce qui n'a pas eu lieu — #1137, #1210
// ---------------------------------------------------------------------------

/**
 * `true` si le soin a commencé à l'instant `now`.
 *
 * ## L'heure comparée est celle du **soin**
 *
 * C'est `startsAt` tel que l'API le **rend** — l'intervalle facturé, celui que
 * la cliente lit sur sa confirmation — et non l'intervalle occupé qui est en
 * base, lequel commence un tampon de préparation plus tôt. Toutes les vues du
 * contrat (`appointmentSchema`, `bookedAppointmentSchema`) portent déjà
 * l'intervalle facturé : un écran qui lit cette fonction avec le `startsAt`
 * qu'il a reçu compare donc la bonne heure, sans rien avoir à dériver.
 *
 * ## L'égalité penche du côté qui autorise
 *
 * À l'heure pile, le rendez-vous **a commencé**. C'est la même borne que le
 * cycle de vie côté serveur : deux inégalités qui divergeraient d'un côté
 * strict feraient qu'un écran ouvre un geste que l'API refuse, ou l'inverse,
 * pendant la milliseconde où les deux ne sont pas d'accord.
 *
 * ## Une heure illisible n'a pas commencé
 *
 * `Date.parse` rend `NaN` sur une chaîne qui n'est pas une date, et toute
 * comparaison avec `NaN` est fausse — ce qui, ici, tombe du bon côté : faute de
 * savoir, on n'ouvre pas un geste **terminal** et sans retour. La garde est
 * explicite plutôt que laissée à la sémantique de `NaN`, pour que l'intention
 * se lise.
 */
export function hasAppointmentStarted(
  startsAt: string | Date | null | undefined,
  now: Date | number,
): boolean {
  if (startsAt === null || startsAt === undefined) {
    return false;
  }

  const start = startsAt instanceof Date ? startsAt.getTime() : Date.parse(startsAt);

  if (Number.isNaN(start)) {
    return false;
  }

  return start <= (now instanceof Date ? now.getTime() : now);
}

/**
 * `true` si le passage à `to` peut être **posé maintenant** sur un rendez-vous
 * qui commence à `startsAt`.
 *
 * ## Pourquoi cette règle est ici, et pas dans chaque écran
 *
 * Parce qu'elle est un **contrat** : l'API refuse `completed` et `no_show` tant
 * que le soin n'a pas commencé — 422 `INVALID_STATE_TRANSITION`,
 * `details.notStarted` (#1137). Un écran qui offre ces gestes avant l'heure
 * offre un refus, et un bouton qui mène à un 422 est un bouton qui ment. Deux
 * écrans les offraient, chacun avec sa propre lecture de l'heure — le tiroir du
 * comptoir sans aucune, « Mon planning » avec une comparaison recopiée sur
 * place (#1210). Une seule écriture, et les deux la lisent.
 *
 * ## Elle ne remplace pas la table des transitions
 *
 * `canTransitionAppointment` dit ce qui **suit** quoi, celle-ci dit **quand**.
 * Les deux se vérifient, dans cet ordre : un `pending` n'offre pas « honoré »
 * parce que la table l'interdit, un `confirmed` de demain ne l'offre pas parce
 * que l'heure n'y est pas.
 */
export function canRecordAppointmentOutcome(
  to: AppointmentStatus,
  startsAt: string | Date | null | undefined,
  now: Date | number,
): boolean {
  if (!isOutcomeAppointmentStatus(to)) {
    // Confirmer ou annuler sont des **décisions**, et elles se prennent avant
    // l'heure : l'horloge ne les borne pas.
    return true;
  }

  return hasAppointmentStarted(startsAt, now);
}

/**
 * La clé que le refus du cycle de vie pose dans `details` quand le soin n'a pas
 * commencé — `AppointmentNotStartedError`, #1137.
 *
 * Elle est ici et non recopiée dans les écrans pour la raison qui vaut pour la
 * règle elle-même : une chaîne écrite deux fois est une chaîne qui finit par
 * n'être écrite qu'une seule fois du bon côté.
 */
export const APPOINTMENT_NOT_STARTED_DETAIL = 'notStarted';

/**
 * `true` si ce refus est « le rendez-vous n'a pas commencé ».
 *
 * ## Pourquoi un écran en a besoin alors qu'il lit déjà la règle
 *
 * Parce que le temps passe entre le rendu et le clic, et parce que l'horloge du
 * poste n'est pas celle du serveur. Un tiroir resté ouvert peut donc offrir un
 * constat que l'API refuse à la milliseconde près — et c'est bien l'API qui
 * tranche. Ce refus-là se dit « attendez l'heure du rendez-vous », et non
 * « rechargez » : la conduite à tenir n'est pas la même, et le `code` seul ne
 * les distingue pas, `INVALID_STATE_TRANSITION` couvrant aussi le rendez-vous
 * déjà soldé.
 *
 * Le code **et** le détail sont exigés : un `details.notStarted` sous un autre
 * code ne viendrait pas de ce refus.
 *
 * ## Elle attend son émetteur
 *
 * `AppointmentNotStartedError` est posée par #1137, qui n'est pas encore
 * intégrée : tant qu'elle ne l'est pas, aucun refus ne porte ce détail et cette
 * fonction rend toujours `false`. Les écrans n'en dépendent pas — ils tiennent
 * la règle d'eux-mêmes —, et la porter dès maintenant est ce qui évite que le
 * branchement du repli soit un second ticket. Le jour où #1137 est intégrée, le
 * message juste s'affiche sans qu'une ligne d'écran change.
 */
export function isAppointmentNotStartedRefusal(
  code: string,
  details: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return (
    code === ERROR_CODES.INVALID_STATE_TRANSITION &&
    details?.[APPOINTMENT_NOT_STARTED_DETAIL] === true
  );
}
