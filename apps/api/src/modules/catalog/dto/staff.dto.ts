import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { serviceStaffMemberSchema } from '@spa/shared';
import { IsBoolean } from 'class-validator';
import type { z } from 'zod';

import type { StaffMemberView } from '../catalog.types';
import { BooleanQuery, OptionalPresent } from './validation';

/**
 * DTO de l'annuaire des fiches praticien (#421).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un paramètre non déclaré ici ne passe pas — en particulier un `tenantId`
 * glissé dans la chaîne de requête, qui serait le paramètre par lequel un
 * appelant choisirait son établissement (tenant-isolation §2). Il n'y en a pas,
 * et il ne doit pas y en avoir : l'établissement vient du jeton vérifié.
 *
 * La **sortie** est tenue par le contrat depuis #510 — voir les assertions de
 * compilation en fin de fichier.
 *
 * TODO(#536) : le filtre, lui, reste sous `class-validator`. C'est le cas commun
 * des DTO de chaîne de requête du dépôt : `activeOnly` arrive en `"true"` ou
 * `"false"`, et aucun schéma du contrat ne décrit ce filtre ni ne coerce — voir
 * le même TODO dans `service.dto.ts`, qui porte les deux filtres du catalogue.
 */

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
