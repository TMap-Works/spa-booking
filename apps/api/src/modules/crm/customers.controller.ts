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

import { AuthAtLeast, AuthWith } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { ownScopeFor } from '../identity/permissions';
import { CustomerExportService } from './customer-export.service';
import { CustomerHistoryService } from './customer-history.service';
import { CustomersService } from './customers.service';
import {
  CustomerDataExportDto,
  CustomerDataExportQueryDto,
  toCustomerDataExportDto,
} from './dto/customer-export.dto';
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
 * | Route | Permission exigée | Ce qu'elle sert |
 * |---|---|---|
 * | `GET /customers` | `customers:read:own` **ou** `:all` | le fichier, recherché et paginé — **borné à sa propre clientèle** pour le premier |
 * | `GET /customers/:id` | `customers:read:own` **ou** `:all` | la fiche, note interne comprise |
 * | `GET /customers/:id/history` | `customers:read:all` | l'historique agrégé |
 * | `GET /customers/:id/export` | `customers:read:all` | le dossier complet, à remettre |
 * | `POST /customers` | `customers:write` | la saisie au comptoir |
 * | `POST /customers/:id/anonymize` | rang `ADMIN` | le droit à l'oubli |
 * | `PATCH /customers/:id` | `customers:write` | coordonnées, note et consentement |
 * | `PATCH /customers/:id/status` | `customers:write` | désactive **sans supprimer** |
 *
 * ## Ce que #812 a déplacé, et pourquoi le seuil `STAFF` a dû tomber
 *
 * Ces routes s'ouvraient au rang `STAFF`, au motif — juste — que tenir le
 * fichier client est un geste de front-desk. Le retour de test du PO du 16/09 a
 * montré ce que cela donnait pour l'autre métier qui porte ce rang : une
 * praticienne connectée ouvrait les dix-sept fiches du salon, téléphone, e-mail
 * et note interne comprises (capture 3 du ticket). L'arbitrage tranche : « ne
 * voit que les clientes de ses rendez-vous ».
 *
 * La lecture se scinde donc en deux permissions plutôt que de descendre d'un
 * rang : `customers:read:own` rend **le même écran**, borné aux personnes que
 * l'appelant a reçues ou doit recevoir ; `customers:read:all` rend le fichier.
 * Aucun `if` sur le rôle dans le service — la portée est un critère de
 * recherche, résolu une fois, à l'entrée (voir `CrmRepository.searchWhere`).
 * Elle se résout par `ownScopeFor(actor, 'customers:read:all')`, l'écriture
 * unique de cette traduction depuis #1205 : la permission large reste nommée
 * ici, parce que c'est la route qui sait par quelle porte on entre, et seul le
 * calcul est partagé avec les autres routes à double portée.
 *
 * L'**écriture**, elle, part entière au rang gérant (`customers:write`) : créer
 * une fiche, corriger un numéro, la désactiver sont des décisions **sur** le
 * fichier du salon, pas des lectures dedans, et le praticien n'a de sa clientèle
 * qu'une vue de consultation. Ce qu'il écrit sur une visite reste à sa place —
 * la note interne d'un rendez-vous, par `POST /appointments/:id/status`.
 *
 * L'**historique agrégé** et l'**export** exigent `customers:read:all` : tous
 * deux couvrent la relation entière du salon avec la personne, visites chez les
 * collègues comprises. Les ouvrir à `:own` aurait rendu par l'agrégat ce que la
 * liste vient de fermer. Pour l'export, le raisonnement de #81 tient inchangé :
 * il produit en un appel la totalité de ce que le salon détient sur une
 * personne, notes internes et textes libres compris, et la minimisation du
 * CDC §5.1 se joue autant sur qui peut lire que sur ce qui est lu.
 *
 * ## Le rang `ADMIN` survit à un seul endroit
 *
 * L'**anonymisation**. C'est la seule opération de tout le module
 * qui **détruise** irréversiblement une donnée : ni la désactivation, ni la
 * modification, ni rien d'autre ne perd quoi que ce soit. Il n'y a pas de
 * retour arrière — c'est le propos —, et une opération sans retour arrière
 * appartient au rang le plus élevé de l'établissement. Même seuil que
 * `PATCH /users/:id/role` chez `identity`, pour la même raison. Elle reste
 * exprimée par un rang parce que les rangs restent **vrais** là où ils le sont :
 * la matrice de l'ADR 0013 n'a pas remplacé la hiérarchie, elle a remplacé ce
 * que la hiérarchie ne savait pas dire.
 *
 * **Aucune route n'est ouverte au rôle `CLIENT`** — il ne porte aucune des
 * permissions citées ci-dessus. Une cliente lit et corrige
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
  @AuthWith('customers:read:own', 'customers:read:all')
  @ApiOperation({ summary: 'Rechercher dans le fichier client' })
  @ApiOkResponse({ type: CustomerPageDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  public async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListCustomersQueryDto,
  ): Promise<CustomerPageDto> {
    return this.customers.search({
      ...toSearchQuery(query),
      ownedByUserId: ownScopeFor(actor, 'customers:read:all'),
    });
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
  @AuthWith('customers:read:own', 'customers:read:all')
  @ApiOperation({ summary: 'Lire une fiche cliente' })
  @ApiOkResponse({ type: CustomerDto })
  @ApiNotFoundResponse({
    description:
      'Aucune fiche de cet établissement ne porte cet identifiant — ou elle ne ' +
      'fait pas partie de votre clientèle, ce qui est indiscernable et le reste ' +
      'délibérément.',
  })
  public async byId(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDto> {
    return toCustomerDto(
      await this.customers.byId(id, ownScopeFor(actor, 'customers:read:all')),
    );
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
  // `customers:read:all` : l'agrégat couvre la relation entière du salon avec la
  // personne, visites chez les collègues comprises. L'ouvrir au périmètre propre
  // aurait rendu par la somme ce que la liste vient de fermer (#812).
  @AuthWith('customers:read:all')
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
  // Même population qu'avant #812 — `customers:read:all` est au rang gérant —,
  // exprimée dans le vocabulaire des permissions plutôt qu'en rang.
  @AuthWith('customers:read:all')
  @ApiOperation({ summary: 'Exporter les données personnelles d’une cliente (RGPD)' })
  @ApiOkResponse({ type: CustomerDataExportDto })
  @ApiBadRequestResponse({ description: 'Langue inconnue — `locale` attend `fr` ou `en`.' })
  @ApiNotFoundResponse({ description: 'Aucune fiche de cet établissement ne porte cet identifiant.' })
  public async exportOf(
    @Param('id', ParseUUIDPipe) id: string,
    // `locale` ne décide que des **mots** du document : les clés JSON, les
    // instants UTC et les montants entiers n'en dépendent pas, et le 404 du
    // salon voisin est rendu avant que la langue n'ait servi à quoi que ce soit
    // (#852). Un paramètre de présentation n'est pas une entrée de périmètre.
    @Query() query: CustomerDataExportQueryDto,
  ): Promise<CustomerDataExportDto> {
    // `query.locale` passé tel quel, absence comprise : le défaut est celui du
    // service (`DEFAULT_LOCALE`), écrit une seule fois. Le redire ici en aurait
    // fait deux expressions du même repli, à tenir d'accord.
    return toCustomerDataExportDto(await this.dataExport.byCustomerId(id, query.locale));
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
  @AuthWith('customers:write')
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
  @AuthWith('customers:write')
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
  @AuthWith('customers:write')
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
