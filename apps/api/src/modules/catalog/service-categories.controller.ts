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
  CreateServiceCategoryDto,
  ListServiceCategoriesQueryDto,
  ServiceCategoryDto,
  UpdateServiceCategoryDto,
} from './dto/service-category.dto';
import { ServiceCategoriesService } from './service-categories.service';

/**
 * Rubriques du catalogue.
 *
 * Mêmes seuils que les prestations — lecture au rang `STAFF`, écriture au rang
 * `MANAGER` — et pour la même raison : la rubrique est une décision de
 * présentation du catalogue, donc de gestion.
 *
 * Aucun `DELETE` non plus : une rubrique se désactive. Des prestations la
 * référencent, et la clé étrangère `Restrict` de `services.category_id`
 * refuserait de toute façon la suppression.
 *
 * Le chemin est `service-categories` et non `categories` : le mot est déjà
 * revendiqué par le vocabulaire des ventes retail du module `payments`, et une
 * route `/categories` qui ne parlerait que de soins serait un faux ami à la
 * première extension du catalogue.
 */
@ApiTags('catalog')
@Controller({ path: 'service-categories', version: '1' })
export class ServiceCategoriesController {
  public constructor(private readonly categories: ServiceCategoriesService) {}

  @Get()
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lister les rubriques du catalogue' })
  @ApiOkResponse({ type: [ServiceCategoryDto] })
  public async list(@Query() query: ListServiceCategoriesQueryDto): Promise<ServiceCategoryDto[]> {
    return this.categories.list(query.activeOnly ?? false);
  }

  /**
   * Une rubrique, par identifiant.
   *
   * Répond **404** pour un identifiant inconnu comme pour celui d'une rubrique
   * d'un autre établissement : distinguer les deux confirmerait l'existence de
   * la seconde (tenant-isolation §4).
   */
  @Get(':id')
  @AuthAtLeast('STAFF')
  @ApiOperation({ summary: 'Lire une rubrique du catalogue' })
  @ApiOkResponse({ type: ServiceCategoryDto })
  @ApiNotFoundResponse({ description: 'Aucune rubrique de cet établissement ne porte cet identifiant.' })
  public async byId(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceCategoryDto> {
    return this.categories.byId(id);
  }

  @Post()
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Créer une rubrique' })
  @ApiCreatedResponse({ type: ServiceCategoryDto })
  @ApiConflictResponse({ description: 'Une rubrique de cet établissement porte déjà ce slug.' })
  public async create(@Body() body: CreateServiceCategoryDto): Promise<ServiceCategoryDto> {
    return this.categories.create(body);
  }

  @Patch(':id')
  @AuthAtLeast('MANAGER')
  @ApiOperation({ summary: 'Modifier une rubrique, ou l’activer / la désactiver' })
  @ApiOkResponse({ type: ServiceCategoryDto })
  @ApiNotFoundResponse({ description: 'Aucune rubrique de cet établissement ne porte cet identifiant.' })
  @ApiConflictResponse({ description: 'Une rubrique de cet établissement porte déjà ce slug.' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryDto> {
    return this.categories.update(id, body);
  }
}
