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
}
