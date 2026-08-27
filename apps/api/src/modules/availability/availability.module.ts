import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import {
  AVAILABILITY_CACHE_STORE,
  AvailabilityCacheService,
  UnwiredAvailabilityCacheStore,
} from './availability-cache';
import { AvailabilityRepository } from './availability.repository';
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
 * savoir si le praticien devait travailler ce jour-là. C'est le calcul de
 * créneaux (#34) qui les réunit — `StaffScheduleService.windowsFor` lui donne
 * les fenêtres, `StaffTimeOffService.busyRanges` les intervalles à en retrancher,
 * et `availability.intervals.ts` la soustraction elle-même.
 *
 * Le calcul de créneaux (#34) et l'option premier disponible (#36) ne sont pas
 * écrits, et rien ici ne les préempte.
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, et seulement pour ses **gardes** : `@AuthAtLeast(...)` monte
 * `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter. C'est la
 * voie prévue par api-module §3 — un appel de service, jamais un import du
 * repository d'un autre module. Rien ici n'atteint `IdentityRepository`.
 *
 * ## Ce qu'il exporte, et pourquoi
 *
 * - `TenantClockService`, la frontière heure locale ↔ UTC, que tout module ayant
 *   à afficher une heure consommera (notifications, reporting).
 * - `StaffScheduleService`, pour sa seule méthode `windowsFor` : le calcul de
 *   créneaux (#34) a besoin des fenêtres de travail d'un praticien, et c'est un
 *   appel de service — la première des deux voies autorisées entre modules.
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
 * n'existe aujourd'hui aucune clé `avail:*` en Redis, puisque rien ne calcule
 * encore de créneaux. Ce que #33 garantit, c'est que le chemin d'écriture des
 * absences **appelle** l'invalidation — le point qui s'oublie et qui ne se
 * rattrape pas une fois le calcul de créneaux écrit ailleurs. Le jour où #34
 * pose son adaptateur Redis, il remplace cette ligne et rien d'autre.
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
  imports: [IdentityModule],
  controllers: [StaffScheduleController, ClosingDaysController, StaffTimeOffController],
  providers: [
    TenantClockService,
    StaffScheduleService,
    ClosingDaysService,
    AvailabilityRepository,
    StaffTimeOffService,
    StaffTimeOffRepository,
    AvailabilityCacheService,
    { provide: AVAILABILITY_CACHE_STORE, useClass: UnwiredAvailabilityCacheStore },
  ],
  exports: [TenantClockService, StaffScheduleService, StaffTimeOffService],
})
export class AvailabilityModule {}
