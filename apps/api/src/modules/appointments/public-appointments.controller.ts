import {
  applyDecorators,
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { Auth } from '../identity/auth.decorator';
import type { AuthenticatedUser } from '../identity/identity.types';
import { CurrentUser } from '../identity/jwt-auth.guard';
import { AppointmentsService } from './appointments.service';
import {
  AppointmentDto,
  type BookAppointmentBody,
  BookAppointmentBodyPipe,
  BookAppointmentDto,
  toGuestContact,
} from './dto/book-appointment.dto';
import {
  type CancelAppointmentBody,
  CancelAppointmentDto,
  cancelAppointmentBody,
  toCancellationReason,
} from './dto/cancel-appointment.dto';
import {
  type RescheduleAppointmentBody,
  RescheduleAppointmentDto,
  rescheduleAppointmentBody,
} from './dto/reschedule-appointment.dto';
import { AllowUnpaidTenant, RequireBookableSalon } from '../identity/tenant-billing.guard';

/**
 * Le régime d'accès des deux gestes que la cliente exerce **sur un rendez-vous
 * existant** — annuler et reporter (#1135).
 *
 * `@Auth('CLIENT')` seul, sans permission : la matrice de l'ADR 0013 n'en donne
 * aucune au rôle `CLIENT`, délibérément (`identity/permissions.ts`), et c'est
 * juste — une cliente n'a pas de périmètre d'agenda, elle a **ses** rendez-vous.
 * Ce que la garde tranche ici est donc la porte ; ce qui reste à trancher, « ce
 * rendez-vous est-il le sien ? », se lit sur la ligne et se juge dans le
 * service, en 404.
 *
 * Ce que ce couple ferme, et que #1135 avait laissé ouvert :
 *
 * | Appelant | Avant | Après |
 * |---|---|---|
 * | anonyme qui connaît l'UUID | 200 | **401** |
 * | praticien, sur le rendez-vous d'une collègue | 200, `cancelledBy: CLIENT` | **403** — le rôle n'est pas `CLIENT` |
 * | cliente, sur le rendez-vous d'une autre | 200 | **404** — indiscernable d'un inconnu |
 * | cliente, sur le sien | 200 | 200 |
 *
 * `@AllowUnpaidTenant()` neutralise `TenantBillingGuard`, que `@Auth` monte.
 * Sans lui, ces deux routes se seraient mises à rendre 402 chez un salon dont
 * l'abonnement a expiré — un changement que ce ticket n'a pas à faire, et qui
 * retiendrait une cliente de **libérer** un créneau qu'elle n'honorera pas.
 * L'ADR 0016 ferme la prise de rendez-vous d'un salon impayé, ce que porte
 * `@RequireBookableSalon()` sur `book` ; il ne ferme pas la tenue des
 * rendez-vous déjà pris.
 */
const AuthenticatedClient = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Auth('CLIENT'), AllowUnpaidTenant());

/**
 * Le tunnel public du rendez-vous — le point d'entrée du revenu (#37), son
 * report (#39) et son annulation (#40).
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
 * C'est aussi ce qui rend lisible, depuis `book`, le **pays** de l'établissement
 * (#1028) : le cycle de Nest est middleware → garde → pipe → gestionnaire, si
 * bien que la portée de tenant est ouverte et résolue quand le corps est validé.
 * `BookAppointmentBodyPipe` y lit `tenants.country_code` pour compléter un
 * numéro de téléphone national. Là encore, rien ne vient du chemin : le pays est
 * celui de l'établissement **résolu**, pas d'une chaîne d'URL.
 *
 * ## Deux régimes d'accès, et non plus un seul (#1135)
 *
 * | Route | Qui peut l'appeler |
 * |---|---|
 * | `POST /public/{slug}/appointments` | tout le monde — voir ci-dessous |
 * | `POST …/{id}/reschedule` | la **cliente du rendez-vous**, jeton vérifié |
 * | `POST …/{id}/cancel` | la **cliente du rendez-vous**, jeton vérifié |
 *
 * La doctrine d'origine était uniforme — « on réserve sans compte, donc on
 * annule sans compte » (#40) — et elle tenait tant que l'identifiant du
 * rendez-vous était un secret de la cliente. Il ne l'est plus : un praticien
 * lit les `appointmentId` de ses collègues par le journal des envois, et la
 * route publique lui rouvrait sans jeton ce que le back-office lui refusait
 * (403 `OWN_SCOPE_ONLY`, #812) — en l'inscrivant `cancelledBy: CLIENT`, c'est-à-
 * dire au nom de la cliente. Voir {@link AuthenticatedClient}.
 *
 * `book` garde son régime : c'est #1136 qui tranche la réservation sans compte,
 * et le faire ici aurait mêlé deux décisions dans un même diff.
 *
 * ## Pas de garde sur `book`, et c'est le propos
 *
 * Le quatrième critère de #37 est « un client peut réserver sans compte, avec
 * seulement ses coordonnées » : exiger un jeton le contredirait mot pour mot.
 * Ce qui tient cette route n'est donc pas une garde, mais trois choses :
 *
 * 1. la validation de la frontière — aucun champ non déclaré, donc aucun
 *    `tenantId`, `clientId` ni `price` glissé dans le corps. Sur `book`, c'est
 *    le `.strict()` du contrat partagé, monté par `BookAppointmentBodyPipe`
 *    ([ADR 0008](../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)) ;
 *    sur `reschedule` et `cancel`, c'est encore le `ValidationPipe` global avec
 *    `whitelist` et `forbidNonWhitelisted`. Les deux refusent la même chose et
 *    rendent le même corps d'erreur ;
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
   * **`staffId` est facultatif** : l'omettre, c'est l'option « premier
   * disponible » du CDC §1.4 (#36). Le serveur affecte alors le praticien, et le
   * rendez-vous rendu porte celui qu'il a retenu. Sans préférence, le 409 n'est
   * prononcé qu'après avoir tenté **tous** les praticiens qui proposaient ce
   * créneau, et son `details.staffId` vaut `null` — le corps ne nomme jamais un
   * praticien que la cliente n'a pas désigné.
   *
   * **409 `CLIENT_EMAIL_NOT_BOOKABLE`** est l'autre conflit, et il n'a rien à
   * voir avec l'agenda (#313) : l'adresse envoyée est celle d'un compte du
   * personnel de cet établissement, à laquelle une réservation en ligne ne se
   * rattache jamais. Le front ne doit pas le traiter comme le précédent —
   * réafficher les créneaux n'y changerait rien —, mais demander une autre
   * adresse. C'est ce que le `code` distinct existe pour dire.
   *
   * Une adresse **déjà cliente** du salon, elle, rend 201 comme une adresse
   * inconnue : le refus ne dit donc rien du fichier client, seulement de
   * l'annuaire du personnel.
   *
   * **429** au-delà de dix réservations par minute et par adresse. Le quota est
   * du même ordre que celui de `/auth/register` — cinq inscriptions par minute —
   * et pour la même raison : une cliente réserve un rendez-vous, pas dix, et le
   * seul appelant que cette borne dérange est celui qui remplit l'agenda d'un
   * salon pour l'empêcher de vendre.
   *
   * ## Ce que cette route écrit, et où
   *
   * Un rendez-vous, et — si l'adresse est nouvelle — une fiche cliente. Les deux
   * dans **une seule transaction** depuis #313 : un 409 de créneau ne laisse plus
   * de fiche derrière lui. La fiche est écrite par `crm`, jamais par ce module.
   */
  @Post()
  // Un salon sans abonnement en cours ne prend plus de réservation (ADR 0016).
  @RequireBookableSalon()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Réserver un créneau, sans compte' })
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `BookAppointmentDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: BookAppointmentDto })
  @ApiCreatedResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description: 'Établissement ou prestation introuvable, ou prestation retirée du catalogue.',
  })
  @ApiConflictResponse({
    description:
      'Deux refus distincts, que le champ `code` sépare. ' +
      '`SLOT_NO_LONGER_AVAILABLE` : le créneau n’est pas — ou n’est plus — réservable. ' +
      '`CLIENT_EMAIL_NOT_BOOKABLE` : l’adresse envoyée est celle d’un compte du personnel ' +
      'de cet établissement, à laquelle une réservation en ligne ne se rattache jamais ' +
      '(#313). Le second est définitif : réessayer avec le même corps rendra le même refus, ' +
      'et c’est une autre adresse qu’il faut proposer à la cliente.',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota de réservations dépassé pour cette adresse.' })
  public async book(
    // Le type est celui **du contrat**, jamais `BookAppointmentDto` : la classe
    // n'a plus de décorateur `class-validator`, et la typer ici ferait rejouer
    // le `ValidationPipe` global, dont le `whitelist` viderait le corps de tous
    // ses champs (ADR 0008).
    @Body(BookAppointmentBodyPipe) body: BookAppointmentBody,
  ): Promise<AppointmentDto> {
    return this.appointments.book({
      serviceId: body.serviceId,
      // Le contrat distingue « absent » de « vide » ; le domaine ne connaît que
      // `null`, qui se lit ici « premier disponible » (#36).
      staffId: body.staffId ?? null,
      // `offsetDateTimeSchema` a déjà normalisé la chaîne en instant UTC :
      // `new Date` ne peut plus produire ici de date invalide ni de date-heure
      // interprétée dans le fuseau de la machine.
      startsAt: new Date(body.startsAt),
      client: toGuestContact(body.client),
      clientNote: body.clientNote ?? null,
      // L'accord passe tel quel — un booléen, jamais une date (#790). Le
      // contrat l'a déjà jugé : `dataConsentSchema` refuse `false` comme il
      // refuse l'absence, si bien qu'aucune réservation sans accord n'atteint
      // le service. C'est lui qui l'horodate, depuis son horloge.
      dataConsent: body.dataConsent,
    });
  }

  /**
   * Reporte un rendez-vous : l'ancien est annulé, un nouveau le remplace (#39).
   *
   * **201**, et le corps porte le **nouveau** rendez-vous — identifiant compris.
   * C'est bien une création : l'ancien identifiant ne désigne plus un
   * rendez-vous à venir, et le front doit remplacer celui qu'il gardait.
   * `rescheduledFromId` le relie à celui qu'il remplace.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement :
   * les deux doivent être indiscernables, faute de quoi cette route devient une
   * sonde d'existence (tenant-isolation §4).
   *
   * **422 `INVALID_STATE_TRANSITION`** quand le rendez-vous est terminé, déjà
   * annulé ou marqué no-show : il n'y a plus de créneau à déplacer, et en créer
   * un nouveau à cette occasion serait une réservation déguisée — sans les
   * coordonnées ni le consentement que la réservation exige.
   *
   * **409 `SLOT_NO_LONGER_AVAILABLE`** couvre toutes les façons dont le créneau
   * d'arrivée n'est pas réservable, exactement comme à la réservation. Il couvre
   * en particulier un cas propre au report : **un créneau qui chevauche le
   * rendez-vous en cours de déplacement**. Le calendrier ne le propose pas — il
   * y voit un praticien occupé —, et le proposer demanderait au moteur de
   * disponibilité d'exclure un rendez-vous nommé de son calcul.
   *
   * **429** au-delà de dix reports par minute et par adresse, même quota et même
   * raison que la réservation : cette route écrit dans l'agenda du salon.
   *
   * ## La garde, depuis #1135
   *
   * **401** sans jeton, **403** avec un jeton qui n'est pas celui d'une cliente,
   * **404** quand le rendez-vous n'est pas le sien — indiscernable d'un
   * identifiant inconnu (tenant-isolation §4). Voir {@link AuthenticatedClient}.
   *
   * La doctrine précédente autorisait l'appel sur la seule **connaissance de
   * l'identifiant**, au motif qu'un UUID v4 ne se devine pas. C'est vrai, et
   * c'est hors sujet : les identifiants qui ont servi à contourner cette route
   * n'ont pas été devinés, ils ont été **lus** — par un praticien, dans le
   * journal des envois de son salon.
   *
   * Ce que cette route ne permet toujours pas, et c'est ce qui la borne : elle
   * ne change ni la prestation, ni la cliente, ni le prix.
   */
  @Post(':appointmentId/reschedule')
  @AuthenticatedClient()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reporter un rendez-vous vers un autre créneau' })
  @ApiParam({
    name: 'appointmentId',
    format: 'uuid',
    description: 'Le rendez-vous à déplacer, tel que l’écran de confirmation l’a rendu.',
  })
  // Déclaré explicitement : le corps est validé par le contrat partagé et le
  // paramètre est typé par un alias de type, dont `@nestjs/swagger` ne peut plus
  // rien déduire. `RescheduleAppointmentDto` ne sert plus qu'à cela (ADR 0008).
  @ApiBody({ type: RescheduleAppointmentDto })
  @ApiCreatedResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description:
      'Établissement ou rendez-vous introuvable, prestation retirée du catalogue, ' +
      'ou rendez-vous qui n’est pas celui de la cliente authentifiée — les quatre ' +
      'sont indiscernables à dessein (#1135).',
  })
  @ApiConflictResponse({
    description:
      'Le créneau d’arrivée n’est pas — ou n’est plus — réservable (`SLOT_NO_LONGER_AVAILABLE`), ' +
      'ou le rendez-vous vient d’être modifié par ailleurs (`CONFLICT`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Rendez-vous terminé, déjà annulé ou no-show — plus rien à déplacer ' +
      '(`INVALID_STATE_TRANSITION`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota de reports dépassé pour cette adresse.' })
  public async reschedule(
    // `ParseUUIDPipe` pour la raison qu'expose `ServicesController` : un
    // identifiant mal formé est un 400 nommant le paramètre, jamais une requête
    // qui descend jusqu'au pilote PostgreSQL pour en revenir en 500.
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    // Le type est celui **du contrat**, jamais `RescheduleAppointmentDto` : la
    // classe n'a plus de décorateur `class-validator`, et la typer ici ferait
    // rejouer le `ValidationPipe` global, dont le `whitelist` viderait le corps
    // de ses deux champs (ADR 0008).
    @Body(rescheduleAppointmentBody) body: RescheduleAppointmentBody,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppointmentDto> {
    return this.appointments.reschedule({
      appointmentId,
      // Du jeton vérifié, jamais du chemin ni du corps : il n'y a aucun champ
      // par lequel désigner une autre cliente, et c'est ce qui rend l'omission
      // exécutoire (tenant-isolation §2).
      client: { userId: user.userId },
      // La chaîne a été validée **et normalisée en UTC** par
      // `offsetDateTimeSchema` : `new Date` ne peut donc produire ici ni une
      // date invalide, ni un instant lu dans le fuseau de la machine.
      startsAt: new Date(body.startsAt),
      // Le contrat distingue « absent » de « vide » ; le domaine ne connaît que
      // `null`, qui se lit « le même praticien qu'avant ».
      staffId: body.staffId ?? null,
    });
  }

  /**
   * Annule un rendez-vous — **côté cliente** (#40).
   *
   * **200 et non 201** : rien n'est créé. Un rendez-vous change d'état, et le
   * corps rend ce rendez-vous-là, au statut `CANCELLED`, avec `cancelledAt` et
   * `cancelledBy` posés. C'est ce qui permet à l'écran de confirmation
   * d'afficher l'annulation sans avoir à relire quoi que ce soit.
   *
   * Le créneau est **déjà réservable** quand cette réponse part : la ligne a
   * quitté le filtre partiel de la contrainte d'exclusion au `COMMIT` — c'est le
   * troisième critère de #40, et il ne coûte aucune écriture supplémentaire.
   *
   * **404** couvre le rendez-vous inconnu **et** celui d'un autre établissement :
   * les deux doivent être indiscernables, faute de quoi cette route devient une
   * sonde d'existence (tenant-isolation §4).
   *
   * **422 `INVALID_STATE_TRANSITION`** quand le rendez-vous est terminé, déjà
   * annulé ou marqué no-show — il n'y a plus rien à annuler. Le refus vient
   * d'`AppointmentLifecycleService`, jamais de ce contrôleur : c'est le
   * quatrième critère du ticket.
   *
   * **409 `CONFLICT`** dans le seul cas où deux annulations se croisent, et où
   * la seconde arrive après que la première a inscrit son auteur et son motif.
   * Un simple double clic ne produit pas cela — il produit un 422, le rendez-vous
   * étant déjà annulé quand la seconde requête le relit.
   *
   * **429** au-delà de dix annulations par minute et par adresse. Même quota et
   * même raison que la réservation : cette route écrit dans l'agenda du salon, et
   * un script qui annulerait en boucle les rendez-vous dont il aurait deviné les
   * identifiants ferait bien plus de dégâts qu'un script qui réserve.
   *
   * ## La garde, depuis #1135
   *
   * **401** sans jeton, **403** avec un jeton qui n'est pas celui d'une cliente,
   * **404** quand le rendez-vous n'est pas le sien. Voir
   * {@link AuthenticatedClient}.
   *
   * C'est le défaut que ce ticket corrige, et il avait deux moitiés. La première
   * est un contournement de périmètre : un praticien relevait dans le journal
   * des envois de son salon les `appointmentId` de ses collègues, et annulait
   * par ici ce que `POST /appointments/{id}/cancel` lui refusait en 403
   * `OWN_SCOPE_ONLY` (#812). La seconde est une **trace fausse** : l'annulation
   * s'inscrivait `cancelledBy: CLIENT`, et le registre du salon accusait donc la
   * cliente d'un geste qu'elle n'avait pas fait — en faussant du même coup le
   * seul chiffre que cette colonne existe pour établir (CDC §1.4).
   *
   * La valeur `CLIENT` est désormais vraie **par construction** : le type
   * d'entrée du service ne la laisse écrire qu'en nommant la cliente d'un jeton
   * vérifié, et le service refuse le rendez-vous qui n'est pas le sien.
   *
   * Ce que cette route ne permet donc toujours pas : elle n'apprend **rien** à
   * qui n'est pas la cliente du rendez-vous — un identifiant inconnu, celui
   * d'un autre salon et celui d'une autre cliente rendent le même 404 — et elle
   * n'écrit que `CANCELLED`, un état dont on ne revient pas mais qui ne déplace
   * ni argent ni donnée personnelle.
   */
  @Post(':appointmentId/cancel')
  @AuthenticatedClient()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Annuler son rendez-vous' })
  @ApiParam({
    name: 'appointmentId',
    format: 'uuid',
    description: 'Le rendez-vous à annuler, tel que l’écran de confirmation l’a rendu.',
  })
  @ApiOkResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiNotFoundResponse({
    description:
      'Établissement ou rendez-vous introuvable, ou rendez-vous qui n’est pas celui ' +
      'de la cliente authentifiée — les trois sont indiscernables à dessein (#1135).',
  })
  @ApiConflictResponse({
    description: 'Le rendez-vous vient d’être modifié par ailleurs (`CONFLICT`).',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Rendez-vous terminé, déjà annulé ou no-show — plus rien à annuler ' +
      '(`INVALID_STATE_TRANSITION`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Quota d’annulations dépassé pour cette adresse.' })
  @ApiBody({ type: CancelAppointmentDto })
  public async cancel(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Body(cancelAppointmentBody) body: CancelAppointmentBody,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppointmentDto> {
    return this.appointments.cancel({
      appointmentId,
      // Fixé par la **porte**, jamais lu du corps : c'est la cliente qui annule
      // ici, et rien de ce qu'elle envoie ne peut le dire autrement. Depuis
      // #1135, la valeur ne s'écrit qu'en nommant la cliente ci-dessous — le
      // type d'entrée du service en fait une union, et la branche `CLIENT`
      // exige `client`.
      cancelledBy: 'CLIENT',
      // Du jeton vérifié, jamais du chemin ni du corps. Le service refuse en
      // 404 le rendez-vous qui n'est pas le sien.
      client: { userId: user.userId },
      // Le contrat distingue « absent » de « vide » ; le domaine ne connaît que
      // `null`, qui se lit « aucun motif donné ». Un motif réduit à rien par
      // l'élagage compte pour absent — voir `toCancellationReason`.
      reason: toCancellationReason(body),
    });
  }
}
