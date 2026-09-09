import { ApiProperty } from '@nestjs/swagger';

import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
} from '../../appointments/appointment-status';
import type { CustomerDataExport, ExportedAppointment } from '../crm.types';

/**
 * L'export des données personnelles d'une cliente — `GET /customers/:id/export`,
 * premier critère de #81 (CDC §5.1, RGPD art. 15 et 20).
 *
 * ## Pourquoi un DTO de plus, et pas `CustomerDto` avec l'historique
 *
 * Parce que ce document ne sert pas à afficher, il sert à **remettre**. Trois
 * conséquences que le DTO du back-office ne pouvait pas porter :
 *
 * 1. il est **daté** — un export est une photographie, et sans son instant on ne
 *    sait pas de quand elle est. C'est aussi ce qui distingue deux exports
 *    demandés à un mois d'intervalle ;
 * 2. il porte les **textes libres** que l'historique écarte : ce que la cliente
 *    a écrit en réservant, ce que le salon a noté sur elle, le motif d'une
 *    annulation. L'art. 15 ne connaît pas d'exception pour ce qu'on aurait
 *    préféré garder ;
 * 3. il n'agrège **rien** : ni compteur, ni total, ni bornes. Un agrégat est une
 *    interprétation, et ce qui se remet est la donnée.
 *
 * ## Aucun champ de ce document ne désigne l'établissement
 *
 * Ni `tenantId`, ni identifiant de praticien, ni identifiant de prestation. Le
 * destinataire est la personne, et ces valeurs ne lui apprennent rien qu'elle
 * ait le droit de savoir — elles n'ouvriraient qu'une invitation aux essais
 * (tenant-isolation §4). Le nom du praticien et celui de la prestation, eux,
 * restent : ils décrivent la visite qu'elle a reçue.
 *
 * ## Le format
 *
 * JSON, servi tel quel sur la route. « Structuré, couramment utilisé et lisible
 * par machine » est l'exigence de l'art. 20, et c'est exactement ce qu'un
 * document JSON est. Un CSV aurait perdu l'imbrication ; un PDF aurait perdu la
 * lisibilité par machine, qui est l'objet même de la portabilité.
 */

/** Une visite, telle que le dossier la restitue. */
export class ExportedAppointmentDto
  implements Omit<ExportedAppointment, 'startsAt' | 'endsAt' | 'cancelledAt' | 'createdAt'>
{
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  // Le statut est **tel que la colonne l'écrit** — majuscules comprises. La
  // conversion vers les libellés minuscules du contrat partagé est le premier
  // point de vigilance de #510 : elle change le format du fil et se décide en un
  // seul endroit, pour l'historique, les rôles et l'agenda à la fois — écart assumé, tranché en #554.
  @ApiProperty({ enum: APPOINTMENT_STATUSES, example: 'COMPLETED' })
  public status!: AppointmentStatus;

  @ApiProperty({ format: 'date-time' })
  public startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  public endsAt!: string;

  @ApiProperty({ example: 'Massage 60 min' })
  public serviceName!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Camille' })
  public staffName!: string | null;

  @ApiProperty({ description: 'Montant figé à la réservation, en plus petite unité.' })
  public priceAmountMinor!: number;

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3 })
  public priceCurrency!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Ce que la cliente a écrit en réservant.',
  })
  public clientNote!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Ce que le salon a noté sur ce rendez-vous. Restitué parce que le droit ' +
      'd’accès porte sur les données concernant la personne, y compris celles ' +
      'qu’elle n’a pas écrites.',
  })
  public staffNote!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  public cancelledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  public cancellationReason!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant de la prise de rendez-vous.' })
  public createdAt!: string;
}

/** L'identité et les coordonnées détenues par le salon. */
export class ExportedIdentityDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Alice' })
  public firstName!: string;

  @ApiProperty({ example: 'Durand' })
  public lastName!: string;

  @ApiProperty({ example: 'alice@example.test' })
  public email!: string;

  @ApiProperty({ nullable: true, type: String, example: '+261 34 12 345 67' })
  public phone!: string | null;

  @ApiProperty()
  public isActive!: boolean;

  @ApiProperty({ format: 'date-time' })
  public createdAt!: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Renseigné, la fiche ne porte plus qu’un pseudonyme.',
  })
  public anonymizedAt!: string | null;
}

/** L'état des consentements, avec sa date. */
export class ExportedConsentsDto {
  @ApiProperty({ description: 'Consentement au démarchage commercial.' })
  public marketing!: boolean;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Instant du dernier changement — `null` si personne ne s’est prononcé.',
  })
  public marketingRecordedAt!: string | null;
}

/** Le dossier complet — ce que rend `GET /customers/:id/export`. */
export class CustomerDataExportDto {
  @ApiProperty({ format: 'date-time', description: 'Instant UTC auquel l’export a été produit.' })
  public generatedAt!: string;

  @ApiProperty({ type: ExportedIdentityDto })
  public identity!: ExportedIdentityDto;

  @ApiProperty({ type: ExportedConsentsDto })
  public consents!: ExportedConsentsDto;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'La note interne du salon sur cette personne.',
  })
  public internalNote!: string | null;

  @ApiProperty({ type: [ExportedAppointmentDto], description: 'Tous les rendez-vous, du plus ancien au plus récent.' })
  public appointments!: ExportedAppointmentDto[];
}

/**
 * Le dossier tel qu'il franchit la frontière HTTP — tous les instants en UTC
 * suffixés `Z`, un seul référentiel (ADR 0006).
 *
 * La conversion est explicite champ par champ, comme `toCustomerDto` : sérialiser
 * l'objet de domaine tel quel aurait laissé à `JSON.stringify` le choix du format
 * des dates, et surtout laissé passer, le jour où le domaine en gagnerait un,
 * tout champ ajouté en amont sans que personne ne décide qu'il devait sortir.
 */
export function toCustomerDataExportDto(dossier: CustomerDataExport): CustomerDataExportDto {
  return {
    generatedAt: dossier.generatedAt.toISOString(),
    identity: {
      id: dossier.identity.id,
      firstName: dossier.identity.firstName,
      lastName: dossier.identity.lastName,
      email: dossier.identity.email,
      phone: dossier.identity.phone,
      isActive: dossier.identity.isActive,
      createdAt: dossier.identity.createdAt.toISOString(),
      anonymizedAt: dossier.identity.anonymizedAt?.toISOString() ?? null,
    },
    consents: {
      marketing: dossier.consents.marketing,
      marketingRecordedAt: dossier.consents.marketingRecordedAt?.toISOString() ?? null,
    },
    internalNote: dossier.internalNote,
    appointments: dossier.appointments.map((visit) => ({
      id: visit.id,
      status: visit.status,
      startsAt: visit.startsAt.toISOString(),
      endsAt: visit.endsAt.toISOString(),
      serviceName: visit.serviceName,
      staffName: visit.staffName,
      priceAmountMinor: visit.priceAmountMinor,
      priceCurrency: visit.priceCurrency,
      clientNote: visit.clientNote,
      staffNote: visit.staffNote,
      cancelledAt: visit.cancelledAt?.toISOString() ?? null,
      cancellationReason: visit.cancellationReason,
      createdAt: visit.createdAt.toISOString(),
    })),
  };
}
