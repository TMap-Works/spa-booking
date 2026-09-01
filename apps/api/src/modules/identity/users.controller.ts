import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { Auth, AuthAtLeast } from './auth.decorator';
import { UserProfileDto } from './dto/auth.dto';
import { ChangeUserRoleDto, UpdateOwnProfileDto, toProfileChanges } from './dto/users.dto';
import type { AuthenticatedUser } from './identity.types';
import { CurrentUser } from './jwt-auth.guard';
import { UsersService } from './users.service';

/**
 * Les comptes de l'établissement — la surface qui exerce réellement la garde de
 * permissions.
 *
 * | Route | Rôles | Ce qu'elle démontre |
 * |---|---|---|
 * | `GET /users` | staff et au-dessus | un client authentifié est refusé (403) |
 * | `GET /users/:id` | staff et au-dessus | un compte d'un autre tenant est **404** |
 * | `PATCH /users/:id/role` | admin | le seuil de rôle est déclaratif, par route |
 * | `PATCH /users/me` | toute identité vérifiée | on modifie **son** compte, jamais celui d'un autre |
 *
 * Les trois premières viennent de #22 et servent l'administration des droits ; la
 * quatrième vient de #47 et sert l'espace client. Elles cohabitent parce
 * qu'elles portent sur la même ressource — un compte — et que le seuil de rôle
 * est déclaré **par route**, jamais par contrôleur : c'est ce qui permet à un
 * `CLIENT` d'entrer par `PATCH /users/me` sans rien ouvrir des trois autres.
 *
 * ## Pourquoi `/users/me` et non `/users/:id`
 *
 * Parce qu'un identifiant en chemin serait la première fuite à écrire : il
 * faudrait alors comparer quelque part l'identifiant reçu à celui du jeton, et il
 * suffirait d'un oubli pour qu'une cliente réécrive les coordonnées d'une autre.
 * `me` n'a rien à comparer — le compte visé **est** celui du jeton. C'est la
 * conduite que `GET /auth/me` a posée, et pour la même raison.
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
   * Modifie ses **propres** coordonnées — le quatrième critère de #47.
   *
   * Déclarée avant les routes à segment dynamique : un chemin littéral se
   * déclare toujours avant le motif qui pourrait l'absorber. Aucune des deux
   * autres ne le ferait ici — `:id/role` porte deux segments —, mais l'ordre
   * inverse serait un piège posé pour la prochaine route qu'on ajoutera.
   *
   * `@Auth()` sans argument : **toute identité vérifiée**, `CLIENT` compris. Un
   * seuil de rôle priverait la clientèle de la seule route par laquelle elle
   * corrige son nom ou son numéro, ce qui est exactement l'objet du ticket. Ce
   * n'est pas un privilège : c'est son propre compte, et il n'y a pas d'autre
   * compte à atteindre depuis ici.
   *
   * **200**, et le corps rend le profil mis à jour — le front réaffiche sans
   * relire.
   *
   * **400** sur un champ invalide, ou sur un champ non déclaré : le
   * `ValidationPipe` global est en `forbidNonWhitelisted`, si bien qu'un `role`
   * ou un `email` glissé dans le corps est refusé en nommant le champ, jamais
   * ignoré en silence.
   *
   * **404** quand le jeton désigne un compte que l'établissement courant ne
   * connaît pas — compte supprimé, ou jeton signé sur le tenant voisin. Jamais
   * 403 : le distinguer confirmerait que le compte existe ailleurs
   * (tenant-isolation §4).
   */
  @Patch('me')
  @Auth()
  @ApiOperation({ summary: 'Modifier ses propres coordonnées' })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Le compte du jeton n’existe pas dans cet établissement.' })
  public async updateOwnProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateOwnProfileDto,
  ): Promise<UserProfileDto> {
    return this.users.updateOwnContactDetails({
      // Du jeton vérifié, jamais du chemin ni du corps (tenant-isolation §2).
      userId: user.userId,
      // Les champs **présents**, et eux seuls : un `undefined` recopié effacerait
      // une valeur que l'appelant n'a pas voulu toucher.
      changes: toProfileChanges(body),
    });
  }

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
