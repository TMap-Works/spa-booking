import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AuthAtLeast } from '../identity/auth.decorator';
import {
  CreateServiceDto,
  ListServicesQueryDto,
  ServiceDto,
  UpdateServiceDto,
} from './dto/service.dto';
import { ServicesService } from './services.service';

/**
 * Catalogue des prestations — la surface de back-office de #24.
 *
 * | Route | Rôles |
 * |---|---|
 * | `GET /services` | staff et au-dessus |
 * | `GET /services/:id` | staff et au-dessus |
 * | `POST /services` | manager et au-dessus |
 * | `PATCH /services/:id` | manager et au-dessus |
 *
 * ## Lire au rang `STAFF`, écrire au rang `MANAGER`
 *
 * Un praticien a besoin du catalogue — durées et tampons décident de son agenda,
 * le prix figure sur la fiche qu'il consulte au comptoir. Le **modifier** est un
 * geste de gestion : changer un tarif ou une durée déplace de l'argent et des
 * créneaux, et le CDC §1.4 réserve la configuration de l'établissement à
 * l'encadrement.
 *
 * ## Aucun `DELETE`, et ce n'est pas un oubli
 *
 * Une prestation sort du catalogue par `PATCH { "isActive": false }`. Les
 * rendez-vous passés la référencent, et le reporting doit continuer à savoir ce
 * qui a été vendu — c'est aussi ce que la clé étrangère `Restrict` d'
 * `appointments.service_id` impose en base.
 *
 * ## Pourquoi aucun `:tenantId` nulle part
 *
 * L'établissement vient du jeton vérifié, jamais du chemin (tenant-isolation
 * §2). Une route `/tenants/:tenantId/services/:id` laisserait le client désigner
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
@ApiTags('catalog')
@Controller({ path: 'services', version: '1' })
export class ServicesController {
  public constructor(private readonly services: ServicesService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les prestations de l’établissement' })
  @ApiOkResponse({ type: [ServiceDto] })
  @ApiNotFoundResponse({ description: 'La rubrique demandée en filtre n’existe pas ici.' })
  public async list(@Query() query: ListServicesQueryDto): Promise<ServiceDto[]> {
    return this.services.list({
      activeOnly: query.activeOnly ?? false,
      ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
    });
  }

  /**
   * Une prestation, par identifiant.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'une prestation
   * d'un autre établissement : distinguer les deux reviendrait à confirmer
   * l'existence de la seconde (tenant-isolation §4).
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire une prestation de l’établissement' })
  @ApiOkResponse({ type: ServiceDto })
  @ApiNotFoundResponse({ description: 'Aucune prestation de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceDto> {
    return this.services.byId(id);
  }

  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Créer une prestation' })
  @ApiCreatedResponse({ type: ServiceDto })
  @ApiNotFoundResponse({ description: 'La rubrique demandée n’existe pas ici.' })
  @ApiConflictResponse({ description: 'Une prestation de cet établissement porte déjà ce slug.' })
  public async create(@Body() body: CreateServiceDto): Promise<ServiceDto> {
    return this.services.create(body);
  }

  /**
   * Modifie une prestation — y compris son activation.
   *
   * `PATCH` et non `PUT` : l'écran de back-office envoie le champ qu'il vient de
   * changer, et un `PUT` l'obligerait à renvoyer la fiche entière, donc à écraser
   * ce qu'un collègue aurait modifié entre-temps.
   */
  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Modifier une prestation, ou l’activer / la désactiver' })
  @ApiOkResponse({ type: ServiceDto })
  @ApiNotFoundResponse({ description: 'Aucune prestation de cet établissement ne porte cet identifiant.' })
  @ApiConflictResponse({ description: 'Une prestation de cet établissement porte déjà ce slug.' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateServiceDto,
  ): Promise<ServiceDto> {
    return this.services.update(id, body);
  }
}
