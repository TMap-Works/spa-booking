import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import type { ServiceStaffMemberView } from '../catalog.types';

/**
 * DTO de l'affectation « ce praticien pratique cette prestation ».
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans le corps, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). Ni `serviceId` : il vient du chemin, et l'accepter en
 * plus dans le corps ouvrirait deux sources pour la même désignation.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/catalog.ts` (`assignServiceStaffRequestSchema`,
 * `serviceStaffMemberSchema`) ; elles devront en être importées.
 */

/**
 * Affecte **un** praticien, et un seul.
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
  @IsUUID('4')
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
