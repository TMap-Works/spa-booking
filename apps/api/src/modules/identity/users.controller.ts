import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { Auth, AuthAtLeast } from './auth.decorator';
import { UserProfileDto } from './dto/auth.dto';
import {
  ChangeUserRoleDto,
  InviteStaffMemberDto,
  SetAccountStatusDto,
  StaffAccountStateDto,
  StaffInvitationDto,
  UpdateContactDetailsDto,
  toProfileChanges,
} from './dto/users.dto';
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
 * | `POST /users` | admin | invite un membre du personnel — sans jamais choisir son mot de passe |
 * | `POST /users/:id/invitation` | admin | réémet l'invitation d'un compte jamais activé |
 * | `PATCH /users/:id` | manager et au-dessus | modifie des coordonnées, jamais des droits |
 * | `PATCH /users/:id/status` | admin | désactive **sans supprimer** — pas de `DELETE` sur cette ressource |
 *
 * Les trois premières viennent de #22 et servent l'administration des droits ; la
 * quatrième vient de #47 et sert l'espace client ; les quatre dernières viennent
 * de #55 et complètent le CRUD du personnel. Elles cohabitent parce
 * qu'elles portent sur la même ressource — un compte — et que le seuil de rôle
 * est déclaré **par route**, jamais par contrôleur : c'est ce qui permet à un
 * `CLIENT` d'entrer par `PATCH /users/me` sans rien ouvrir des sept autres.
 *
 * ## Trois seuils, et non un seul par contrôleur
 *
 * `STAFF` lit, `MANAGER` corrige des coordonnées, `ADMIN` distribue et retire des
 * droits. La ligne de partage est là : tout ce qui change ce qu'un compte *peut
 * faire* — le rôle, l'existence même du compte, son activation — exige `ADMIN`.
 * Un `MANAGER` capable d'inviter un administrateur ou d'en désactiver un se
 * promouvrait par personne interposée.
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
    @Body() body: UpdateContactDetailsDto,
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

  /**
   * Invite un membre du personnel — premier critère de #55.
   *
   * Réservé aux **administrateurs** : ce point d'entrée crée un compte doté d'un
   * rôle, donc de droits. Un `MANAGER` capable d'inviter un `ADMIN` se
   * promouvrait par personne interposée, et le rang cesserait de vouloir dire
   * quelque chose.
   *
   * **201** : une ressource est créée, et le corps porte l'invitation — le
   * compte, le jeton, sa durée. **409** si l'adresse est déjà prise dans cet
   * établissement, y compris par une cliente : la faire passer au personnel est
   * un changement de rôle, pas une création.
   *
   * L'établissement vient de `@CurrentUser()`, donc d'un jeton vérifié : c'est
   * lui que porte l'invitation signée, et il n'y a aucun `tenantId` à accepter
   * d'où que ce soit (tenant-isolation §2).
   */
  @Post()
  @Auth('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Inviter un membre du personnel' })
  @ApiCreatedResponse({ type: StaffInvitationDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiConflictResponse({ description: 'Cette adresse est déjà utilisée dans cet établissement.' })
  public async invite(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: InviteStaffMemberDto,
  ): Promise<StaffInvitationDto> {
    return this.users.inviteStaffMember({
      tenantId: actor.tenantId,
      email: body.email,
      role: body.role,
      firstName: body.firstName,
      lastName: body.lastName,
      // Le DTO distingue « absent » de « vide » ; le service ne connaît que
      // « un numéro » ou « pas de numéro ».
      phone: body.phone ?? null,
    });
  }

  /**
   * Réémet l'invitation d'un compte jamais activé — troisième critère de #55.
   *
   * Sans elle, une invitation expirée condamnerait le compte : il n'a pas de mot
   * de passe, et le périmètre MVP ne prévoit aucune réinitialisation.
   *
   * **201** comme la précédente : ce qui est créé est une invitation, pas le
   * compte. **409** si le compte a déjà été activé — l'appelant est un
   * administrateur de l'établissement, il a le droit de le savoir. **422** s'il
   * est désactivé : le lien ne pourrait qu'échouer, et il échouerait chez la
   * personne invitée plutôt qu'ici. **404** pour un identifiant inconnu, une
   * fiche cliente, ou un compte d'un autre établissement, indistinctement
   * (tenant-isolation §4).
   */
  @Post(':id/invitation')
  @Auth('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Réémettre l’invitation d’un compte jamais activé' })
  @ApiCreatedResponse({ type: StaffInvitationDto })
  @ApiConflictResponse({ description: 'Ce compte a déjà été activé.' })
  @ApiUnprocessableEntityResponse({
    description: 'Ce compte est désactivé : le réactiver avant de réémettre son invitation.',
  })
  @ApiNotFoundResponse({ description: 'Aucun compte de cet établissement ne porte cet identifiant.' })
  public async reissueInvitation(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StaffInvitationDto> {
    return this.users.reissueInvitation({ tenantId: actor.tenantId, userId: id });
  }

  /**
   * Modifie les coordonnées d'un membre du personnel — le « U » du CRUD réclamé
   * par #55.
   *
   * `@AuthAtLeast('MANAGER')` : corriger une faute de frappe dans le nom ou le
   * numéro d'une collègue est une tâche de front-desk (CDC §3, « le front-desk
   * gère l'agenda, le staff et les fiches clients »), et aucun droit ne se
   * distribue par ce chemin — le corps ne porte ni rôle, ni activation, ni
   * adresse, et `forbidNonWhitelisted` refuse en 400 celui qui les y glisserait.
   *
   * Le seuil reste au-dessus de `STAFF` : la lecture du trombinoscope est une
   * chose, la modification du compte d'autrui en est une autre.
   */
  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Modifier les coordonnées d’un membre du personnel' })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucun compte de cet établissement ne porte cet identifiant.' })
  public async updateStaffMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateContactDetailsDto,
  ): Promise<UserProfileDto> {
    return this.users.updateStaffContactDetails({
      userId: id,
      changes: toProfileChanges(body),
    });
  }

  /**
   * Désactive — ou réactive — un compte du personnel : quatrième critère de #55.
   *
   * Réservé aux **administrateurs**, comme l'attribution de rôle : fermer l'accès
   * de quelqu'un est une décision sur ses droits, et un `MANAGER` capable de
   * désactiver un `ADMIN` renverserait la hiérarchie d'un appel.
   *
   * **Ce n'est pas une suppression, et il n'y a pas de `DELETE` sur cette
   * ressource** : le compte, ses affectations et ses rendez-vous passés restent
   * intacts — c'est l'énoncé du critère, et les clés étrangères en `Restrict` du
   * schéma l'imposeraient de toute façon. Un verbe `DELETE` qui n'efface rien
   * mentirait au client autant qu'au relecteur.
   *
   * **422** si l'appelant se vise lui-même : le dernier administrateur d'un salon
   * qui se désactive ferme la porte de l'intérieur.
   */
  @Patch(':id/status')
  @Auth('ADMIN')
  @ApiOperation({ summary: 'Désactiver ou réactiver un compte du personnel' })
  @ApiOkResponse({ type: StaffAccountStateDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiUnprocessableEntityResponse({
    description: 'Un compte ne peut pas modifier sa propre activation.',
  })
  @ApiNotFoundResponse({ description: 'Aucun compte de cet établissement ne porte cet identifiant.' })
  public async setStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetAccountStatusDto,
  ): Promise<StaffAccountStateDto> {
    return this.users.setStaffAccountActive({ actor, userId: id, isActive: body.isActive });
  }
}
