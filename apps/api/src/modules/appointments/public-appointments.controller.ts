import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { AppointmentsService } from './appointments.service';
import { AppointmentDto, BookAppointmentDto, toGuestContact } from './dto/book-appointment.dto';

/**
 * La prise de rendez-vous du tunnel public — le point d'entrée du revenu (#37).
 *
 * ## Le `:tenantSlug` du chemin n'est pas un paramètre de ce contrôleur
 *
 * Il est déclaré parce qu'il est dans l'URL, et il n'est lu nulle part ici.
 * `TenantScopeMiddleware` l'a déjà résolu contre la table `tenants` et a posé
 * l'identifiant obtenu dans le contexte de requête ; c'est de là que le service
 * et le repository tirent l'établissement. Un `@Param('tenantSlug')` lu dans une
 * méthode ci-dessous serait un retour à « le client choisit son tenant »
 * (tenant-isolation §2) — la chaîne d'URL n'a aucune valeur de preuve, seule sa
 * résolution en a. Même conduite que `PublicServicesController`.
 *
 * La conséquence utile : si le slug est inconnu, désactivé, mal formé ou en
 * désaccord avec le sous-domaine, **aucune méthode de ce fichier ne s'exécute**.
 *
 * ## Pas de garde, et c'est le propos
 *
 * Le quatrième critère de #37 est « un client peut réserver sans compte, avec
 * seulement ses coordonnées » : exiger un jeton le contredirait mot pour mot.
 * Ce qui tient cette route n'est donc pas une garde, mais trois choses :
 *
 * 1. le `ValidationPipe` global, `whitelist` et `forbidNonWhitelisted` — aucun
 *    champ non déclaré, donc aucun `tenantId`, `clientId` ni `price` glissé dans
 *    le corps ;
 * 2. le contrôle de disponibilité du service — on ne réserve que ce que le
 *    calendrier proposait, chez un praticien qui pratique le soin, dans ses
 *    heures, hors congés et hors préavis ;
 * 3. la contrainte d'exclusion en base, qui tranche l'unicité et rend 409 ;
 * 4. `ThrottlerGuard`, pour la même raison qui le pose sur `/auth/register` :
 *    cette route **écrit** sans qu'on ait à prouver quoi que ce soit — une fiche
 *    dans `users`, et un rendez-vous `PENDING` qui **occupe l'agenda dès sa
 *    création**. Sans quota, un script tire tous les créneaux libres d'un salon
 *    en quelques secondes et le rend incapable de vendre, sans jamais rien
 *    exploiter d'autre que le comportement nominal.
 *
 * ## Ce que cette route ne fait pas
 *
 * Elle ne réserve **pas pour autrui** : il n'y a pas de `clientId` dans le corps.
 * Le comptoir qui réserve au nom d'une cliente déjà fichée est une surface de
 * back-office, gardée, et c'est #50. La mêler ici obligerait à distinguer par le
 * corps deux appelants qui n'ont pas les mêmes droits — la façon la plus sûre de
 * se tromper.
 */
@ApiTags('public')
@Controller({ path: 'public/:tenantSlug/appointments', version: '1' })
@UseGuards(ThrottlerGuard)
@ApiParam({
  name: 'tenantSlug',
  description:
    'Slug public de l’établissement. Résolu contre la table `tenants` par le middleware, ' +
    'avant le contrôleur — un slug inconnu répond 404 sans qu’aucun code métier ne tourne.',
  example: 'salon-des-lilas',
})
export class PublicAppointmentsController {
  public constructor(private readonly appointments: AppointmentsService) {}

  /**
   * Réserve un créneau, au statut `PENDING`.
   *
   * **201**, et le corps porte le rendez-vous — le tunnel a besoin de son
   * identifiant pour l'écran de confirmation et pour le lien d'annulation (#45).
   *
   * **409 `SLOT_NO_LONGER_AVAILABLE`** couvre toutes les façons dont ce créneau
   * n'est pas réservable : pris entre l'affichage et la validation, hors des
   * heures du praticien, pendant un congé, sous le préavis minimum, ou chez un
   * praticien qui ne pratique pas ce soin. Le front n'a qu'une conduite pour
   * toutes — réafficher les créneaux (#46) — et les distinguer ferait de cette
   * route une sonde d'agenda.
   *
   * **429** au-delà de dix réservations par minute et par adresse. Le quota est
   * du même ordre que celui de `/auth/register` — cinq inscriptions par minute —
   * et pour la même raison : une cliente réserve un rendez-vous, pas dix, et le
   * seul appelant que cette borne dérange est celui qui remplit l'agenda d'un
   * salon pour l'empêcher de vendre.
   */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Réserver un créneau, sans compte' })
  @ApiCreatedResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description: 'Établissement ou prestation introuvable, ou prestation retirée du catalogue.',
  })
  @ApiConflictResponse({
    description: 'Le créneau n’est pas — ou n’est plus — réservable (`SLOT_NO_LONGER_AVAILABLE`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota de réservations dépassé pour cette adresse.' })
  public async book(@Body() body: BookAppointmentDto): Promise<AppointmentDto> {
    return this.appointments.book({
      serviceId: body.serviceId,
      staffId: body.staffId,
      // La chaîne a été validée comme instant à offset explicite par le DTO :
      // `new Date` ne peut plus produire ici de date invalide ni de date-heure
      // interprétée dans le fuseau de la machine.
      startsAt: new Date(body.startsAt),
      client: toGuestContact(body.client),
      clientNote: body.clientNote ?? null,
    });
  }
}
