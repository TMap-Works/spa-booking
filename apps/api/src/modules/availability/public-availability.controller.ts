import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { AvailabilityQueryService } from './availability.query.service';
import { AvailabilityDto, AvailabilityQueryDto } from './dto/availability.dto';

/**
 * `GET /api/v1/public/:tenantSlug/availability` — le calendrier du tunnel (#35).
 *
 * ## Le `:tenantSlug` du chemin n'est pas un paramètre de ce contrôleur
 *
 * Il est déclaré parce qu'il est dans l'URL, et il n'est lu nulle part ici.
 * `TenantScopeMiddleware` l'a déjà résolu contre la table `tenants` et a posé
 * l'identifiant obtenu dans le contexte de requête ; c'est de là que le service,
 * le cache et les repositories tirent l'établissement. Un `@Param('tenantSlug')`
 * lu ci-dessous serait un retour à « le client choisit son tenant »
 * (tenant-isolation §2) — la chaîne d'URL n'a aucune valeur de preuve, seule sa
 * résolution en a. Même conduite que `PublicServicesController` et
 * `PublicAppointmentsController`.
 *
 * La conséquence utile : si le slug est inconnu, désactivé, mal formé ou en
 * désaccord avec le sous-domaine, **aucune méthode de ce fichier ne s'exécute**,
 * et aucune clé de cache n'est fabriquée.
 *
 * ## Pas de garde d'authentification, et c'est le propos
 *
 * On réserve sans compte (#37, quatrième critère) : on doit donc pouvoir voir
 * les créneaux sans compte. Ce qui tient cette route n'est pas une garde, mais
 * ce qu'elle rend — des instants et des identifiants de praticiens, jamais un
 * `tenantId`, jamais un motif d'absence, jamais une identité de cliente. La
 * projection est la même que celle du back-office parce qu'elle ne contenait
 * déjà rien d'interne.
 *
 * ## Un quota, en revanche, et un large
 *
 * `ThrottlerGuard`, pour une raison propre à cette route : elle **calcule**. Six
 * lectures et un découpage par pas de quinze minutes sur trente et un jours, sur
 * une surface ouverte et anonyme. Le cache absorbe la répétition d'une même
 * question, mais un appelant qui fait varier `from` d'un jour à chaque appel le
 * contourne entièrement.
 *
 * Cent vingt appels par minute et par adresse laissent le calendrier se
 * rafraîchir toutes les demi-secondes — bien au-delà de ce que #44 demande, « à
 * intervalle court et au retour de focus » — et bornent l'abus. Le quota est
 * douze fois plus large que celui des routes d'écriture du tunnel : celles-ci
 * posent des rendez-vous, celle-ci n'écrit rien.
 */
@ApiTags('public')
@Controller({ path: 'public/:tenantSlug/availability', version: '1' })
@UseGuards(ThrottlerGuard)
@ApiParam({
  name: 'tenantSlug',
  description:
    'Slug public de l’établissement. Résolu contre la table `tenants` par le middleware, ' +
    'avant le contrôleur — un slug inconnu répond 404 sans qu’aucun code métier ne tourne.',
  example: 'salon-des-lilas',
})
export class PublicAvailabilityController {
  public constructor(private readonly availability: AvailabilityQueryService) {}

  /**
   * Les créneaux libres d'une prestation, tels que le tunnel les affiche.
   *
   * **200** avec toutes les journées demandées, y compris vides — c'est ce qui
   * permet d'afficher « complet » sans deviner les trous.
   *
   * **404** si l'établissement ou la prestation est introuvable : un slug
   * inconnu, une prestation d'un autre salon et une prestation retirée du
   * catalogue rendent la même réponse.
   *
   * **422 `AVAILABILITY_RANGE_TOO_WIDE`** sur une plage inversée ou de plus de
   * trente et un jours.
   *
   * **429** au-delà de cent vingt interrogations par minute et par adresse.
   *
   * Un créneau rendu ici **n'est pas une réservation** : il peut être pris entre
   * l'affichage et la validation, et il peut provenir d'un cache vieux d'au plus
   * soixante secondes. C'est la contrainte d'exclusion qui tranche, et
   * `SLOT_NO_LONGER_AVAILABLE` qui le dit au front (booking-engine §1).
   */
  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Lister les créneaux libres, sans compte' })
  @ApiOkResponse({ type: AvailabilityDto })
  @ApiBadRequestResponse({ description: 'Paramètre invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({ description: 'Établissement ou prestation introuvable.' })
  @ApiUnprocessableEntityResponse({
    description: 'Plage inversée ou de plus de 31 jours (`AVAILABILITY_RANGE_TOO_WIDE`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota d’interrogations dépassé pour cette adresse.' })
  public async slots(@Query() query: AvailabilityQueryDto): Promise<AvailabilityDto> {
    return this.availability.slotsFor({
      serviceId: query.serviceId,
      ...(query.staffId !== undefined && { staffId: query.staffId }),
      from: query.from,
      to: query.to,
    });
  }
}
