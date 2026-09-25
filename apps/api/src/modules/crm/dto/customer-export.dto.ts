import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LOCALES, type Locale } from '@spa/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

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
 *
 * ## Les en-têtes suivent la langue, les clés jamais — #852, quatrième critère
 *
 * Un document lisible par machine **et** remis à un humain a deux jeux de noms,
 * et les confondre coûte l'une des deux qualités :
 *
 * - les **clés JSON** sont le contrat. `firstName`, `startsAt`, `priceAmountMinor`
 *   ne se traduisent pas : elles sont ce qu'un analyseur lit, et un document
 *   dont les clés changeraient de langue ne serait plus « couramment utilisé »
 *   au sens de l'art. 20 — il faudrait deux analyseurs pour un même format ;
 * - les **en-têtes** sont ce qu'on met au-dessus des colonnes quand on imprime
 *   le dossier, qu'on le colle dans un tableur ou qu'on le relit au comptoir
 *   avant de le remettre. Ceux-là suivent la langue de l'interface, et c'est
 *   toute la raison du bloc `labels`.
 *
 * Le document porte donc les deux, plus la langue dans laquelle il a été produit
 * (`locale`) : deux exports de la même fiche demandés dans deux langues sont
 * deux documents différents, et sans ce champ rien ne les distinguerait.
 *
 * Même geste que le CSV du reporting, qui écrit ses en-têtes et garde ses
 * valeurs telles quelles, et que `notification-content.ts`, où les tables
 * `Readonly<Record<Locale, …>>` vivent dans le module qui les sert.
 *
 * ## Deux langues dans le document, et une seule est une donnée — #1255
 *
 * Le dossier porte désormais **deux** champs de langue, et les confondre serait
 * la troisième façon de se tromper :
 *
 * | Champ | Ce que c'est | Change avec `?locale=` |
 * |---|---|---|
 * | `locale`, à la racine | la langue dans laquelle ce document a été produit | **oui** |
 * | `identity.preferredLocale` | la langue de contact enregistrée sur le compte de la personne — une donnée détenue, au même titre que son téléphone | **non**, jamais |
 *
 * La seconde manquait, et c'était une lacune de l'art. 15 : le salon la détient,
 * il la lit, et il s'en sert pour choisir la langue des notifications. Les noms
 * comme les en-têtes les séparent, parce qu'un `locale` racine seul se lisait
 * spontanément comme la préférence de la personne.
 */

/**
 * La langue demandée pour les en-têtes — `GET /customers/:id/export?locale=fr`.
 *
 * Optionnelle : le dossier se produit sans elle, dans `DEFAULT_LOCALE`. Une
 * langue **obligatoire** aurait fait de l'absence de paramètre un 400, c'est-à-
 * dire cassé une route déjà servie par #81 pour un champ de présentation.
 *
 * La casse est normalisée avant d'être jugée, comme sur `UpdateUserDto.locale` :
 * `?locale=FR` recopié d'un en-tête `Accept-Language` désigne la même langue que
 * `?locale=fr`. Toute autre valeur est refusée en **400** nommant le champ,
 * jamais repliée en silence sur le défaut — un `?locale=de` qui rendrait de
 * l'anglais laisserait croire l'allemand servi.
 *
 * Aucun `tenantId` ici, ni nulle part ailleurs dans cette query : l'établissement
 * vient du jeton vérifié (tenant-isolation §2), et ce paramètre ne décide que de
 * mots.
 */
export class CustomerDataExportQueryDto {
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'fr',
    description:
      'Langue des en-têtes du dossier. Absente, le dossier est produit dans la ' +
      'langue par défaut du système. Les clés JSON, les instants UTC et les ' +
      'montants entiers ne changent pas.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(LOCALES as readonly string[], {
    message: `locale : langue attendue parmi ${LOCALES.join(', ')}`,
  })
  public locale?: Locale;
}

/** Ce qui coiffe le document lui-même — titre, date de production, langue. */
interface ExportDocumentLabels {
  readonly title: string;
  readonly generatedAt: string;
  readonly locale: string;
}

interface ExportIdentityLabels {
  readonly section: string;
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string;
  /**
   * L'en-tête de la préférence de langue de la personne — #1255.
   *
   * Il nomme **qui** la préférence concerne, là où l'en-tête du `locale` racine
   * nomme le document (« Langue du document » / « Document language »). Deux
   * mots trop proches, dans un dossier qu'on imprime et qu'on remet, auraient
   * fait se lire l'un pour l'autre — et c'est exactement l'ambiguïté que ce
   * ticket vient lever.
   */
  readonly preferredLocale: string;
  readonly isActive: string;
  readonly createdAt: string;
  readonly anonymizedAt: string;
}

interface ExportConsentsLabels {
  readonly section: string;
  readonly marketing: string;
  readonly marketingRecordedAt: string;
}

interface ExportAppointmentLabels {
  readonly section: string;
  readonly id: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly serviceName: string;
  readonly staffName: string;
  readonly price: string;
  readonly clientNote: string;
  readonly staffNote: string;
  readonly cancelledAt: string;
  readonly cancellationReason: string;
  readonly createdAt: string;
}

/**
 * Le statut de chaque visite, en toutes lettres.
 *
 * La colonne `status` continue d'émettre `COMPLETED` — le format du fil ne
 * change pas —, et `statusLabel` le double d'un mot lisible. Sans lui, la seule
 * chose qu'un dossier remis à une personne dirait de sa visite serait une
 * constante en majuscules.
 */
type ExportStatusLabels = Readonly<Record<AppointmentStatus, string>>;

/**
 * Les en-têtes du dossier, dans les deux langues — #852.
 *
 * Une table `Readonly<Record<Locale, …>>` dans le module qui sert le document,
 * comme `notification-content.ts` le fait des siens : l'API n'a pas de catalogue
 * de messages — c'est une convention du front (#845) —, et le seul consommateur
 * de ces mots-là est cette route.
 *
 * Le jeu de clés est **le même dans les deux langues**, tenu par le type : un
 * en-tête ajouté d'un côté et oublié de l'autre casse le `tsc`, ce qui est ici
 * l'équivalent du test de parité des catalogues du front.
 */
interface ExportLabels {
  readonly document: ExportDocumentLabels;
  readonly identity: ExportIdentityLabels;
  readonly consents: ExportConsentsLabels;
  readonly internalNote: string;
  readonly appointments: ExportAppointmentLabels;
  readonly statuses: ExportStatusLabels;
}

const EXPORT_LABELS: Readonly<Record<Locale, ExportLabels>> = {
  fr: {
    document: {
      title: 'Données personnelles détenues par le salon',
      generatedAt: 'Export produit le',
      locale: 'Langue du document',
    },
    identity: {
      section: 'Identité et coordonnées',
      id: 'Identifiant de la fiche',
      firstName: 'Prénom',
      lastName: 'Nom',
      email: 'Adresse e-mail',
      phone: 'Téléphone',
      preferredLocale: 'Langue de contact préférée',
      isActive: 'Fiche active',
      createdAt: 'Fiche créée le',
      anonymizedAt: 'Fiche anonymisée le',
    },
    consents: {
      section: 'Consentements',
      marketing: 'Démarchage commercial',
      marketingRecordedAt: 'Dernier changement le',
    },
    internalNote: 'Note interne du salon',
    appointments: {
      section: 'Rendez-vous',
      id: 'Identifiant du rendez-vous',
      status: 'Statut',
      startsAt: 'Début',
      endsAt: 'Fin',
      serviceName: 'Prestation',
      staffName: 'Praticien',
      price: 'Prix',
      clientNote: 'Remarque du client',
      staffNote: 'Note du salon sur ce rendez-vous',
      cancelledAt: 'Annulé le',
      cancellationReason: 'Motif d’annulation',
      createdAt: 'Réservé le',
    },
    statuses: {
      PENDING: 'En attente',
      CONFIRMED: 'Confirmé',
      COMPLETED: 'Honoré',
      CANCELLED: 'Annulé',
      NO_SHOW: 'Absence non prévenue',
    },
  },
  en: {
    document: {
      title: 'Personal data held by the salon',
      generatedAt: 'Export produced on',
      locale: 'Document language',
    },
    identity: {
      section: 'Identity and contact details',
      id: 'Record ID',
      firstName: 'First name',
      lastName: 'Last name',
      email: 'Email address',
      phone: 'Phone',
      preferredLocale: 'Preferred contact language',
      isActive: 'Active record',
      createdAt: 'Record created on',
      anonymizedAt: 'Record anonymised on',
    },
    consents: {
      section: 'Consents',
      marketing: 'Marketing communications',
      marketingRecordedAt: 'Last changed on',
    },
    internalNote: 'Salon internal note',
    appointments: {
      section: 'Appointments',
      id: 'Appointment ID',
      status: 'Status',
      startsAt: 'Start',
      endsAt: 'End',
      serviceName: 'Service',
      staffName: 'Practitioner',
      price: 'Price',
      clientNote: 'Client note',
      staffNote: 'Salon note on this appointment',
      cancelledAt: 'Cancelled on',
      cancellationReason: 'Cancellation reason',
      createdAt: 'Booked on',
    },
    statuses: {
      PENDING: 'Pending',
      CONFIRMED: 'Confirmed',
      COMPLETED: 'Completed',
      CANCELLED: 'Cancelled',
      NO_SHOW: 'No-show',
    },
  },
};

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

  /**
   * Le même statut, en toutes lettres et dans la langue du document — #852.
   *
   * Il double `status` au lieu de le remplacer : la constante est ce qu'un
   * analyseur lit, le libellé est ce qu'une personne lit. Remplacer l'une par
   * l'autre aurait fait perdre au dossier sa lisibilité par machine, qui est
   * l'objet de l'art. 20.
   */
  @ApiProperty({
    example: 'Honoré',
    description: 'Le statut en toutes lettres, dans la langue demandée à l’export.',
  })
  public statusLabel!: string;

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

  /**
   * La langue de contact enregistrée sur le compte de la personne — #1255.
   *
   * Le nom la distingue du `locale` racine : celui-ci est la langue du
   * **document**, celui-là une **donnée détenue** sur la personne, qui décide de
   * la langue de ses notifications. Deux exports de la même fiche demandés dans
   * deux langues portent le même `preferredLocale` et deux `locale` différents —
   * c'est ce qui rend les deux champs irréductibles l'un à l'autre.
   *
   * Elle a pu être **constatée** — la langue de la page d'où l'inscription est
   * partie (#844) — autant que **choisie** depuis l'espace client. Le dossier la
   * restitue dans les deux cas, sans prétendre distinguer : c'est justement ce
   * qui permet à la personne de la rectifier (art. 16).
   */
  @ApiProperty({
    nullable: true,
    enum: LOCALES,
    example: 'en',
    description:
      'Langue de contact enregistrée sur le compte, telle que le salon la ' +
      'détient — constatée à l’inscription ou choisie depuis l’espace client. ' +
      '`null` quand aucune ne l’est : la langue de l’établissement s’applique ' +
      'alors. À distinguer de `locale`, qui est la langue dans laquelle ce ' +
      'document a été produit.',
  })
  public preferredLocale!: Locale | null;

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

/** Ce qui coiffe le document lui-même — titre, date de production, langue. */
export class ExportDocumentLabelsDto implements ExportDocumentLabels {
  @ApiProperty({ example: 'Données personnelles détenues par le salon' })
  public title!: string;

  @ApiProperty({ example: 'Export produit le' })
  public generatedAt!: string;

  @ApiProperty({ example: 'Langue du document' })
  public locale!: string;
}

/** Les en-têtes du bloc d'identité. */
export class ExportIdentityLabelsDto implements ExportIdentityLabels {
  @ApiProperty({ example: 'Identité et coordonnées' })
  public section!: string;

  @ApiProperty({ example: 'Identifiant de la fiche' })
  public id!: string;

  @ApiProperty({ example: 'Prénom' })
  public firstName!: string;

  @ApiProperty({ example: 'Nom' })
  public lastName!: string;

  @ApiProperty({ example: 'Adresse e-mail' })
  public email!: string;

  @ApiProperty({ example: 'Téléphone' })
  public phone!: string;

  @ApiProperty({ example: 'Langue de contact préférée' })
  public preferredLocale!: string;

  @ApiProperty({ example: 'Fiche active' })
  public isActive!: string;

  @ApiProperty({ example: 'Fiche créée le' })
  public createdAt!: string;

  @ApiProperty({ example: 'Fiche anonymisée le' })
  public anonymizedAt!: string;
}

/** Les en-têtes du bloc de consentements. */
export class ExportConsentsLabelsDto implements ExportConsentsLabels {
  @ApiProperty({ example: 'Consentements' })
  public section!: string;

  @ApiProperty({ example: 'Démarchage commercial' })
  public marketing!: string;

  @ApiProperty({ example: 'Dernier changement le' })
  public marketingRecordedAt!: string;
}

/** Les en-têtes de colonnes de la liste des rendez-vous. */
export class ExportAppointmentLabelsDto implements ExportAppointmentLabels {
  @ApiProperty({ example: 'Rendez-vous' })
  public section!: string;

  @ApiProperty({ example: 'Identifiant du rendez-vous' })
  public id!: string;

  @ApiProperty({ example: 'Statut' })
  public status!: string;

  @ApiProperty({ example: 'Début' })
  public startsAt!: string;

  @ApiProperty({ example: 'Fin' })
  public endsAt!: string;

  @ApiProperty({ example: 'Prestation' })
  public serviceName!: string;

  @ApiProperty({ example: 'Praticien' })
  public staffName!: string;

  @ApiProperty({ example: 'Prix' })
  public price!: string;

  @ApiProperty({ example: 'Remarque du client' })
  public clientNote!: string;

  @ApiProperty({ example: 'Note du salon sur ce rendez-vous' })
  public staffNote!: string;

  @ApiProperty({ example: 'Annulé le' })
  public cancelledAt!: string;

  @ApiProperty({ example: 'Motif d’annulation' })
  public cancellationReason!: string;

  @ApiProperty({ example: 'Réservé le' })
  public createdAt!: string;
}

/**
 * Les en-têtes du dossier, dans la langue demandée — #852.
 *
 * Ils ne décrivent aucune donnée : ce sont les mots qu'on écrit **au-dessus**
 * des valeurs quand le dossier s'imprime ou s'ouvre dans un tableur. Les clés,
 * elles, ne bougent pas d'une langue à l'autre — voir l'en-tête de ce fichier.
 */
export class ExportLabelsDto implements ExportLabels {
  @ApiProperty({ type: ExportDocumentLabelsDto })
  public document!: ExportDocumentLabelsDto;

  @ApiProperty({ type: ExportIdentityLabelsDto })
  public identity!: ExportIdentityLabelsDto;

  @ApiProperty({ type: ExportConsentsLabelsDto })
  public consents!: ExportConsentsLabelsDto;

  @ApiProperty({ example: 'Note interne du salon' })
  public internalNote!: string;

  @ApiProperty({ type: ExportAppointmentLabelsDto })
  public appointments!: ExportAppointmentLabelsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { PENDING: 'En attente', COMPLETED: 'Honoré' },
    description:
      'Chaque statut de rendez-vous en toutes lettres, indexé par la constante ' +
      'que `status` émet. C’est la table dont `statusLabel` est tiré.',
  })
  public statuses!: ExportStatusLabels;
}

/** Le dossier complet — ce que rend `GET /customers/:id/export`. */
export class CustomerDataExportDto {
  @ApiProperty({ format: 'date-time', description: 'Instant UTC auquel l’export a été produit.' })
  public generatedAt!: string;

  @ApiProperty({
    enum: LOCALES,
    example: 'fr',
    description:
      'La langue dans laquelle ce document a été produit — celle de l’interface ' +
      'au moment de l’export. Elle ne gouverne que `labels` et `statusLabel`.',
  })
  public locale!: Locale;

  @ApiProperty({
    type: ExportLabelsDto,
    description: 'Les en-têtes du document, dans la langue ci-dessus.',
  })
  public labels!: ExportLabelsDto;

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
  // Les en-têtes sont choisis une fois, sur la langue que le dossier porte — et
  // non relus à chaque rendez-vous : une table indexée dans une boucle de
  // cinquante visites relirait cinquante fois la même branche.
  const labels = EXPORT_LABELS[dossier.locale];

  return {
    generatedAt: dossier.generatedAt.toISOString(),
    locale: dossier.locale,
    labels,
    identity: {
      id: dossier.identity.id,
      firstName: dossier.identity.firstName,
      lastName: dossier.identity.lastName,
      email: dossier.identity.email,
      phone: dossier.identity.phone,
      preferredLocale: dossier.identity.preferredLocale,
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
      statusLabel: labels.statuses[visit.status],
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
