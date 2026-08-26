import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { USER_ROLES, type UserRole } from '../roles';

/**
 * DTO d'administration des comptes.
 *
 * L'énumération annoncée est `USER_ROLES` — les quatre rôles, `MANAGER`
 * compris. Elle a un temps été restreinte aux seuls rôles que `enum UserRole`
 * savait écrire : la garde de #201 nommait `MANAGER` que la colonne ignorait
 * encore, et le refuser ici donnait un 400 qui nomme les valeurs acceptées
 * plutôt qu'une erreur Prisma remontée en 500 « erreur interne ». La migration
 * `20260826100000_add_manager_user_role` a rendu la valeur stockable (#202) : la
 * restriction n'a plus d'objet, et la maintenir refuserait un rôle que la base
 * accepte.
 *
 * Le `@IsIn` reste, lui, indispensable — c'est ce qui borne l'entrée à
 * l'énumération plutôt que de laisser une chaîne arbitraire descendre jusqu'au
 * pilote PostgreSQL.
 */
export class ChangeUserRoleDto {
  @ApiProperty({
    enum: USER_ROLES,
    description: 'Rôle à attribuer au compte visé.',
  })
  @IsIn(USER_ROLES as readonly string[], {
    message: `role : valeurs acceptées — ${USER_ROLES.join(', ')}`,
  })
  public role!: UserRole;
}
