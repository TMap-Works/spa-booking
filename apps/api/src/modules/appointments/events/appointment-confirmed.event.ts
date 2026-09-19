/**
 * L'événement de domaine `appointment.confirmed` — #800.
 *
 * ## Pourquoi il existe
 *
 * Tout rendez-vous naît `PENDING`, et c'est **le salon** qui le confirme —
 * l'administratrice, la gérante, ou le praticien sur ses propres rendez-vous
 * (arbitrage du PO du 19/09). Le message qui part à la réservation dit donc
 * « enregistré, à confirmer par le salon », et jusqu'ici rien ne disait à la
 * cliente que ce geste avait eu lieu : elle apprenait la confirmation en
 * rouvrant son espace, ou jamais.
 *
 * `notifications` s'y abonne pour envoyer « votre rendez-vous est confirmé ».
 * C'est l'événement que notifications §1 nomme depuis l'origine comme
 * déclencheur de la confirmation ; il n'était simplement jamais émis.
 *
 * ## Ce qui l'émet, et ce qui ne l'émet pas
 *
 * `AppointmentsService.changeStatus`, sur `PENDING → CONFIRMED` et sur elle
 * seule, **après** l'écriture conditionnelle : une confirmation perdue dans une
 * course (409) n'annonce rien.
 *
 * Le webhook Stripe confirme lui aussi un rendez-vous dont le paiement en ligne
 * aboutit, mais dans la transaction de l'encaissement et sans passer par ce
 * module (`payments.module.ts`, dette assumée). Il n'émet donc rien. Le chemin
 * est inerte depuis l'ADR 0015 — le tunnel n'encaisse plus en ligne —, et le
 * brancher demanderait d'abord de solder cette dette.
 *
 * ## Ce que la charge utile porte
 *
 * Des identifiants, comme ses voisins, et rien qui se lise sans la base : ni
 * coordonnées, ni heure. L'abonné relit le rendez-vous au moment de l'envoi — un
 * message de file peut être rejoué une heure plus tard, après un report ou une
 * annulation, et une heure figée ici serait alors fausse.
 */

/** Le nom sous lequel l'événement est publié. */
export const APPOINTMENT_CONFIRMED = 'appointment.confirmed' as const;

/** Un rendez-vous vient de passer `PENDING → CONFIRMED`. */
export interface AppointmentConfirmedEvent {
  readonly name: typeof APPOINTMENT_CONFIRMED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  readonly appointmentId: string;
  /** La cliente, destinataire du message. */
  readonly clientId: string;
  readonly staffId: string;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
