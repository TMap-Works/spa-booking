import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

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
 * TODO(#510) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/catalog.ts` (`staffMemberSchema`) ; elles devront
 * en être importées.
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
