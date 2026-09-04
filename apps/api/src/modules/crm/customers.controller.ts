import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { CustomerHistoryService } from './customer-history.service';
import { CustomersService } from './customers.service';
import {
  CustomerHistoryQueryDto,
  CustomerVisitHistoryDto,
  toHistoryDto,
} from './dto/customer-history.dto';
import {
  CreateCustomerDto,
  CustomerDto,
  CustomerPageDto,
  HISTORY_MAX_VISITS,
  ListCustomersQueryDto,
  SetCustomerStatusDto,
  UpdateCustomerDto,
  toCustomerDto,
  toCustomerPatch,
  toSearchQuery,
} from './dto/customer.dto';

/**
 * Le fichier client de l'établissement — CDC §1.4, « le front-desk gère
 * l'agenda, le staff et les fiches clients ».
 *
 * | Route | Rôles | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /customers` | staff et au-dessus | le fichier, recherché et paginé |
 * | `GET /customers/:id` | staff et au-dessus | la fiche, note interne comprise |
 * | `GET /customers/:id/history` | staff et au-dessus | l'historique agrégé |
 * | `POST /customers` | staff et au-dessus | la saisie au comptoir |
 * | `PATCH /customers/:id` | staff et au-dessus | coordonnées et note |
 * | `PATCH /customers/:id/status` | manager et au-dessus | désactive **sans supprimer** |
 *
 * ## Deux seuils, et pourquoi la ligne passe là
 *
 * `STAFF` fait tout ce qui relève de la relation client au quotidien : chercher
 * une fiche, la créer au téléphone, corriger un numéro, noter une allergie.
 * Placer ce seuil à `MANAGER` aurait rendu le fichier inutilisable par les
 * personnes qui le tiennent — celles qui décrochent — et le CDC range
 * explicitement les fiches clients dans les gestes de front-desk.
 *
 * `MANAGER` garde la seule opération qui **retire** quelque chose des écrans :
 * la désactivation. Ce n'est pas une suppression, mais c'est une décision sur le
 * fichier plutôt qu'une correction dedans, et elle mérite le rang au-dessus —
 * même partage que `PATCH /users/:id` (coordonnées, `MANAGER`) et
 * `PATCH /users/:id/status` (activation, `ADMIN`) chez `identity`.
 *
 * **Aucune route n'est ouverte au rôle `CLIENT`.** Une cliente lit et corrige
 * son propre profil par `PATCH /users/me` et `GET /auth/me` — des routes sans
 * identifiant en chemin, donc sans rien à comparer. Ouvrir ici la moindre route
 * à `CLIENT` reviendrait à laisser une cliente désigner la fiche d'une autre par
 * son identifiant, et il ne resterait qu'à espérer qu'une comparaison quelque
 * part la rattrape.
 *
 * ## Ni `DELETE`, ni `:tenantId`
 *
 * Pas de `DELETE` : `appointments.client_id` référence `users` en `Restrict`, si
 * bien qu'une fiche ayant honoré une seule visite ne se supprime pas, et le
 * reporting doit continuer à la compter. Un verbe qui n'efface rien mentirait.
 *
 * Pas de `:tenantId` : l'établissement vient du jeton vérifié, jamais du chemin
 * (tenant-isolation §2). Une route `/tenants/:tenantId/customers/:id` laisserait
 * l'appelant désigner l'établissement qu'il veut lire ; ici il n'y a rien à
 * comparer, le client Prisma est déjà borné.
 *
 * ## Pourquoi `ParseUUIDPipe`
 *
 * Un identifiant mal formé est rejeté en 400 avant d'atteindre la base. Cela ne
 * révèle rien — la forme d'un UUID est publique — et évite qu'une chaîne
 * arbitraire descende jusqu'au pilote PostgreSQL, qui la refuserait par une
 * erreur de type remontée en 500.
 */
@ApiTags('crm')
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  public constructor(
    private readonly customers: CustomersService,
    private readonly history: CustomerHistoryService,
  ) {}

  /**
   * Le fichier client, recherché et paginé.
   *
   * `q` interroge nom, prénom, e-mail et téléphone **par préfixe** — voir
   * `CrmRepository.search` pour l'index que chaque axe utilise. Sans `q`, la
   * route rend le fichier entier, page par page.
   *
   * La liste ne porte **aucune note interne** : le dépôt ne la lit même pas sur
   * ce chemin.
   */
  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Rechercher dans le fichier client' })
  @ApiOkResponse({ type: CustomerPageDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  public async list(@Query() query: ListCustomersQueryDto): Promise<CustomerPageDto> {
    return this.customers.search(toSearchQuery(query));
  }

  /**
   * Une fiche cliente, par identifiant — note interne comprise.
   *
   * Répond **404** pour un identifiant inconnu, pour celui d'une fiche d'un
   * autre établissement, et pour celui d'un compte du personnel,
   * indistinctement : distinguer le deuxième cas confirmerait l'existence de la
   * fiche voisine (tenant-isolation §4), et distinguer le troisième dirait qui
   * travaille au salon.
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire une fiche cliente' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return toCustomerDto(await this.customers.byId(id));
  }

  /**
   * L'historique de visites **agrégé** d'une fiche.
   *
   * `summary` compte, borne et somme sur la totalité des rendez-vous ; `visits`
   * n'en montre que les `limit` plus récents, plafonné à
   * {@link HISTORY_MAX_VISITS}. Un agrégat calculé sur la fenêtre serait faux
   * dès que la fiche la dépasse, et il le serait en silence.
   *
   * **404** dans les mêmes trois cas que la lecture d'une fiche. Sans cette
   * relecture préalable, l'historique d'un identifiant inconnu rendrait un
   * agrégat vide en 200, indiscernable de celui d'une cliente jamais venue.
   */
  @Get(':id/history')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire l’historique de visites agrégé d’une fiche' })
  @ApiOkResponse({ type: CustomerVisitHistoryDto })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async historyOf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CustomerHistoryQueryDto,
  ): Promise<CustomerVisitHistoryDto> {
    return toHistoryDto(await this.history.byCustomerId(id, query.limit ?? HISTORY_MAX_VISITS));
  }

  /**
   * Crée une fiche cliente au comptoir.
   *
   * **201** : une ressource est créée. **409** si l'adresse est déjà prise dans
   * cet établissement — y compris par un membre du personnel : l'unicité porte
   * sur `(tenant_id, email)` sans regarder le rôle, et créer une seconde ligne
   * pour la même adresse rendrait la connexion ambiguë.
   *
   * L'établissement vient du jeton vérifié : il n'y a aucun `tenantId` à
   * accepter d'où que ce soit (tenant-isolation §2), et le `ValidationPipe`
   * global refuse en 400 celui qui l'y glisserait.
   */
  @Post()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Créer une fiche cliente' })
  @ApiCreatedResponse({ type: CustomerDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiConflictResponse({ description: 'Cette adresse est déjà utilisée dans cet établissement.' })
  public async create(@Body() body: CreateCustomerDto): Promise<CustomerDto> {
    return toCustomerDto(
      await this.customers.create({
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        // Le DTO distingue « absent » de « vide » ; le service ne connaît que
        // « un numéro » ou « pas de numéro ».
        phone: body.phone ?? null,
        internalNote: body.internalNote ?? null,
      }),
    );
  }

  /**
   * Modifie les coordonnées et la note interne d'une fiche.
   *
   * Ni l'adresse, ni l'activation, ni le rôle : le corps ne les porte pas, et
   * `forbidNonWhitelisted` refuse en 400 celui qui les y glisserait. Chacun a
   * son propre chemin — ou n'en a délibérément aucun, pour l'adresse.
   */
  @Patch(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Modifier une fiche cliente' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCustomerDto,
  ): Promise<CustomerDto> {
    return toCustomerDto(await this.customers.update(id, toCustomerPatch(body)));
  }

  /**
   * Désactive — ou réactive — une fiche cliente : le « D » du CRUD, sans
   * suppression.
   *
   * Réservé au rang `MANAGER` : retirer une fiche des écrans de saisie est une
   * décision sur le fichier, pas une correction dedans. Les rendez-vous passés,
   * l'historique et le reporting restent intacts — les clés étrangères en
   * `Restrict` l'imposeraient de toute façon.
   *
   * L'opération est idempotente, et sa réponse aussi : le corps porte l'état
   * **demandé**, y compris quand rien n'a été écrit parce que la fiche y était
   * déjà.
   */
  @Patch(':id/status')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Désactiver ou réactiver une fiche cliente' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetCustomerStatusDto,
  ): Promise<CustomerDto> {
    return toCustomerDto(await this.customers.setActive(id, body.isActive));
  }
}
