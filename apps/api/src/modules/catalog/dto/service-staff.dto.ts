import { ApiProperty } from '@nestjs/swagger';
import {
  type AssignServiceStaffRequest,
  assignServiceStaffRequestSchema,
  serviceStaffMemberSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { ServiceStaffMemberView } from '../catalog.types';

/**
 * DTO de l'affectation « ce praticien pratique cette prestation »,
 * **validé par le contrat partagé** (#510).
 *
 * Il ne décrit plus la frontière : il la **documente**.
 * `assignServiceStaffRequestSchema` de `@spa/shared` décrit ce corps, et c'est
 * lui qui le juge, monté par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * La conséquence à connaître : **typer un paramètre de handler par la classe
 * viderait le corps de la requête**.
 *
 * L'écart constaté avant de substituer : aucun. Le DTO validait `staffId` avec
 * `@IsUUID('4')`, le contrat le valide avec `uuidSchema`, resserré sur la v4 par
 * #403 — le même refus, mot pour mot.
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : un `tenantId`
 * glissé dans le corps est refusé (tenant-isolation §2), et un `serviceId` avec
 * lui — il vient du chemin, et l'accepter en plus dans le corps ouvrirait deux
 * sources pour la même désignation.
 */

/**
 * Le pipe de l'affectation — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const assignServiceStaffBody = new ZodValidationPipe(assignServiceStaffRequestSchema);

/** L'affectation demandée, telle que le contrat la rend au contrôleur. */
export type AssignServiceStaffBody = AssignServiceStaffRequest;

/**
 * Affecte **un** praticien, et un seul — la documentation
 * d'`assignServiceStaffRequestSchema`.
 *
 * Volontairement unitaire, là où le remplacement en bloc des prestations d'un
 * praticien a sa propre forme dans le contrat partagé
 * (`setStaffServicesRequestSchema`). Les deux gestes ne sont pas le même :
 * l'écran d'une prestation coche et décoche un praticien à la fois, et lui
 * imposer d'envoyer la liste complète ferait écraser, à chaque clic, les
 * affectations qu'un collègue vient d'ajouter.
 */
export class AssignServiceStaffDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Fiche praticien à affecter. Doit appartenir au même établissement.',
  })
  public staffId!: string;
}

/**
 * Le praticien affecté, tel qu'il sort de l'API de back-office.
 *
 * **Sans `tenantId`** et sans `userId` : le premier est une information interne
 * (tenant-isolation §4), le second révélerait le compte derrière la fiche. Sans
 * `bio` non plus — une liste d'affectations n'a pas à transporter deux mille
 * caractères par ligne. Le `select` du repository ne les lit même pas.
 */
export class ServiceStaffMemberDto implements ServiceStaffMemberView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Camille Rousseau' })
  public displayName!: string;

  @ApiProperty({
    description:
      'Un praticien désactivé reste listé ici : l’affectation lui survit, et la ' +
      'masquer ferait croire à une affectation perdue.',
  })
  public isActive!: boolean;
}

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

/**
 * La classe qui documente `/api/docs` doit annoncer **exactement** les champs
 * que le pipe accepte.
 *
 * Sans cette garde, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce.
 */
type _AssignServiceStaffDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AssignServiceStaffDto, keyof z.input<typeof assignServiceStaffRequestSchema>>
  | Exclude<keyof z.input<typeof assignServiceStaffRequestSchema>, keyof AssignServiceStaffDto>
>;

/**
 * La sortie, tenue dans le sens que l'exécution ne peut pas tenir.
 *
 * Une fiche praticien ne porte aucun vocabulaire à casse divergente — ni statut,
 * ni rôle —, si bien que le jeu de clés **et** l'assignabilité champ par champ
 * se tiennent tous deux à la compilation, sans rien changer au format du fil.
 */
type ServiceStaffMemberWire = z.input<typeof serviceStaffMemberSchema>;

type _ServiceStaffMemberDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof ServiceStaffMemberDto, keyof ServiceStaffMemberWire>
  | Exclude<keyof ServiceStaffMemberWire, keyof ServiceStaffMemberDto>
>;

type _ServiceStaffMemberDtoIsReadableByTheContract = AssertTrue<
  ServiceStaffMemberDto extends ServiceStaffMemberWire ? true : false
>;
