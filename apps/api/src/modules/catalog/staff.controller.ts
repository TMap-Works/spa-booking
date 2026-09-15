import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  CreateStaffMemberDto,
  ListStaffQueryDto,
  StaffMemberDto,
  UpdateStaffMemberDto,
  createStaffMemberBody,
  updateStaffMemberBody,
  type CreateStaffMemberBody,
  type UpdateStaffMemberBody,
} from './dto/staff.dto';
import { StaffService } from './staff.service';

/**
 * Les fiches praticien de l'établissement — annuaire (#421), cycle de vie
 * (#694).
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /staff` | staff et au-dessus |
 * | `POST /staff` | manager et au-dessus |
 * | `PATCH /staff/:id` | manager et au-dessus |
 *
 * ## Ce que ces routes réparent
 *
 * `POST /services/:serviceId/staff` attend l'identifiant d'une **fiche**
 * praticien, et aucune lecture n'en rendait la liste : `GET /services/:id/staff`
 * ne montre que les praticiens **déjà affectés**, le catalogue public pas
 * davantage, et `GET /v1/users` rend des **comptes** dont l'identifiant n'est
 * pas celui d'une fiche. #421 a livré cette lecture.
 *
 * Il y manquait de quoi la remplir. Jusqu'à #694, **aucune des routes de l'API
 * n'écrivait la table `staff`** : ni la création d'un compte au rôle
 * praticien·ne, ni l'acceptation de son invitation, ni son activation. Seul le
 * jeu d'essai Prisma en posait, si bien qu'un établissement jamais semé restait
 * inexploitable de bout en bout — « Praticiens — 0 » au back-office, « Ajouter
 * un praticien » désactivé sur chaque prestation, « Aucun créneau sur les 14
 * prochains jours » dans le tunnel public.
 *
 * ## Lire au rang `STAFF`, écrire au rang `MANAGER`
 *
 * La lecture garde le seuil du reste du module : savoir qui travaille dans
 * l'établissement n'est pas une information de gestion — c'est ce qu'un
 * praticien lit sur le planning affiché en cabine —, et la fiche ne porte ni le
 * compte, ni le contact, ni la rémunération.
 *
 * L'écriture, elle, est au rang qui tient déjà le catalogue et les semaines de
 * travail (`POST /services`, `PUT /staff/:id/schedule`) : composer l'équipe
 * réservable est une décision d'exploitation. Elle n'est **pas** au rang `ADMIN`
 * des comptes, et la ligne de partage est celle qu'`identity` a posée — tout ce
 * qui change ce qu'un compte *peut faire* exige `ADMIN`. Créer une fiche ne
 * donne aucun droit : elle ne se connecte pas, elle porte un agenda.
 *
 * ## Une ressource à plat, et non une sous-ressource
 *
 * `/staff` plutôt que `/services/:serviceId/staff` — qui existe déjà et répond à
 * une autre question. Celle-ci est « quelles fiches ce salon a-t-il », sans
 * prestation pour contexte : c'est précisément l'absence de contexte
 * d'affectation qui la rend utile à l'amorçage. Pas davantage
 * `/users/:id/staff` : la fiche survit à son compte, et la ranger sous lui
 * ferait de sa désactivation la disparition d'un agenda que les rendez-vous
 * passés citent encore.
 *
 * ## Pas de `DELETE`
 *
 * Une fiche se désactive (`PATCH`, `isActive: false`). Les rendez-vous passés la
 * citent par `staff_id`, et le reporting doit continuer à savoir qui a tenu la
 * cabine. Même arbitrage que sur les prestations et sur les comptes.
 *
 * ## Pourquoi aucun `:tenantId` nulle part
 *
 * L'établissement vient du jeton vérifié, jamais du chemin ni de la chaîne de
 * requête (tenant-isolation §2). Il n'y a rien à comparer ici : le client Prisma
 * est déjà borné quand la requête l'atteint, et les corps sont jugés par le
 * `.strict()` du contrat partagé, qui rejette un `tenantId` en 400 plutôt que de
 * l'ignorer.
 */
@ApiTags('catalog')
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  public constructor(private readonly staff: StaffService) {}

  /**
   * Les fiches praticien de l'établissement, **désactivées comprises**.
   *
   * L'identifiant rendu est celui de la fiche : il part tel quel dans le corps
   * de `POST /services/{serviceId}/staff`.
   *
   * Pas de 404 possible : une liste vide est la réponse juste pour un salon qui
   * n'a encore aucune fiche, et c'est un état d'amorçage, pas une erreur.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les fiches praticien de l’établissement' })
  @ApiOkResponse({ type: [StaffMemberDto] })
  public async list(@Query() query: ListStaffQueryDto): Promise<StaffMemberDto[]> {
    return this.staff.list(query.activeOnly ?? false);
  }

  /**
   * Crée la fiche praticien d'un compte du personnel — **201**.
   *
   * **404** quand `userId` ne désigne aucun compte interne d'ici : inconnu,
   * d'un autre établissement, ou fiche cliente. Les trois se confondent
   * délibérément — les distinguer ferait de cette route un oracle sur l'annuaire
   * du voisin (tenant-isolation §4).
   *
   * **409** quand ce compte a déjà sa fiche. C'est la base qui tranche, sur
   * `@@unique([tenant_id, user_id])`, et non un contrôle préalable que deux
   * soumissions concurrentes passeraient toutes les deux.
   *
   * **400** sur un corps invalide, ou sur un champ non déclaré : le contrat est
   * `.strict()`, si bien qu'un `isActive` posté à la création est refusé en
   * nommant le champ.
   */
  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Créer la fiche praticien d’un compte du personnel' })
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `CreateStaffMemberDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: CreateStaffMemberDto })
  @ApiCreatedResponse({ type: StaffMemberDto })
  @ApiNotFoundResponse({ description: 'Aucun compte du personnel d’ici ne porte cet identifiant.' })
  @ApiConflictResponse({ description: 'Ce compte a déjà une fiche praticien.' })
  public async create(
    // Le type est celui **du contrat**, jamais `CreateStaffMemberDto` : la
    // classe n'a plus de décorateur `class-validator`, et la typer ici ferait
    // rejouer le `ValidationPipe` global, dont le `whitelist` viderait le corps
    // de tous ses champs (ADR 0008).
    @Body(createStaffMemberBody) body: CreateStaffMemberBody,
  ): Promise<StaffMemberDto> {
    return this.staff.create(body);
  }

  /**
   * Modifie une fiche — nom de vitrine, présentation, activation.
   *
   * `PATCH` et non `PUT` : l'écran envoie le champ qu'il vient de changer, et un
   * `PUT` l'obligerait à renvoyer la fiche entière, donc à écraser ce qu'un
   * collègue aurait modifié entre-temps.
   *
   * **404** pour une fiche inconnue ou celle du voisin, indistinctement.
   */
  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Modifier une fiche praticien, ou l’activer / la désactiver' })
  @ApiBody({ type: UpdateStaffMemberDto })
  @ApiOkResponse({ type: StaffMemberDto })
  @ApiNotFoundResponse({
    description: 'Aucune fiche praticien de cet établissement ne porte cet identifiant.',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(updateStaffMemberBody) body: UpdateStaffMemberBody,
  ): Promise<StaffMemberDto> {
    return this.staff.update(id, body);
  }
}
