import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { PERSISTABLE_USER_ROLES, type PersistableUserRole } from '../roles';

/**
 * DTO d'administration des comptes.
 *
 * L'énumération annoncée est `PERSISTABLE_USER_ROLES` et non `USER_ROLES` : la
 * garde de permissions sait nommer `MANAGER`, la colonne PostgreSQL ne sait pas
 * encore l'écrire (voir `roles.ts`). Le refuser **ici**, à la validation, donne
 * un 400 `VALIDATION_ERROR` qui nomme les valeurs acceptées ; le laisser passer
 * donnerait une erreur Prisma remontée en 500 « erreur interne », qui n'apprend
 * rien à personne.
 *
 * Le jour où la migration `ALTER TYPE "UserRole" ADD VALUE 'MANAGER'` passera,
 * cette liste s'allongera d'elle-même — elle est dérivée, pas recopiée.
 */
export class ChangeUserRoleDto {
  @ApiProperty({
    enum: PERSISTABLE_USER_ROLES,
    description:
      'Rôle à attribuer. `MANAGER` est reconnu par la couche d’autorisation mais ' +
      'pas encore stockable : il demande une migration additive de `enum UserRole`.',
  })
  @IsIn(PERSISTABLE_USER_ROLES as readonly string[], {
    message: `role : valeurs acceptées — ${PERSISTABLE_USER_ROLES.join(', ')}`,
  })
  public role!: PersistableUserRole;
}
