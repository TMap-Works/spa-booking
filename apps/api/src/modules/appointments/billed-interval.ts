/**
 * L'intervalle **facturé** d'un rendez-vous, retrouvé depuis la ligne écrite —
 * booking-engine §3, étape 5.
 *
 * La base ne stocke que l'intervalle **occupé** : `starts_at` est l'instant où
 * la cabine commence à être préparée, `ends_at` celui où elle finit d'être
 * remise en état. Les tampons du CDC §2.3 en font partie, mais ils ne sont pas
 * facturés à la cliente — l'heure qu'on lui annonce, celle qui figure sur son
 * espace client comme sur le planning du comptoir, est l'instant du **soin** :
 *
 * ```
 * starts_at ─┬─ buffer_before ─┬─ duration ─┬─ buffer_after ─┬─ ends_at
 *  (occupé)  │                 │  (facturé) │                │  (occupé)
 *            └─ heure annoncée ┘            └─ fin annoncée ──┘
 * ```
 *
 * ## Pourquoi un fichier à part, et pourquoi ici
 *
 * Parce que deux modules dérivent cette heure et qu'ils doivent la dériver de la
 * même façon. `appointments` la rend sur la vue publique et sur l'agenda ; `crm`
 * la rend sur l'historique de la fiche cliente et sur l'export RGPD. Tant que la
 * conversion vivait dans `appointments.service.ts`, le second ne pouvait pas
 * l'appeler — le dépôt du CRM rendait donc `starts_at` brut, et la fiche
 * annonçait chaque visite cinq à dix minutes avant l'heure que le planning, le
 * tiroir d'édition et l'espace client affichaient tous les trois (#750).
 *
 * Le fichier est **pur** : ni Nest, ni Prisma, ni horloge. C'est ce qui permet à
 * `crm` de l'importer sans importer le service d'`appointments` — api-module §3
 * interdit le couplage entre modules, et le seul couplage acceptable est celui
 * d'un vocabulaire partagé, comme `appointment-status.ts` que `crm.types.ts`
 * importe déjà.
 */

const MINUTE_MS = 60_000;

/**
 * Ce dont la conversion a besoin d'une prestation — et rien d'autre.
 *
 * `ServiceView` du catalogue le satisfait structurellement, si bien que tous les
 * appelants qui en ont un continuent de le passer tel quel. Le type existe pour
 * les cas où l'on n'en a pas : l'historique de la cliente (#47), qui se replie
 * quand une prestation manque, et les projections du CRM, qui ne lisent du
 * catalogue que ces deux entiers.
 */
export interface BilledIntervalSource {
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
}

/**
 * La ligne écrite, réduite à ce que la conversion en lit : son début **occupé**.
 *
 * Volontairement structurel plutôt que nominal — `AppointmentRecord`,
 * `AgendaAppointmentRecord` et les lignes projetées du CRM le satisfont tous,
 * sans qu'aucun d'eux n'ait à être importé ici.
 */
export interface OccupiedStart {
  readonly startsAt: Date;
}

/** Un intervalle facturé, tel qu'il s'affiche. */
export interface BilledInterval {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * L'instant du **soin** d'une ligne écrite — l'inverse d'`occupiedRange`.
 *
 * Rendu en millisecondes plutôt qu'en `Date` parce que le report le compare à
 * une demande sans jamais l'afficher : deux dérivations séparées auraient pu
 * diverger, et le jour où elles auraient divergé, une demande sans effet aurait
 * recommencé à réécrire l'agenda.
 */
export function billedStartOf(record: OccupiedStart, service: BilledIntervalSource): number {
  return record.startsAt.getTime() + service.bufferBeforeMinutes * MINUTE_MS;
}

/**
 * L'intervalle facturé complet — ce qu'un écran affiche.
 *
 * La fin est `début facturé + durée`, et **jamais** l'`ends_at` de la ligne :
 * celui-ci porte le tampon de finition, qui n'est pas du temps de soin. Un écran
 * qui l'afficherait annoncerait à la cliente une séance plus longue que celle
 * qu'elle a réservée.
 *
 * ## Les tampons sont ceux du catalogue **au moment de la lecture**
 *
 * L'intervalle occupé est en base, le facturé s'en déduit avec les tampons
 * courants de la prestation. Sur un rendez-vous récent l'écart est nul — il a
 * été écrit avec ces tampons-là. Sur un rendez-vous ancien il ne l'est plus si
 * le salon a modifié ses temps de cabine depuis. Corriger cela demanderait de
 * figer les tampons sur la ligne, au même titre que le prix — un changement de
 * schéma, pour un écart de quelques minutes sur une heure déjà passée.
 */
export function billedIntervalOf(
  record: OccupiedStart,
  service: BilledIntervalSource,
): BilledInterval {
  const billedStart = billedStartOf(record, service);

  return {
    startsAt: new Date(billedStart),
    endsAt: new Date(billedStart + service.durationMinutes * MINUTE_MS),
  };
}
