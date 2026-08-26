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
 */

import { z } from 'zod';

import { longTextSchema, reasonSchema, uuidSchema } from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import { calendarDateSchema, utcInstantSchema } from '../common/time';
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
 */
export const createAppointmentRequestSchema = z
  .object({
    serviceId: uuidSchema,
    staffId: uuidSchema,
    startsAt: utcInstantSchema,
    clientId: uuidSchema.optional(),
    clientNote: longTextSchema.optional(),
  })
  .strict();

export type CreateAppointmentRequest = z.infer<typeof createAppointmentRequestSchema>;

/**
 * Report — un déplacement, pas une annulation suivie d'une création.
 *
 * Garder l'identité du rendez-vous préserve son historique, son encaissement
 * éventuel et la continuité de ses notifications. `staffId` permet de changer de
 * praticien au passage, ce que le comptoir fait couramment.
 */
export const rescheduleAppointmentRequestSchema = z
  .object({
    startsAt: utcInstantSchema,
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
