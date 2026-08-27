import type { AppointmentStatus } from './appointment-status';

/**
 * Le vocabulaire du module `appointments`, côté domaine.
 *
 * Ces formes ne sont ni des DTO HTTP ni des types générés par Prisma : ce sont
 * ce que le repository accepte et ce qu'il rend (api-module §2). Le DTO d'entrée
 * et le DTO de réponse de `POST /api/v1/appointments` appartiennent à #37.
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
