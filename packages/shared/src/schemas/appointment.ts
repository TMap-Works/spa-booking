/**
 * Rendez-vous — le cœur de la boucle de valeur « réserver → confirmer →
 * honorer → encaisser ».
 *
 * Trois traits de ce contrat méritent d'être lus avant d'écrire un contrôleur :
 *
 * 1. **Le client ne pose pas `endsAt`.** Il choisit un début et une prestation ;
 *    la fin se dérive de la durée du catalogue, côté serveur. Laisser le client
 *    l'envoyer reviendrait à lui laisser réserver une heure de fauteuil pour un
 *    soin de quinze minutes — ou l'inverse, et à faire chevaucher le suivant.
 * 2. **Le prix est figé à la réservation** (`price`), et non relu du catalogue à
 *    l'affichage : le tarif peut changer entre la prise de rendez-vous et la
 *    venue, le montant dû par ce client-là, non.
 * 3. **Aucun schéma ne porte `tenantId`.** Il est résolu depuis la requête. Voir
 *    l'en-tête de `./tenant`.
 *
 * ## L'asymétrie entrée / sortie sur les dates (#297)
 *
 * | Sens | Schéma | Raison |
 * |---|---|---|
 * | Entrée | `offsetDateTimeSchema` — `Z` **ou** `±HH:MM`, normalisé en UTC | ne pas faire porter la conversion au client, qui la ferait avec le fuseau de son navigateur |
 * | Sortie | `utcInstantSchema` — `…Z` seulement | un seul référentiel : deux horodatages se comparent par simple ordre lexicographique |
 *
 * Elle n'est pas un relâchement d'un côté et une rigueur de l'autre : ce qui est
 * proscrit dans les deux sens, c'est la date-heure **nue**, dont le serveur ne
 * pourrait que deviner le fuseau. `Z` est un offset explicite, donc une entrée
 * valable ; `+02:00` n'est pas une sortie valable, parce qu'il obligerait chaque
 * lecteur à normaliser avant de comparer. Voir
 * [ADR 0006](../../../../docs/adr/0006-fuseaux-horaires-tenant.md) et l'en-tête
 * de `../common/time`.
 *
 * Une conséquence à connaître avant d'écrire un client : `offsetDateTimeSchema`
 * **transforme**, si bien que le type inféré d'un champ entrant est déjà l'instant
 * UTC normalisé, pas la chaîne envoyée. C'est voulu — passé le schéma, plus
 * aucune couche n'a à se demander dans quel référentiel elle lit un horodatage —
 * et c'est la même convention que les schémas d'absence de `./availability`.
 */

import { z } from 'zod';

import { longTextSchema, reasonSchema, uuidSchema } from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import { calendarDateSchema, offsetDateTimeSchema, utcInstantSchema } from '../common/time';
import { APPOINTMENT_STATUSES, CANCELLATION_ACTORS } from '../constants/appointment';

import { serviceSummarySchema, staffMemberSummarySchema } from './catalog';
import { userSummarySchema } from './identity';

export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);

export const cancellationActorSchema = z.enum(CANCELLATION_ACTORS);

/**
 * Rendez-vous tel que l'API le renvoie.
 *
 * `client`, `staff` et `service` sont imbriqués sous leur forme *summary* : un
 * agenda affiche un nom, une prestation et une heure, et n'a besoin ni de
 * l'état d'activation du compte ni de la biographie du praticien. C'est aussi
 * ce qui borne la donnée personnelle diffusée à chaque ligne d'agenda.
 *
 * **Tous les instants de cette réponse restent en `utcInstantSchema`** (#297).
 * C'est le côté « sortie » de l'asymétrie décrite en tête de fichier : émettre
 * `startsAt` avec l'offset du salon obligerait l'agenda du back-office à
 * normaliser chaque ligne avant de la trier, et deux salons de fuseaux
 * différents ne se compareraient plus du tout.
 */
export const appointmentSchema = z.object({
  id: uuidSchema,
  status: appointmentStatusSchema,
  client: userSummarySchema,
  staff: staffMemberSummarySchema,
  service: serviceSummarySchema,
  startsAt: utcInstantSchema,
  endsAt: utcInstantSchema,
  /** Prix figé au moment de la réservation. */
  price: nonNegativeMoneySchema,
  clientNote: longTextSchema.optional(),
  /**
   * Note interne. **Jamais servie au parcours public** : c'est un champ de
   * back-office, et le contrat le documente ici pour que l'omission côté client
   * soit un choix visible plutôt qu'un oubli.
   */
  staffNote: longTextSchema.optional(),
  cancelledAt: utcInstantSchema.optional(),
  cancellationReason: reasonSchema.optional(),
  /**
   * Le rendez-vous que celui-ci **remplace**, s'il est né d'un report.
   *
   * Absent sur un rendez-vous pris directement, ce qui est le cas de la grande
   * majorité. C'est ce champ, et lui seul, qui distingue un déplacement d'une
   * réservation neuve : sans lui, l'historique de la cliente montrerait un
   * rendez-vous annulé et un rendez-vous sans passé, au lieu d'un même
   * rendez-vous déplacé. Voir `rescheduleAppointmentRequestSchema`.
   */
  rescheduledFromId: uuidSchema.optional(),
  createdAt: utcInstantSchema,
});

export type Appointment = z.infer<typeof appointmentSchema>;

/**
 * Prise de rendez-vous depuis le parcours public ou le back-office.
 *
 * `clientId` est optionnel et **réservé au back-office** : au comptoir, le staff
 * réserve pour quelqu'un d'autre. Sur le parcours public, le serveur ignore
 * cette possibilité et prend le client de la session — un client authentifié qui
 * poserait l'identifiant d'un autre ne doit pas pouvoir réserver en son nom.
 *
 * ## `staffId` est **facultatif** : c'est l'option « premier disponible » (#36)
 *
 * Le CDC §1.4 la nomme explicitement — « choix du praticien ou *premier
 * disponible* ». Son absence n'est donc pas une donnée manquante, c'est un
 * choix : la cliente dit qu'elle n'a pas de préférence, et le serveur affecte le
 * praticien **à la réservation**, selon une règle documentée dans le README du
 * module `appointments`.
 *
 * L'affectation est faite côté serveur, jamais côté client : un front qui
 * choisirait lui-même un praticien parmi ceux qu'un calendrier lui a montrés
 * décidera toujours sur un état périmé, et rouvrirait la fenêtre de concurrence
 * que le créneau sert à fermer. Le champ reste donc là pour la cliente qui **a**
 * une préférence, et pour elle seule.
 */
export const createAppointmentRequestSchema = z
  .object({
    serviceId: uuidSchema,
    /** Absent = « premier disponible ». Voir l'en-tête de ce schéma. */
    staffId: uuidSchema.optional(),
    /**
     * Début du **soin**, ISO 8601 avec offset explicite — `Z` ou `±HH:MM` (#297).
     *
     * C'est l'instant que le calendrier a affiché à la cliente, tel qu'il s'est
     * affiché. Le front n'a donc pas à le convertir avant de l'envoyer : il le
     * ferait avec le fuseau du navigateur, qui n'est pas celui du salon dès
     * qu'on réserve en voyage — et c'est exactement la conversion silencieuse
     * que la frontière existe pour empêcher.
     *
     * La normalisation en UTC a lieu **ici**, si bien que le type inféré est
     * déjà un `UtcInstant`. La date-heure nue reste refusée : son fuseau ne
     * pourrait qu'être deviné.
     */
    startsAt: offsetDateTimeSchema,
    clientId: uuidSchema.optional(),
    clientNote: longTextSchema.optional(),
  })
  .strict();

export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

/**
 * Report — **une annulation suivie d'une création liée**, jamais une mise à jour
 * des dates en place (booking-engine §5).
 *
 * C'est un déplacement pour la cliente, une paire de lignes pour la base, et la
 * distinction n'est pas théorique :
 *
 * - **l'historique**. Réécrire les bornes de la ligne existante efface l'heure
 *   d'origine : plus moyen de dire d'où le rendez-vous vient, ni de compter les
 *   reports d'un salon. Le rendez-vous créé porte l'identifiant de celui qu'il
 *   remplace dans `rescheduledFromId`, et celui-ci passe en `cancelled` ;
 * - **la contrainte d'exclusion**. Elle compare la ligne modifiée aux autres,
 *   elle-même comprise : avancer d'une demi-heure un soin d'une heure la ferait
 *   chevaucher son propre état antérieur, et PostgreSQL refuserait un
 *   déplacement pourtant légitime. Annuler puis créer sort la ligne de l'index
 *   partiel avant que l'insertion ne soit jugée.
 *
 * Les deux écritures sont dans **une seule transaction** : un créneau d'arrivée
 * refusé laisse le rendez-vous d'origine intact, jamais une cliente sans
 * rendez-vous du tout.
 *
 * La réponse est donc un rendez-vous **neuf**, avec un nouvel identifiant : le
 * front remplace celui qu'il gardait. `staffId` permet de changer de praticien
 * au passage, ce que le comptoir fait couramment ; absent, le praticien reste le
 * même.
 */
export const rescheduleAppointmentRequestSchema = z
  .object({
    /**
     * Nouveau début du soin, ISO 8601 avec offset explicite (#297) — même
     * frontière qu'à la réservation, et ce n'est pas une coïncidence : les
     * créneaux que le calendrier propose pour un report sont ceux-là mêmes qu'il
     * propose pour une réservation neuve. Deux formats d'entrée différents
     * feraient refuser au report un instant que la réservation accepte.
     */
    startsAt: offsetDateTimeSchema,
    staffId: uuidSchema.optional(),
  })
  .strict();

export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentRequestSchema>;

/**
 * Annulation.
 *
 * `actor` n'est pas fourni par le client : le serveur le déduit du rôle de
 * l'appelant. Il n'apparaît donc pas ici — le motif, si.
 */
export const cancelAppointmentRequestSchema = z
  .object({
    reason: reasonSchema.optional(),
  })
  .strict();

export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequestSchema>;

/**
 * Changement de statut par le back-office — `confirmed`, `completed`, `no_show`.
 *
 * La transition est validée par `canTransitionAppointment` ; une transition non
 * prévue par le cycle de vie sort en `INVALID_STATE_TRANSITION`.
 */
export const changeAppointmentStatusRequestSchema = z
  .object({
    status: appointmentStatusSchema,
    reason: reasonSchema.optional(),
  })
  .strict();

export type ChangeAppointmentStatusRequest = z.infer<typeof changeAppointmentStatusRequestSchema>;

/**
 * Filtres de l'agenda du back-office.
 *
 * Les bornes sont des **dates civiles** et non des instants : un agenda se
 * consulte « du 3 au 9 mars » dans le calendrier de l'établissement. La
 * conversion vers les instants UTC de la requête se fait côté serveur, avec le
 * fuseau du tenant — c'est le seul endroit qui le connaisse.
 *
 * C'est pourquoi `from` et `to` **ne basculent pas** sur `offsetDateTimeSchema`
 * (#297), alors que ce sont bien des champs entrants : la question ne se pose
 * pas pour eux. Une date civile n'est pas un instant mal formé, c'est une autre
 * nature de donnée — « le 3 mars » ne commence pas au même moment à Papeete et à
 * Paris. Leur adjoindre un offset laisserait l'appelant décider où commence la
 * journée de l'établissement, qui est précisément ce que `tenants.timezone`
 * tranche. Voir l'en-tête de `../common/time`.
 *
 * `statuses` accepte plusieurs valeurs pour la vue « à venir » (`pending` +
 * `confirmed`), qui est l'écran par défaut du comptoir.
 */
export const appointmentListQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    staffId: uuidSchema.optional(),
    clientId: uuidSchema.optional(),
    serviceId: uuidSchema.optional(),
    statuses: z.array(appointmentStatusSchema).nonempty().optional(),
  })
  .strict();

export type AppointmentListQuery = z.infer<typeof appointmentListQuerySchema>;
