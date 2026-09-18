import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import type { PlatformTenant, PlatformTenantDetail, PlatformTenantEvent } from '@spa/shared';

import {
  CreatePlatformNoteDto,
  CreateTenantDto,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  ListTenantsQueryDto,
  PlatformTenantDetailDto,
  PlatformTenantEventDto,
  ProvisionedTenantDto,
  ReissuedTenantInvitationDto,
  TenantPageDto,
  TenantSummaryDto,
  UpdateTenantStatusDto,
  toPlatformTenantDetailDto,
  toPlatformTenantEventDto,
  toProvisionedTenantDto,
  toTenantPageDto,
  toTenantPageQuery,
  toTenantSummaryDto,
} from './dto/platform.dto';
import { CurrentOperator, PlatformAuth } from './platform-auth.guard';
import { PlatformConsoleService } from './platform-console.service';
import { PlatformService } from './platform.service';
import type { AuthenticatedOperator } from './platform.types';

/** Le nom de l'en-tête d'idempotence, écrit une fois — critère 6. */
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * La console de l'éditeur — ouvrir un salon, les lister, réinviter un gérant
 * (#806, critères 2 et 4).
 *
 * | Route | Ce qu'elle démontre |
 * |---|---|
 * | `POST /platform/tenants` | un jeton d'établissement, même `ADMIN`, reçoit **401** |
 * | `GET /platform/tenants` | la liste est celle de la plateforme, jamais d'un salon |
 * | `POST /platform/tenants/:id/invitation` | un gérant retrouve son lien, même après expiration |
 * | `GET /platform/tenants/:id` | la fiche : mise en route, activité en nombres, comptes internes, historique |
 * | `POST /platform/tenants/:id/notes` | l'éditeur garde trace de ses échanges avec le salon |
 * | `PUT /platform/tenants/:id/status` | suspendre ou réactiver, motif à l'appui |
 *
 * ## Pourquoi `:id` en chemin ne viole pas tenant-isolation §2
 *
 * La règle interdit qu'un **client** désigne l'établissement dont il lit les
 * données : le tenant vient du jeton, jamais du chemin. Ici, l'appelant n'est pas
 * dans un établissement — il est au-dessus de tous (ADR 0012), et son jeton ne
 * porte aucun `tenantId` à contredire. L'identifiant en chemin ne choisit donc
 * pas une portée : il nomme la ressource sur laquelle la console agit, comme
 * `:id` nomme un compte dans `GET /users/:id`. La garde qui l'autorise est
 * `PlatformAuthGuard`, et elle **refuse** de servir une requête dont la portée
 * aurait déjà été résolue sur un salon.
 *
 * ## Ce que la console ne fait pas
 *
 * Elle ne lit aucune donnée **de** salon : ni agenda, ni fiche cliente, ni
 * encaissement. La fiche compte des rendez-vous et des comptes clients, elle
 * n'en rend aucun ; elle nomme les comptes **internes** du salon, ceux à qui
 * l'éditeur a affaire. Le multi-établissement côté client — un gérant qui
 * pilote plusieurs salons — reste hors périmètre (CDC §1.4).
 */
@ApiTags('platform')
@Controller({ path: 'platform/tenants', version: '1' })
@PlatformAuth()
export class PlatformTenantsController {
  public constructor(
    private readonly platform: PlatformService,
    private readonly console: PlatformConsoleService,
  ) {}

  /**
   * Ouvre un établissement et invite son administrateur — critère 2.
   *
   * **201** : l'établissement, son compte administrateur et la ligne de journal
   * sont écrits dans une seule transaction. Le corps rend les trois liens que
   * l'éditeur remet au gérant.
   *
   * **201 aussi sur un rejeu**, avec `replayed: true` : la clé d'idempotence
   * désignait un salon déjà ouvert, rien n'a été créé, et la réponse est celle
   * de la première requête — liens frais compris. Un 200 aurait obligé
   * l'appelant à traiter deux codes pour une opération dont le résultat est le
   * même.
   *
   * **400** sur un corps invalide, ou sur un en-tête `Idempotency-Key` absent ou
   * mal formé. **409** si le nom d'adresse est déjà pris ou réservé.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ouvrir un établissement et inviter son administrateur' })
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'Clé choisie par l’appelant. Rejouer la même clé rend l’établissement déjà ' +
      'ouvert au lieu d’en ouvrir un second.',
  })
  @ApiCreatedResponse({ type: ProvisionedTenantDto })
  @ApiBadRequestResponse({ description: 'Corps ou en-tête invalide — le champ fautif est nommé.' })
  @ApiConflictResponse({ description: 'Ce nom d’adresse est déjà pris ou réservé.' })
  public async provision(
    @CurrentOperator() operator: AuthenticatedOperator,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateTenantDto,
  ): Promise<ProvisionedTenantDto> {
    const provisioned = await this.platform.provisionTenant({
      operator,
      idempotencyKey: readIdempotencyKey(idempotencyKey),
      slug: body.slug,
      name: body.name,
      timezone: body.timezone,
      defaultCurrency: body.defaultCurrency,
      countryCode: body.countryCode,
      addressLine1: body.addressLine1,
      // Le DTO distingue « absent » de « vide » ; le service ne connaît que
      // « une valeur » ou « pas de valeur ».
      addressLine2: body.addressLine2 ?? null,
      postalCode: body.postalCode ?? null,
      city: body.city,
      adminEmail: body.adminEmail,
      adminFirstName: body.adminFirstName,
      adminLastName: body.adminLastName,
    });

    return toProvisionedTenantDto(provisioned);
  }

  /**
   * Les établissements de la plateforme, page par page — critère 4.
   *
   * Les plus récents d'abord : la console sert à suivre les ouvertures, et le
   * salon qu'on vient d'ouvrir est celui qu'on cherche. `q`, `billingStatus` et
   * `state` filtrent, combinés en « et ».
   */
  @Get()
  @ApiOperation({ summary: 'Lister les établissements de la plateforme' })
  @ApiOkResponse({ type: TenantPageDto })
  @ApiBadRequestResponse({ description: 'Pagination invalide — le champ fautif est nommé.' })
  public async list(@Query() query: ListTenantsQueryDto): Promise<TenantPageDto> {
    return toTenantPageDto(await this.platform.listTenants(toTenantPageQuery(query)));
  }

  /**
   * Réémet l'invitation de l'administrateur d'un établissement — critère 4.
   *
   * **201** comme la réémission côté salon : ce qui est créé est une invitation,
   * pas un compte. **404** pour un identifiant inconnu. **409** pour un
   * établissement sans compte administrateur — un salon créé avant cette
   * console, par le seed ou à la main.
   */
  @Post(':id/invitation')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Réémettre l’invitation de l’administrateur d’un établissement' })
  @ApiCreatedResponse({ type: ReissuedTenantInvitationDto })
  @ApiNotFoundResponse({ description: 'Aucun établissement ne porte cet identifiant.' })
  @ApiConflictResponse({
    description: 'Cet établissement n’a aucun compte administrateur à réinviter.',
  })
  public async reissueInvitation(
    @CurrentOperator() operator: AuthenticatedOperator,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ReissuedTenantInvitationDto> {
    // Par le service de la console : la réémission s'inscrit dans l'historique
    // du salon, pour que l'opérateur suivant sache qu'un lien est déjà parti.
    const reissued = await this.console.reissueAdminInvitation({ operator, tenantId: id });
    return {
      tenantId: reissued.tenantId,
      admin: { ...reissued.admin },
      links: { ...reissued.links },
    };
  }

  /**
   * La fiche d'un salon — identité, abonnement, mise en route, activité sur
   * trente jours **en nombres**, comptes internes et historique.
   *
   * **404** pour un identifiant inconnu.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Lire la fiche d’un établissement' })
  @ApiOkResponse({ type: PlatformTenantDetailDto })
  @ApiNotFoundResponse({ description: 'Aucun établissement ne porte cet identifiant.' })
  public async detail(@Param('id', ParseUUIDPipe) id: string): Promise<PlatformTenantDetail> {
    return toPlatformTenantDetailDto(await this.console.tenantDetail(id));
  }

  /**
   * Ajoute une note interne à l'historique d'un salon.
   *
   * **201** : la note créée. **404** pour un identifiant inconnu. **400** sur une
   * note vide ou trop longue.
   */
  @Post(':id/notes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Noter un échange avec un établissement' })
  @ApiCreatedResponse({ type: PlatformTenantEventDto })
  @ApiBadRequestResponse({ description: 'Note vide ou trop longue.' })
  @ApiNotFoundResponse({ description: 'Aucun établissement ne porte cet identifiant.' })
  public async addNote(
    @CurrentOperator() operator: AuthenticatedOperator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreatePlatformNoteDto,
  ): Promise<PlatformTenantEvent> {
    return toPlatformTenantEventDto(
      await this.console.addNote({ operator, tenantId: id, body: body.body }),
    );
  }

  /**
   * Suspend ou réactive un salon — **PUT**, parce que la requête décrit l'état
   * voulu et qu'elle est rejouable : la rejouer ne réécrit rien.
   *
   * Suspendre rend le salon introuvable par son adresse (vitrine, réservation,
   * connexion) et révoque ses sessions. **200** : le salon tel qu'il est
   * désormais. **404** pour un identifiant inconnu.
   */
  @Put(':id/status')
  @ApiOperation({ summary: 'Suspendre ou réactiver un établissement' })
  @ApiOkResponse({ type: TenantSummaryDto })
  @ApiBadRequestResponse({ description: 'Motif manquant ou état non booléen.' })
  @ApiNotFoundResponse({ description: 'Aucun établissement ne porte cet identifiant.' })
  public async updateStatus(
    @CurrentOperator() operator: AuthenticatedOperator,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTenantStatusDto,
  ): Promise<PlatformTenant> {
    return toTenantSummaryDto(
      await this.console.updateStatus({
        operator,
        tenantId: id,
        isActive: body.isActive,
        reason: body.reason,
      }),
    );
  }
}

/**
 * Lit l'en-tête d'idempotence, ou refuse la requête.
 *
 * **Obligatoire**, et ce n'est pas un excès de zèle : ouvrir un salon écrit trois
 * lignes dont l'une porte un compte administrateur, et un appelant qui rejoue
 * sans clé ouvrirait un second salon sur la même adresse e-mail de gérant. Une
 * clé facultative aurait rendu la garantie du critère 6 conditionnelle au soin
 * de l'appelant.
 *
 * Le refus prend la forme d'un rapport de validation — `message` en tableau —
 * pour que `DomainExceptionFilter` le rende sous le même
 * `{ code: "VALIDATION_ERROR", details.violations }` que n'importe quel champ de
 * corps invalide. Un appelant n'a pas à traiter deux formes de 400 selon que la
 * faute est dans le corps ou dans un en-tête.
 */
function readIdempotencyKey(raw: string | undefined): string {
  const key = (raw ?? '').trim();
  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new BadRequestException({
      message: [
        `${IDEMPOTENCY_HEADER} : en-tête obligatoire, de ` +
          `${String(IDEMPOTENCY_KEY_MIN_LENGTH)} à ${String(IDEMPOTENCY_KEY_MAX_LENGTH)} caractères`,
      ],
    });
  }
  return key;
}
