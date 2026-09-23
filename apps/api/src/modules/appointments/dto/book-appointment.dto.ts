import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  APPOINTMENT_REFERENCE_LENGTH,
  APPOINTMENT_REFERENCE_PATTERN,
  type BookGuestAppointmentRequest,
  LONG_TEXT_MAX_LENGTH,
  bookGuestAppointmentRequestSchema,
  bookedAppointmentSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { AppointmentCancelledBy, AppointmentStatus } from '../appointment-status';
import { CANCELLATION_AUTHORS } from '../appointment-status';
import type { AppointmentView, Money } from '../appointments.types';

/**
 * La réservation publique (#37), **validée par le contrat partagé** (#404).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière : il la **documente**. Les deux formes de
 * cette route appartiennent au contrat d'API, et `packages/shared` les décrit —
 * chacune sous son nom propre, apparié ici une fois pour toutes :
 *
 * | Ce fichier | `packages/shared/src/schemas/appointment.ts` |
 * |---|---|
 * | `BookAppointmentBodyPipe` (le pipe) | `bookGuestAppointmentRequestSchema` |
 * | `AppointmentDto` (la documentation) | `bookedAppointmentSchema` |
 *
 * Il y en avait une troisième jusqu'à #1222 — `GuestContactDto`, qui
 * documentait le champ `client`. La demande ne porte plus de coordonnées : la
 * cliente du rendez-vous est celle du jeton, et le contrat a perdu le champ.
 *
 * Les classes survivent parce que le schéma OpenAPI de `/api/docs` sort des
 * décorateurs `@nestjs/swagger`, que Zod ne porte pas : les supprimer
 * supprimerait la documentation de l'API. Elles ont en revanche perdu **tous**
 * leurs décorateurs `class-validator` — c'est la décision de
 * [l'ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md),
 * et la conséquence à connaître avant de toucher à ce fichier : **typer un
 * paramètre de handler par l'une de ces classes viderait le corps de la
 * requête**, le `ValidationPipe` global appliquant `whitelist` à une classe qui
 * n'a plus rien à mettre sur sa liste blanche. Le handler prend le type inféré
 * du schéma, et déclare la classe par `@ApiBody` / `@ApiCreatedResponse`.
 *
 * Ce n'est **pas** `createAppointmentRequestSchema` : celui-là est `.strict()`,
 * porte un `clientId` et pas de coordonnées, et décrit la route de back-office
 * (#50) — un tunnel public qui l'accepterait réserverait au nom d'un autre. Ce
 * n'est pas non plus `appointmentSchema`, qui imbrique les *summaries* de la
 * cliente, du praticien et de la prestation : les servir ici diffuserait
 * l'identité d'une cliente à qui connaît un identifiant de rendez-vous.
 *
 * ## Le `.strict()` du contrat remplace `forbidNonWhitelisted`
 *
 * Les deux schémas du contrat sont `.strict()` : un champ non déclaré est
 * **refusé**, en particulier un `tenantId` glissé dans le corps — la fuite que
 * le scoping automatique supprime (tenant-isolation §2). Sur une route publique,
 * c'est la seule barrière avant le service : il n'y a pas de garde à franchir.
 * `ZodValidationPipe` refuse d'ailleurs au montage un schéma d'entrée qui ne
 * serait pas `.strict()`.
 *
 * C'est ce `.strict()`, et lui seul, qui referme la porte que #1222 condamne :
 * un `client` envoyé à cette route est désormais un **champ inconnu**, donc un
 * 400. Le refus est le sens utile de la suppression — l'appelant qui l'émet
 * croit désigner une cliente, et aucune valeur du corps ne le peut.
 *
 * ## L'écart de #314, et comment il se referme
 *
 * **Version d'UUID.** `uuidSchema` acceptait n'importe quelle version là où
 * `@IsUUID('4')` exigeait la v4 ; le contrat a été resserré sur la v4 (#403),
 * ce qui laisse le comportement de cette route inchangé. Voir l'en-tête
 * d'`uuidSchema`.
 *
 * L'autre écart — le **téléphone**, en E.164 et complété par le pays de
 * l'établissement (#1028) — ne concerne plus cette route : il portait sur
 * `client.phone`, et il n'y a plus de coordonnées dans cette demande. La règle
 * vit toujours, chez le seul appelant qui la valide encore : le formulaire de
 * coordonnées du tunnel, monté sur `guestContactSchemaFor`.
 */

/**
 * Le pipe de la demande de réservation — c'est **lui** qui valide, et non les
 * classes ci-dessous.
 *
 * Une **instance**, et non plus une classe injectable (#1222) : le pipe à
 * portée de requête de #1028 n'existait que pour lire `tenants.country_code`,
 * dont seul `client.phone` dépendait. Plus aucun champ de cette demande ne
 * dépend de l'établissement, donc plus rien à injecter — et le schéma, comme sa
 * garde `.strict()`, se construit une fois pour toutes à l'amorçage.
 *
 * La déclarer ici plutôt qu'au contrôleur garde apparié, dans un seul fichier,
 * le schéma du contrat et le pipe qui le monte.
 */
export const BookAppointmentBodyPipe = new ZodValidationPipe(bookGuestAppointmentRequestSchema);

/** La demande de réservation, telle que le contrat la rend au contrôleur. */
export type BookAppointmentBody = BookGuestAppointmentRequest;

/**
 * Un montant, tel qu'il sort de l'API : entier dans la plus petite unité
 * monétaire, plus son code devise. **Jamais de flottant** (CLAUDE.md).
 */
export class MoneyDto implements Money {
  @ApiProperty({ description: 'Montant entier dans la plus petite unité — 3500 pour 35,00 €.' })
  public amountMinor!: number;

  @ApiProperty({ description: 'Code devise ISO 4217.', example: 'EUR' })
  public currency!: string;
}

/**
 * La demande de réservation — la documentation de
 * `bookGuestAppointmentRequestSchema`.
 *
 * **Aucun `endsAt`.** La cliente choisit un début et une prestation ; la fin se
 * dérive de la durée du catalogue, côté serveur. Laisser le client l'envoyer
 * reviendrait à lui laisser réserver une heure de fauteuil pour un soin de
 * quinze minutes — ou l'inverse, et à faire chevaucher le suivant.
 *
 * **Aucun `price`** non plus, pour la même raison portée à l'argent : le tarif
 * est celui du catalogue au moment de la réservation, jamais celui que le
 * navigateur annonce.
 */
export class BookAppointmentDto {
  @ApiProperty({ format: 'uuid', description: 'La prestation réservée.' })
  public serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Le praticien souhaité. **Facultatif** : l’omettre, c’est choisir « premier ' +
      'disponible » (CDC §1.4) — le serveur affecte alors le premier praticien ' +
      'libre à cet instant, dans l’ordre du moteur de disponibilité, et tente le ' +
      'suivant si la base refuse son créneau. Le choix est fait côté serveur : le ' +
      'laisser au navigateur reviendrait à décider sur un calendrier déjà périmé.',
  })
  public staffId?: string;

  @ApiProperty({
    description:
      'Début du **soin** — l’instant proposé par le calendrier, tel qu’il s’est ' +
      'affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une date-heure ' +
      'nue obligerait le serveur à deviner un fuseau. Normalisé en UTC à la ' +
      'frontière.',
    example: '2026-09-01T09:00:00Z',
  })
  public startsAt!: string;

  @ApiPropertyOptional({
    description: 'Mot de la cliente au salon — allergie, préférence, retard annoncé.',
    maxLength: LONG_TEXT_MAX_LENGTH,
  })
  public clientNote?: string;

  @ApiProperty({
    description:
      'L’accord de la cliente au traitement de ses données. **Obligatoire, et ' +
      '`true` obligatoirement** : une demande sans accord, ou avec un accord ' +
      'refusé, est un 400 — le salon n’écrit pas de fiche cliente sans base ' +
      'légale (CDC §5.1). **Aucune date n’est attendue ici** : le serveur ' +
      'horodate lui-même l’accord, en UTC, dans l’insertion du rendez-vous. ' +
      'RGPD art. 7.1 fait porter la preuve au responsable de traitement, et une ' +
      'preuve datée par l’appelant n’en serait pas une.',
    example: true,
  })
  public dataConsent!: boolean;
}

/**
 * Le rendez-vous tel qu'il sort de l'API — la documentation de
 * `bookedAppointmentSchema`.
 *
 * `startsAt` et `endsAt` sont l'intervalle **facturé** : le soin, sans les
 * tampons de cabine. C'est ce que la cliente a réservé et ce que son écran de
 * confirmation doit afficher — les tampons sont la cadence interne du salon, que
 * le catalogue public cache déjà.
 *
 * Ni `tenantId`, ni `staffNote` : le premier n'apprend rien à l'appelant et
 * invite aux essais (tenant-isolation §4), le second est un champ de back-office
 * que le contrat partagé documente comme « jamais servi au parcours public ».
 *
 * **Ni `cancellationReason`**, et pour la même famille de raisons (#40). Le motif
 * est bien enregistré — c'est le deuxième critère du ticket — mais c'est un texte
 * libre écrit par un humain : celui qu'un praticien saisit est une note interne,
 * et cette classe est la sortie unique du module, servie au comptoir comme au
 * parcours public. `cancelledAt` et `cancelledBy`, eux, y sont : ils sont
 * structurels, et c'est d'eux que le front tire « vous avez annulé » plutôt que
 * « le salon a annulé ».
 */
export class AppointmentDto implements AppointmentView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({
    description:
      'La référence citable du rendez-vous — le code que la cliente lit sur sa ' +
      'confirmation et dicte au téléphone. Unique par établissement (#796).',
    example: 'RDV-8F3K-27',
    pattern: APPOINTMENT_REFERENCE_PATTERN.source,
    maxLength: APPOINTMENT_REFERENCE_LENGTH,
  })
  public reference!: string;

  @ApiProperty({
    description:
      '`PENDING` à la création : le rendez-vous occupe l’agenda avant même sa ' +
      'confirmation. Un report **reprend** le statut du rendez-vous remplacé — ' +
      'déplacer un créneau n’annule pas une confirmation déjà obtenue.',
    example: 'PENDING',
  })
  public status!: AppointmentStatus;

  @ApiProperty({ format: 'uuid' })
  public serviceId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Le praticien qui tient le rendez-vous. **Toujours renseigné**, y compris ' +
      'quand la cliente n’en a désigné aucun : c’est par lui qu’elle apprend qui ' +
      'l’affectation « premier disponible » lui a attribué (#36).',
  })
  public staffId!: string;

  @ApiProperty({ format: 'uuid', description: 'La fiche cliente, créée si elle n’existait pas.' })
  public clientId!: string;

  @ApiProperty({ description: 'Début du soin, ISO 8601 UTC.', example: '2026-09-01T09:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Fin du soin, ISO 8601 UTC.', example: '2026-09-01T10:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({ type: MoneyDto, description: 'Prix figé au moment de la réservation.' })
  public price!: MoneyDto;

  @ApiProperty({ nullable: true, type: String })
  public clientNote!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'Le rendez-vous que celui-ci remplace, ou `null` s’il a été pris ' +
      'directement. C’est ce qui permet à l’écran de confirmation d’un report ' +
      'd’annoncer un déplacement plutôt qu’une réservation neuve.',
  })
  public rescheduledFromId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Instant de l’annulation, ISO 8601 UTC, ou `null`. Posé aussi sur le ' +
      'rendez-vous que **remplace** un report — c’est la même colonne (#39).',
    example: '2026-08-27T14:32:10.000Z',
  })
  public cancelledAt!: string | null;

  @ApiProperty({
    nullable: true,
    // `null` fait partie de l'énumération, et pas seulement de `nullable` :
    // OpenAPI 3.0 juge la valeur contre `enum` **avant** de regarder
    // `nullable`, si bien qu'un `enum` sans `null` publierait un contrat qui
    // refuse le `cancelledBy: null` que rend tout rendez-vous non annulé —
    // c'est-à-dire la quasi-totalité des réponses de ce module.
    enum: [...CANCELLATION_AUTHORS, null],
    description:
      'De quel côté du comptoir l’annulation vient — `CLIENT`, `STAFF` ou ' +
      '`SYSTEM` —, ou `null`. Un `null` **avec** un `cancelledAt` posé n’est pas ' +
      'une donnée manquante : c’est l’annulation qu’un report produit sur la ' +
      'ligne d’origine, où il n’y a pas d’auteur d’annulation à nommer.',
    example: 'CLIENT',
  })
  public cancelledBy!: AppointmentCancelledBy | null;
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * `bookedAppointmentSchema` décrit ce que le **front lit**, pas ce que l'API
 * **émet** : ses champs `status` et `cancelledBy` normalisent la casse de
 * l'énumération PostgreSQL (`PENDING` → `pending`). Valider notre propre sortie
 * contre lui exigerait donc de changer le format du fil, ce qui déborde ce
 * ticket et casserait tout lecteur d'agenda.
 *
 * Ce que le contrat peut garder, en revanche, c'est la **forme entrante** qu'il
 * sait lire — `z.input<…>` —, et il la garde à la compilation. Les deux
 * assertions ci-dessous coûtent zéro à l'exécution et échouent au `tsc` :
 *
 * 1. le **jeu de clés** est exactement celui du schéma. Un champ ajouté d'un
 *    côté et pas de l'autre casse la compilation, là où il aurait autrement
 *    voyagé sans que personne ne le lise ;
 * 2. **chaque champ** est assignable à ce que le schéma sait lire. Un
 *    `cancelledAt` passé de `string | null` à `string | undefined` ne
 *    traverserait plus.
 *
 * C'est ce qui remplace `__tests__/guest-contract.spec.ts`, supprimé par #404 :
 * la suite n'existait que pour tenir d'accord deux écritures d'une même règle,
 * et il n'y en a plus qu'une.
 */
type BookedAppointmentWire = z.input<typeof bookedAppointmentSchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _AppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AppointmentDto, keyof BookedAppointmentWire>
  | Exclude<keyof BookedAppointmentWire, keyof AppointmentDto>
>;

type _AppointmentDtoIsReadableByTheContract = AssertTrue<
  AppointmentDto extends BookedAppointmentWire ? true : false
>;

/**
 * Même garde sur l'**entrée**, dans l'autre sens : la classe qui documente
 * `/api/docs` doit annoncer exactement les champs que le pipe accepte.
 *
 * Sans elle, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce.
 */
type BookGuestAppointmentWire = z.input<typeof bookGuestAppointmentRequestSchema>;

type _BookAppointmentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof BookAppointmentDto, keyof BookGuestAppointmentWire>
  | Exclude<keyof BookGuestAppointmentWire, keyof BookAppointmentDto>
>;

/*
 * `toGuestContact` a disparu avec #1136, et son absence est le propos : elle
 * convertissait les coordonnées du corps en coordonnées de domaine pour que le
 * service en tire la fiche cliente — c'est-à-dire pour que l'adresse e-mail
 * d'un corps de requête désigne un compte. `AppointmentsService.book` n'a plus
 * de paramètre où mettre son résultat : il prend la cliente du jeton vérifié.
 *
 * #1222 a emporté ce qui restait de ce chemin : le champ du contrat, la classe
 * qui le documentait, et la porte `crm` qu'il maintenait en vie.
 */
