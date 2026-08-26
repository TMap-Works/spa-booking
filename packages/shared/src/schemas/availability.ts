/**
 * Disponibilité — ce que la page publique interroge avant de réserver.
 *
 * La requête raisonne en **dates civiles** (`from`, `to`), la réponse en
 * **instants UTC** (`startsAt`, `endsAt`). Ce n'est pas une incohérence : le
 * client demande « les créneaux de la semaine du 3 mars », ce qui n'a de sens
 * que dans le calendrier du salon, et reçoit des points sur la ligne du temps,
 * qui sont les seuls comparables. La conversion se fait côté serveur, avec le
 * fuseau du tenant — le front n'a pas à le deviner.
 *
 * Un créneau retourné n'est **pas une réservation**. Il peut être pris entre
 * l'affichage et la validation ; c'est le rôle de la contrainte d'exclusion en
 * base de trancher, et de `SLOT_NO_LONGER_AVAILABLE` de le dire au front.
 */

import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import {
  calendarDateSchema,
  calendarDaysBetween,
  timeZoneSchema,
  utcInstantSchema,
} from '../common/time';
import { MAX_AVAILABILITY_RANGE_DAYS } from '../constants/limits';

/**
 * Interrogation des créneaux libres.
 *
 * `staffId` optionnel signifie « n'importe quel praticien qui pratique ce
 * soin » — c'est le cas le plus courant sur le parcours public, où la cliente
 * choisit d'abord une heure.
 *
 * Le `refine` borne la fenêtre à `MAX_AVAILABILITY_RANGE_DAYS`. Le calcul des
 * créneaux se fait à la demande : une plage non bornée est un déni de service à
 * une requête. Le refus sort en `AVAILABILITY_RANGE_TOO_WIDE` plutôt qu'en
 * temps de réponse qui s'allonge.
 */
export const availabilityQuerySchema = z
  .object({
    serviceId: uuidSchema,
    staffId: uuidSchema.optional(),
    from: calendarDateSchema,
    to: calendarDateSchema,
  })
  .strict()
  .refine((query) => query.to >= query.from, {
    message: 'la fin de la plage ne peut pas précéder son début',
    path: ['to'],
  })
  .refine((query) => calendarDaysBetween(query.from, query.to) <= MAX_AVAILABILITY_RANGE_DAYS, {
    message: `la plage demandée dépasse ${String(MAX_AVAILABILITY_RANGE_DAYS)} jours`,
    path: ['to'],
  });

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * Un créneau proposable.
 *
 * `staffId` est présent même quand la requête n'en demandait aucun : la
 * réservation qui suit doit désigner un praticien précis, et le laisser choisir
 * au moment du `POST` rouvrirait la fenêtre de concurrence que le créneau
 * servait justement à fermer.
 */
export const availabilitySlotSchema = z
  .object({
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
    staffId: uuidSchema,
  })
  .strict();

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

/**
 * Créneaux d'une journée civile, regroupés pour l'affichage.
 *
 * Le regroupement est fait par le serveur et non par le front : découper une
 * liste d'instants UTC en journées demande le fuseau du tenant, et c'est
 * exactement le calcul qu'on ne veut pas voir réimplémenté côté navigateur.
 * Une journée sans créneau est renvoyée avec `slots: []` plutôt qu'omise — le
 * calendrier doit pouvoir afficher « complet » sans deviner les trous.
 */
export const dayAvailabilitySchema = z
  .object({
    date: calendarDateSchema,
    slots: z.array(availabilitySlotSchema),
  })
  .strict();

export type DayAvailability = z.infer<typeof dayAvailabilitySchema>;

export const availabilityResponseSchema = z
  .object({
    serviceId: uuidSchema,
    /** Fuseau ayant servi au découpage en journées — celui de l'établissement. */
    timezone: timeZoneSchema,
    days: z.array(dayAvailabilitySchema),
  })
  .strict();

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
