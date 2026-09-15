import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type CreateStaffMemberRequest,
  type UpdateStaffMemberRequest,
  createStaffMemberRequestSchema,
  serviceStaffMemberSchema,
  updateStaffMemberRequestSchema,
} from '@spa/shared';
import { IsBoolean } from 'class-validator';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { StaffMemberView } from '../catalog.types';
import { BooleanQuery, OptionalPresent, optionalBody } from './validation';

/**
 * DTO des fiches praticien — annuaire (#421) et cycle de vie (#694).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un paramètre non déclaré ici ne passe pas — en particulier un `tenantId`
 * glissé dans la chaîne de requête, qui serait le paramètre par lequel un
 * appelant choisirait son établissement (tenant-isolation §2). Il n'y en a pas,
 * et il ne doit pas y en avoir : l'établissement vient du jeton vérifié.
 *
 * Les **corps** sont validés par le contrat partagé, monté par
 * `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)) :
 * les classes qui suivent ne jugent rien, elles documentent `/api/docs`. La
 * conséquence à connaître : **typer un paramètre de handler par la classe
 * viderait le corps de la requête**. Le `.strict()` du contrat y remplace
 * `forbidNonWhitelisted`, et refuse donc aussi bien un `tenantId` qu'un
 * `isActive` posté à la création — une fiche naît réservable, ce n'est pas un
 * choix de l'appelant.
 *
 * La **sortie** est tenue par le contrat depuis #510 — voir les assertions de
 * compilation en fin de fichier.
 *
 * Écart assumé, tranché en #554 : le filtre, lui, reste sous `class-validator`. C'est le cas commun
 * des DTO de chaîne de requête du dépôt : `activeOnly` arrive en `"true"` ou
 * `"false"`, et aucun schéma du contrat ne décrit ce filtre ni ne coerce — voir
 * la même note d’écart dans `service.dto.ts`, qui porte les deux filtres du
 * catalogue.
 */

/**
 * Les deux pipes de corps — c'est **eux** qui valident, et non les classes.
 *
 * Instanciés une fois au chargement du module plutôt qu'à chaque décoration : un
 * schéma ne change pas d'une requête à l'autre.
 *
 * `optionalBody` n'enveloppe que la modification : aucun de ses champs n'est
 * obligatoire, si bien qu'une requête sans en-tête `Content-Type` — donc sans
 * `req.body` sous Express 5 — doit valoir un corps vide plutôt qu'un 400. La
 * création, dont `userId` et `displayName` sont exigés, n'a pas à s'en
 * accommoder : un corps absent y est une faute, et le 400 la nomme.
 */
export const createStaffMemberBody = new ZodValidationPipe(createStaffMemberRequestSchema);
export const updateStaffMemberBody = new ZodValidationPipe(
  optionalBody(updateStaffMemberRequestSchema),
);

/** La fiche demandée, telle que le contrat la rend au contrôleur. */
export type CreateStaffMemberBody = CreateStaffMemberRequest;
export type UpdateStaffMemberBody = UpdateStaffMemberRequest;

/** Filtre de la liste — le seul paramètre que la route accepte. */
export class ListStaffQueryDto {
  @ApiPropertyOptional({
    description:
      'Ne rendre que les praticiens actifs. Par défaut, toutes les fiches de l’établissement.',
  })
  @OptionalPresent()
  @BooleanQuery()
  @IsBoolean()
  public activeOnly?: boolean;
}

/**
 * Créer une fiche praticien — la documentation de
 * `createStaffMemberRequestSchema` (#694).
 *
 * `userId` est l'identifiant du **compte**, celui que `GET /v1/users` liste, et
 * c'est le seul champ par lequel une fiche se rattache à une personne. Le lien
 * est unique dans les deux sens — `@@unique([tenant_id, user_id])` — parce que
 * deux fiches pour un même compte se disputeraient son agenda.
 *
 * Ni `isActive`, ni `serviceIds` : une fiche naît réservable, et l'affectation
 * « ce praticien pratique cette prestation » a sa propre route. Le `.strict()`
 * du contrat les refuse en 400 plutôt que de les ignorer en silence.
 */
export class CreateStaffMemberDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Compte du personnel auquel rattacher la fiche — l’identifiant que rend GET /v1/users, ' +
      'jamais celui d’une fiche. Le compte doit être un compte interne de l’établissement.',
  })
  public userId!: string;

  @ApiProperty({
    example: 'Camille Rousseau',
    description:
      'Nom de vitrine, celui que la cliente lit dans le tunnel de réservation. Il n’a pas à ' +
      'reprendre l’état civil du compte.',
  })
  public displayName!: string;

  @ApiPropertyOptional({
    description: 'Présentation affichée par la page publique du salon.',
  })
  public bio?: string;
}

/**
 * Modifier une fiche praticien — la documentation de
 * `updateStaffMemberRequestSchema` (#694).
 *
 * Tous les champs sont facultatifs et un corps vide est un no-op qui réussit,
 * comme sur les prestations : un écran qui n'a rien changé n'a pas à savoir
 * s'abstenir d'enregistrer.
 *
 * `isActive` est **la** façon de retirer un praticien du planning — il n'y a pas
 * de suppression, les rendez-vous passés le citent. `bio` accepte `null`, qui
 * efface la présentation ; `displayName` ne l'accepte pas, un nom se remplace,
 * il ne s'efface pas.
 */
export class UpdateStaffMemberDto {
  @ApiPropertyOptional({ example: 'Camille Rousseau' })
  public displayName?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Présentation publique. `null` l’efface.',
  })
  public bio?: string | null;

  @ApiPropertyOptional({
    description:
      'Désactiver retire le praticien des créneaux proposés sans rien effacer de son histoire.',
  })
  public isActive?: boolean;
}

/**
 * Une fiche praticien telle qu'elle sort de l'API de back-office.
 *
 * **Sans `tenantId`** — information interne (tenant-isolation §4) — et sans
 * `userId`, qui révélerait le compte derrière la fiche. Sans `bio` non plus :
 * une liste de choix n'a pas à transporter deux mille caractères par ligne, et
 * `staffMemberSchema` de `@spa/shared` la déclare facultative pour cette raison
 * même. Le `select` du repository ne les lit pas.
 *
 * `id` est l'identifiant de la **fiche**, celui qu'attend
 * `POST /services/{serviceId}/staff`. C'est tout l'objet de la route : le
 * confondre avec l'identifiant du compte est ce qui rendait la première
 * affectation impossible.
 */
export class StaffMemberDto implements StaffMemberView {
  @ApiProperty({
    format: 'uuid',
    description:
      'Identifiant de la fiche praticien — celui qu’attend POST /services/{serviceId}/staff.',
  })
  public id!: string;

  @ApiProperty({ example: 'Camille Rousseau' })
  public displayName!: string;

  @ApiProperty({
    description:
      'Un praticien désactivé reste une fiche de l’établissement : c’est à l’écran ' +
      'de décider s’il le propose, pas à l’API de le lui cacher.',
  })
  public isActive!: boolean;
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * Le schéma de référence est `serviceStaffMemberSchema` et non
 * `staffMemberSchema`, et ce n'est pas un raccourci : le contrat décrit la fiche
 * complète avec sa `bio`, que cette route ne sert pas — une liste de choix n'a
 * pas à transporter deux mille caractères par ligne. `serviceStaffMemberSchema`
 * est exactement le résumé plus `isActive`, c'est-à-dire la forme servie ici, et
 * `catalog.types.ts` fait déjà de `ServiceStaffMemberView` un alias de
 * `StaffMemberView` pour la même raison.
 *
 * Les assertions coûtent zéro à l'exécution et échouent au `tsc` : un champ
 * ajouté d'un côté et pas de l'autre — une `bio` qui reviendrait par
 * inadvertance dans le `select` du repository — casse la compilation.
 */
type StaffMemberWire = z.input<typeof serviceStaffMemberSchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _StaffMemberDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof StaffMemberDto, keyof StaffMemberWire>
  | Exclude<keyof StaffMemberWire, keyof StaffMemberDto>
>;

type _StaffMemberDtoIsReadableByTheContract = AssertTrue<
  StaffMemberDto extends StaffMemberWire ? true : false
>;

/**
 * Les **entrées**, tenues dans le seul sens qui compte pour elles : la classe
 * qui documente `/api/docs` doit annoncer exactement les champs que le pipe
 * accepte.
 *
 * Sans ces gardes, la validation n'aurait plus qu'une écriture mais la
 * documentation en garderait une seconde, et une `@ApiProperty` oubliée
 * décrirait une route qui refuse ce qu'elle annonce — ou, pire, qui accepte ce
 * qu'elle tait.
 */
type _CreateStaffMemberDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CreateStaffMemberDto, keyof z.input<typeof createStaffMemberRequestSchema>>
  | Exclude<keyof z.input<typeof createStaffMemberRequestSchema>, keyof CreateStaffMemberDto>
>;

type _UpdateStaffMemberDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof UpdateStaffMemberDto, keyof z.input<typeof updateStaffMemberRequestSchema>>
  | Exclude<keyof z.input<typeof updateStaffMemberRequestSchema>, keyof UpdateStaffMemberDto>
>;
