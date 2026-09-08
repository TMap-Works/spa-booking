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
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import { CustomerExportService } from './customer-export.service';
import { CustomerHistoryService } from './customer-history.service';
import { CustomersService } from './customers.service';
import { CustomerDataExportDto, toCustomerDataExportDto } from './dto/customer-export.dto';
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
  type SetCustomerStatusBody,
  SetCustomerStatusDto,
  UpdateCustomerDto,
  setCustomerStatusBody,
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
 * | `GET /customers/:id/export` | manager et au-dessus | le dossier complet, à remettre |
 * | `POST /customers` | staff et au-dessus | la saisie au comptoir |
 * | `POST /customers/:id/anonymize` | admin | le droit à l'oubli |
 * | `PATCH /customers/:id` | staff et au-dessus | coordonnées, note et consentement |
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
 * ## Les deux seuils que #81 ajoute
 *
 * `MANAGER` pour l'**export**. Il ne modifie rien, mais il produit en un seul
 * appel la totalité de ce que le salon détient sur une personne — notes internes
 * et textes libres compris. Le laisser à `STAFF` aurait mis à portée d'un clic,
 * sur chaque poste du comptoir, un dossier complet exportable ; le sortir du
 * périmètre du back-office aurait rendu le droit d'accès impraticable. La
 * minimisation du CDC §5.1 se joue autant sur qui peut lire que sur ce qui est
 * lu.
 *
 * `ADMIN` pour l'**anonymisation**. C'est la seule opération de tout le module
 * qui **détruise** irréversiblement une donnée : ni la désactivation, ni la
 * modification, ni rien d'autre ne perd quoi que ce soit. Il n'y a pas de
 * retour arrière — c'est le propos —, et une opération sans retour arrière
 * appartient au rang le plus élevé de l'établissement. Même seuil que
 * `PATCH /users/:id/role` chez `identity`, pour la même raison.
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
 * #81 n'en ajoute pas davantage : le droit à l'oubli passe par
 * `POST /customers/:id/anonymize`, parce que ce qui se produit n'est pas la
 * disparition d'une ressource — elle reste, et se relit — mais une
 * transformation irréversible de son contenu. Un `DELETE` qui rendrait ensuite
 * 200 sur la même URL aurait menti deux fois.
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
    private readonly dataExport: CustomerExportService,
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
   * Le dossier complet d'une fiche — ce qui se remet à une personne qui exerce
   * son droit d'accès et de portabilité (#81, CDC §5.1, RGPD art. 15 et 20).
   *
   * Un document JSON unique et daté, non paginé : ce qui se remet doit être
   * complet, et une pagination rendrait la complétude tributaire de l'appelant.
   * Il porte les textes libres que l'historique écarte — ce que la cliente a
   * écrit en réservant, ce que le salon a noté sur elle — parce que le droit
   * d'accès ne connaît pas d'exception pour ce qu'on aurait préféré garder.
   *
   * **404** dans les mêmes trois cas que la lecture d'une fiche. Sans la
   * relecture qui le produit, l'export d'un identifiant inconnu rendrait un
   * document bien formé et vide en 200 — un document qui a l'apparence d'une
   * réponse au titre de l'art. 15 sans en être une, et qui se remettrait sans
   * que personne ne s'aperçoive de l'erreur.
   */
  @Get(':id/export')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Exporter les données personnelles d’une cliente (RGPD)' })
  @ApiOkResponse({ type: CustomerDataExportDto })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async exportOf(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDataExportDto> {
    return toCustomerDataExportDto(await this.dataExport.byCustomerId(id));
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
        // `undefined` traverse **intact**, contrairement aux deux précédents :
        // « personne n'a posé la question » et « la réponse est non » ne sont
        // pas le même fait, et seul le second se date (#81).
        ...(body.marketingConsent === undefined
          ? {}
          : { marketingConsent: body.marketingConsent }),
      }),
    );
  }

  /**
   * Anonymise une fiche — le droit à l'oubli (#81, CDC §5.1).
   *
   * **`POST` et non `DELETE`** : la ressource ne disparaît pas. Elle reste
   * lisible à la même URL, vidée de ce qui identifie — nom et adresse remplacés
   * par un pseudonyme, téléphone, note interne et empreinte de mot de passe
   * effacés, et les textes libres de ses rendez-vous avec. Ce qui subsiste est
   * ce que la comptabilité exige : des montants, des dates, un identifiant
   * opaque. `appointments.client_id` référence `users` en `Restrict` — une
   * suppression était de toute façon impossible sans emporter les ventes
   * passées, ce que le critère d'acceptation interdit.
   *
   * **200 et non 202** : le geste est fait quand la réponse part, et le corps
   * porte la fiche telle qu'elle est désormais. C'est ce qui permet à l'écran de
   * montrer le résultat plutôt que de le promettre.
   *
   * **Idempotente** : une seconde demande rend la fiche déjà anonymisée telle
   * quelle, sans second pseudonyme ni date décalée.
   *
   * **422** si la fiche a encore des rendez-vous à venir : le RGPD n'impose pas
   * d'effacer tant que le traitement reste nécessaire à l'exécution du contrat
   * (art. 17.1.b), et un rendez-vous de jeudi est ce contrat. Le refus est
   * temporaire et actionnable — honorer, ou annuler.
   *
   * **404** dans les mêmes trois cas que la lecture d'une fiche.
   */
  @Post(':id/anonymize')
  @HttpCode(HttpStatus.OK)
  @AuthAtLeast('ADMIN')
  @ApiOperation({ summary: 'Anonymiser une fiche cliente (droit à l’oubli)' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  @ApiUnprocessableEntityResponse({
    description: 'La fiche a encore des rendez-vous à venir : les honorer ou les annuler d’abord.',
  })
  public async anonymize(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return toCustomerDto(await this.customers.anonymize(id));
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
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `SetCustomerStatusDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: SetCustomerStatusDto })
  @ApiOkResponse({ type: CustomerDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    // Le type est celui **du contrat**, jamais `SetCustomerStatusDto` : la
    // classe n'a plus de décorateur `class-validator`, et la typer ici ferait
    // rejouer le `ValidationPipe` global, dont le `whitelist` viderait le corps
    // de son unique champ — la fiche serait alors basculée sur un `isActive`
    // indéfini (ADR 0008).
    @Body(setCustomerStatusBody) body: SetCustomerStatusBody,
  ): Promise<CustomerDto> {
    return toCustomerDto(await this.customers.setActive(id, body.isActive));
  }
}
