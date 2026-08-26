import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Auth, AuthAtLeast } from './auth.decorator';
import { UserProfileDto } from './dto/auth.dto';
import { ChangeUserRoleDto } from './dto/users.dto';
import type { AuthenticatedUser } from './identity.types';
import { CurrentUser } from './jwt-auth.guard';
import { UsersService } from './users.service';

/**
 * Administration des comptes de l'établissement — la surface qui exerce
 * réellement la garde de permissions.
 *
 * Trois endpoints, trois niveaux de droits, et rien qui ne serve les critères de
 * #22 :
 *
 * | Route | Rôles | Ce qu'elle démontre |
 * |---|---|---|
 * | `GET /users` | staff et au-dessus | un client authentifié est refusé (403) |
 * | `GET /users/:id` | staff et au-dessus | un compte d'un autre tenant est **404** |
 * | `PATCH /users/:id/role` | admin | le seuil de rôle est déclaratif, par route |
 *
 * ## Pourquoi aucun `:tenantId` nulle part
 *
 * L'établissement vient du jeton vérifié, jamais du chemin (tenant-isolation
 * §2). Une route `/tenants/:tenantId/users/:id` laisserait le client désigner
 * l'établissement qu'il veut lire, et il ne resterait qu'à espérer qu'une
 * comparaison quelque part le rattrape. Ici il n'y a rien à comparer : le client
 * Prisma est déjà borné.
 *
 * ## Pourquoi `ParseUUIDPipe`
 *
 * Un identifiant mal formé est rejeté en 400 avant d'atteindre la base. Cela ne
 * révèle rien — la forme d'un UUID est publique — et évite qu'une chaîne
 * arbitraire descende jusqu'au pilote PostgreSQL, qui la refuserait par une
 * erreur de type remontée en 500.
 */
@ApiTags('users')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  public constructor(private readonly users: UsersService) {}

  /**
   * Les comptes **internes** de l'établissement : staff, manager, administrateurs.
   *
   * La clientèle n'y figure pas — elle relève du module `crm` et de sa
   * pagination. Cette liste répond à une question d'administration des droits,
   * et sa taille est bornée par le nombre de personnes qui travaillent au salon.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les comptes internes de l’établissement' })
  @ApiOkResponse({ type: [UserProfileDto] })
  public async list(): Promise<UserProfileDto[]> {
    return this.users.listStaffAccounts();
  }

  /**
   * Un compte de l'établissement, par identifiant.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'un compte d'un
   * autre établissement : distinguer les deux reviendrait à confirmer l'existence
   * du second (tenant-isolation §4).
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire un compte de l’établissement' })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiNotFoundResponse({ description: 'Aucun compte de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<UserProfileDto> {
    return this.users.byId(id);
  }

  /**
   * Attribue un rôle à un compte.
   *
   * Réservé aux administrateurs : c'est l'opération qui distribue les droits, et
   * un `MANAGER` capable de se promouvoir `ADMIN` rendrait le rang décoratif.
   *
   * L'appelant vient de `@CurrentUser()`, donc d'un jeton vérifié — le service
   * s'en sert pour interdire qu'un compte modifie son propre rôle.
   */
  @Patch(':id/role')
  @Auth('ADMIN')
  @ApiOperation({ summary: 'Attribuer un rôle à un compte de l’établissement' })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiNotFoundResponse({ description: 'Aucun compte de cet établissement ne porte cet identifiant.' })
  public async changeRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ChangeUserRoleDto,
  ): Promise<UserProfileDto> {
    return this.users.changeRole({ actor, userId: id, role: body.role });
  }
}
