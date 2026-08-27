import type { AppointmentStatus } from './appointment-status';

/**
 * Le vocabulaire du module `appointments`, côté domaine.
 *
 * Ces formes ne sont ni des DTO HTTP ni des types générés par Prisma : ce sont
 * ce que le service et le repository acceptent et rendent (api-module §2). Les
 * DTO HTTP, eux, vivent sous `dto/`.
 *
 * TODO(#26) : `AppointmentView` appartient au contrat d'API et sera importé de
 * `@spa/shared` (`appointmentSchema`) le jour où `apps/api` dépendra du paquet —
 * même TODO que dans `catalog.types.ts` et `identity.types.ts`.
 */

/**
 * Un montant, tel que tout le schéma le porte : un entier dans la plus petite
 * unité monétaire, accompagné de son code ISO 4217. Jamais de flottant, et
 * jamais d'entier sans sa devise — un prix sans devise n'est pas un prix.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/**
 * Ce qu'il faut pour poser un rendez-vous.
 *
 * **Aucun `tenantId`**, et c'est structurel : le tenant vient du contexte de
 * requête et c'est l'extension Prisma qui le pose (tenant-isolation §3). Un
 * champ ici l'exposerait à venir du corps de la requête, ce qui est exactement
 * la fuite que le scoping automatique supprime.
 *
 * `startsAt` et `endsAt` sont des instants UTC. La durée réellement occupée —
 * soin plus tampons de part et d'autre — est calculée en amont par le moteur de
 * disponibilité (#34) : ce module reçoit l'intervalle, il ne le devine pas.
 */
export interface AppointmentDraft {
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Prix figé à la réservation — le tarif du catalogue peut changer ensuite. */
  readonly price: Money;
  readonly clientNote: string | null;
}

/**
 * Un rendez-vous, sous la forme que le module manipule.
 *
 * Pas de `tenantId` : il n'apporte rien à l'appelant et invite aux essais
 * (tenant-isolation §4). Pas de `timeRange` non plus — l'intervalle est une
 * colonne générée, une projection de `startsAt` et `endsAt` qui n'ajoute aucune
 * information et que Prisma ne sait de toute façon pas lire.
 */
export interface AppointmentRecord {
  readonly id: string;
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: AppointmentStatus;
  readonly price: Money;
  readonly clientNote: string | null;
  /**
   * Le rendez-vous que celui-ci remplace, ou `null` s'il a été pris directement
   * (#39).
   *
   * `null` se lit « pris directement », jamais « inconnu » : la colonne est
   * nullable et sans défaut, et rien d'autre que le report ne l'écrit.
   */
  readonly rescheduledFromId: string | null;
}

/**
 * Les coordonnées d'une cliente qui réserve **sans compte** — le quatrième
 * critère de #37.
 *
 * `users.password_hash` est nullable précisément pour cela : « un client peut
 * exister sans compte, saisi au comptoir par le staff » (schéma Prisma). Une
 * fiche est donc créée, mais aucune identité : pas de mot de passe, pas de
 * session, rien à quoi se connecter.
 *
 * `phone` est facultatif : le SMS de rappel est un confort, l'e-mail de
 * confirmation est le canal obligatoire (CDC §1.4). Exiger un numéro ferait
 * abandonner des réservations pour un canal que le salon n'utilise peut-être
 * pas.
 */
export interface GuestContact {
  readonly firstName: string;
  readonly lastName: string;
  /** Canonisée — élaguée, en minuscules — avant d'atteindre ce type. */
  readonly email: string;
  readonly phone: string | null;
}

/**
 * Ce qu'une réservation demande, telle que le **service** la reçoit.
 *
 * `startsAt` est l'instant du **soin**, celui que le moteur de disponibilité a
 * proposé et que la cliente a vu s'afficher — jamais l'instant occupé. La
 * conversion de l'un vers l'autre, tampons compris, appartient au service et à
 * lui seul : c'est ce que `AppointmentDraft` porte ensuite.
 */
export interface BookAppointmentInput {
  readonly serviceId: string;
  readonly staffId: string;
  readonly startsAt: Date;
  readonly client: GuestContact;
  readonly clientNote: string | null;
}

/**
 * Ce qu'un report demande, tel que le **service** le reçoit (#39).
 *
 * Ni `serviceId`, ni coordonnées de cliente, ni prix : reporter ne change ni la
 * prestation, ni la personne, ni le montant dû. Les laisser entrer par le corps
 * de la requête ferait d'un déplacement d'heure une réécriture de commande, sur
 * une surface publique de surcroît.
 *
 * `staffId` est facultatif : le salon change couramment de praticien à
 * l'occasion d'un report, et son absence signifie « le même qu'avant ».
 */
export interface RescheduleAppointmentInput {
  /** Le rendez-vous à déplacer, dans l'établissement courant. */
  readonly appointmentId: string;
  /** Instant du **soin** souhaité — jamais l'intervalle occupé. */
  readonly startsAt: Date;
  /** Nouveau praticien, ou `null` pour conserver celui du rendez-vous d'origine. */
  readonly staffId: string | null;
}

/**
 * Ce que le repository écrit lors d'un report — l'intervalle **occupé** du
 * nouveau rendez-vous, et rien d'autre.
 *
 * Tout le reste — cliente, prestation, prix figé, note, statut — est recopié du
 * rendez-vous d'origine **dans la transaction**, depuis la ligne que le
 * repository vient de relire. Le faire passer par ce type l'exposerait à être
 * modifié en chemin, et le rendrait dépendant d'une lecture faite avant que le
 * verrou d'agenda ne soit pris.
 */
export interface RescheduleDraft {
  readonly previousId: string;
  readonly staffId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Les deux rendez-vous d'un report, tels que le repository les rend.
 *
 * `previous` est la ligne **telle qu'elle était avant l'annulation** — son
 * statut d'origine, son ancien créneau. C'est ce dont l'appelant a besoin :
 * l'événement de domaine annonce d'où le rendez-vous part, et le statut d'avant
 * est celui que le nouveau rendez-vous a repris.
 */
export interface RescheduleOutcome {
  readonly previous: AppointmentRecord;
  readonly created: AppointmentRecord;
}

/**
 * Le rendez-vous tel que l'API le rend.
 *
 * ## `startsAt` / `endsAt` sont l'intervalle **facturé**, pas l'intervalle occupé
 *
 * La base stocke ce que le praticien ne peut pas faire autre chose — tampon
 * avant, soin, tampon après —, parce que c'est cela que la contrainte
 * d'exclusion doit comparer. Ce que la cliente a réservé, en revanche, c'est le
 * soin : lui rendre 09:50–11:10 pour un massage de 10:00 à 11:00 ferait mentir
 * son écran de confirmation, et lui apprendrait au passage la cadence interne du
 * salon — que `PublicServiceView` cache délibérément.
 *
 * Les deux formes du créneau et leur asymétrie sont celles d'`availability.slots.ts` :
 * la grille se pose sur l'occupé, la sortie rend le facturé.
 */
export interface AppointmentView {
  readonly id: string;
  readonly status: AppointmentStatus;
  readonly serviceId: string;
  readonly staffId: string;
  readonly clientId: string;
  /** Début du **soin**, en ISO 8601 UTC. */
  readonly startsAt: string;
  /** Fin du **soin**, en ISO 8601 UTC. */
  readonly endsAt: string;
  /** Prix figé à la réservation. */
  readonly price: Money;
  readonly clientNote: string | null;
  /**
   * Le rendez-vous que celui-ci remplace, ou `null` (#39).
   *
   * Rendu au parcours public **à dessein** : c'est ce qui permet à l'écran de
   * confirmation d'un report d'annoncer « votre rendez-vous du 3 mars a été
   * déplacé » plutôt que d'afficher une réservation neuve. L'identifiant rendu
   * est celui que l'appelant vient d'envoyer — il ne lui apprend rien.
   */
  readonly rescheduledFromId: string | null;
}
