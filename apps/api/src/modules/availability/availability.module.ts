import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import {
  AVAILABILITY_CACHE_STORE,
  AvailabilityCacheService,
  UnwiredAvailabilityCacheStore,
} from './availability-cache';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { ClosingDaysController } from './closing-days.controller';
import { ClosingDaysService } from './closing-days.service';
import { StaffScheduleController } from './staff-schedule.controller';
import { StaffScheduleService } from './staff-schedule.service';
import { StaffTimeOffController } from './staff-time-off.controller';
import { StaffTimeOffRepository } from './staff-time-off.repository';
import { StaffTimeOffService } from './staff-time-off.service';
import { TenantClockService } from './tenant-clock.service';

/**
 * Module `availability` — créneaux libres, horaires du staff, plages bloquées
 * (CDC §2.3).
 *
 * ## Ce qu'il contient aujourd'hui
 *
 * L'horloge de l'établissement (#41), les **horaires récurrents du personnel**
 * (#32) — la semaine de travail d'un praticien, les jours de fermeture, et la
 * conversion de ces heures murales en fenêtres de travail UTC — et les **plages
 * bloquées et congés** (#33), qui en sont l'envers : les premiers disent quand
 * le praticien travaille, les secondes quand il est absent.
 *
 * Les deux se composent sans se connaître, et c'est voulu : `StaffTimeOff` ne
 * référence aucun horaire récurrent, si bien qu'une absence se pose sans avoir à
 * savoir si le praticien devait travailler ce jour-là. C'est le **calcul de
 * créneaux** (#34) qui les réunit — `StaffScheduleService.windowsForMany` lui
 * donne les fenêtres, `StaffTimeOffService.busyRanges` et
 * `AvailabilityRepository.listBookedRanges` les intervalles à en retrancher,
 * `availability.intervals.ts` la soustraction et `availability.slots.ts` le
 * découpage.
 *
 * ## Ce que #34 pose, et ce qu'il laisse à ses voisins
 *
 * `AvailabilityService` calcule ; il n'expose rien. Aucune route n'est ajoutée
 * ici, et `AVAILABILITY_CACHE_STORE` reste branché sur son entrepôt inerte :
 * `GET /api/v1/availability`, la clé de cache et son invalidation sont les
 * critères de **#35**, et l'option premier disponible ceux de **#36**. Découper
 * ainsi suit le précédent de #31, qui a livré la contrainte anti-double-réservation
 * sans l'endpoint qui s'en sert — la mécanique se relit et se prouve mieux seule
 * que noyée dans le diff d'un contrôleur.
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, et seulement pour ses **gardes** : `@AuthAtLeast(...)` monte
 * `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter. C'est la
 * voie prévue par api-module §3 — un appel de service, jamais un import du
 * repository d'un autre module. Rien ici n'atteint `IdentityRepository`.
 *
 * `CatalogModule`, pour `ServicesService` : le calcul de créneaux a besoin de la
 * durée d'une prestation et de ses deux tampons, et c'est la porte que le
 * catalogue a explicitement ouverte pour lui. La liste de ses praticiens, elle,
 * n'y passe pas — `ServiceStaffService` reste privé, et rendre publique la
 * surface d'un autre module relève de ce module-là ; `AvailabilityRepository`
 * lit donc `service_staff` comme il lit déjà `staff`, sans en être propriétaire.
 *
 * ## Ce qu'il exporte, et pourquoi
 *
 * - `TenantClockService`, la frontière heure locale ↔ UTC, que tout module ayant
 *   à afficher une heure consommera (notifications, reporting).
 * - `AvailabilityService`, le calcul lui-même : #35 l'exposera derrière une
 *   route et un cache, #36 y ajoutera sa règle d'affectation, et la création de
 *   rendez-vous (#37) s'en sert pour placer un soin dans l'agenda.
 * - `StaffScheduleService`, pour ses fenêtres de travail — un appel de service,
 *   la première des deux voies autorisées entre modules.
 * - `StaffTimeOffService`, pour `busyRanges`, la lecture symétrique : les
 *   intervalles à retrancher de ces fenêtres. Sa projection ne charge **pas** le
 *   motif de l'absence — ce qui n'est pas lu ne peut pas fuiter jusqu'à une page
 *   publique.
 *
 * `ClosingDaysService` n'est pas exporté : les jours de fermeture entrent déjà
 * dans le calcul des fenêtres, et un module n'a pas à choisir entre plusieurs
 * portes pour la même information. Les deux repositories restent privés — un
 * module n'importe jamais celui d'un autre.
 *
 * ## Deux repositories plutôt qu'un
 *
 * `AvailabilityRepository` sert les horaires récurrents et les jours de
 * fermeture ; `StaffTimeOffRepository` sert les absences. Les tables sont
 * autonomes et lues par des chemins qui n'ont rien en commun — le planning de
 * back-office d'un côté, le moteur de créneaux de l'autre. Les réunir
 * n'apporterait qu'un fichier plus long à relire.
 *
 * ## L'entrepôt de cache
 *
 * `AVAILABILITY_CACHE_STORE` est lié à `UnwiredAvailabilityCacheStore` : il
 * n'existe aujourd'hui aucune clé `avail:*` en Redis. #34 calcule les créneaux
 * mais ne les met pas en cache — la clé, son TTL et son invalidation sont trois
 * des cinq critères de **#35**, avec l'endpoint qui les rend observables. Ce que
 * #33 garantit reste vrai et sert d'accroche : le chemin d'écriture des absences
 * **appelle** déjà l'invalidation, le point qui s'oublie et qui ne se rattrape
 * pas. #35 remplace cette ligne, et rien d'autre.
 *
 * ## Pourquoi ce module apparaît dans `AppModule`
 *
 * #41 l'avait délibérément laissé hors du graphe : il n'ouvrait aucune route, et
 * l'enregistrer sans besoin aurait fait porter à `AppModule` — fichier que
 * plusieurs tickets du jalon S2 modifient en parallèle — un conflit sans
 * contrepartie. #32 est le premier consommateur : il apporte quatre routes, donc
 * la raison d'enregistrer le module. #33 en ajoute quatre autres sans avoir à
 * toucher `AppModule`.
 */
@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [StaffScheduleController, ClosingDaysController, StaffTimeOffController],
  providers: [
    TenantClockService,
    AvailabilityService,
    StaffScheduleService,
    ClosingDaysService,
    AvailabilityRepository,
    StaffTimeOffService,
    StaffTimeOffRepository,
    AvailabilityCacheService,
    { provide: AVAILABILITY_CACHE_STORE, useClass: UnwiredAvailabilityCacheStore },
  ],
  exports: [TenantClockService, AvailabilityService, StaffScheduleService, StaffTimeOffService],
})
export class AvailabilityModule {}
