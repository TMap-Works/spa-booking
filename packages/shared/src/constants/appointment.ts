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
