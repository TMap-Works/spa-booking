import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { AVAILABILITY_CACHE_STORE, AvailabilityCacheService } from './availability-cache';
import { RedisAvailabilityCacheStore } from './availability-cache.redis';
import { AvailabilityController } from './availability.controller';
import { AvailabilityQueryService } from './availability.query.service';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { ClosingDaysController } from './closing-days.controller';
import { PublicAvailabilityController } from './public-availability.controller';
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
 * ## Ce que #35 pose, et ce qu'il laisse à ses voisins
 *
 * #34 avait livré le calcul sans surface : il calculait, il n'exposait rien.
 * #35 pose les deux routes qui le servent — celle du back-office et celle du
 * tunnel —, branche `AVAILABILITY_CACHE_STORE` sur Redis et étend
 * l'invalidation à toutes les écritures d'agenda. L'option premier disponible
 * reste à **#36**, et le verrou de saisie à **#38**.
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
 * - `AvailabilityService`, le calcul lui-même, **sans cache** : #36 y ajoutera
 *   sa règle d'affectation, et la création de rendez-vous (#37) s'en sert pour
 *   placer un soin dans l'agenda. C'est délibérément le moteur nu qui sort
 *   d'ici, jamais `AvailabilityQueryService` — voir la section sur le cache.
 * - `AvailabilityCacheService`, pour son **invalidation** seule : `appointments`
 *   écrit dans l'agenda, donc il doit chasser le cache du tenant. La lecture,
 *   elle, ne l'intéresse pas.
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
 * ## L'entrepôt de cache, et la frontière que ce module tient
 *
 * `AVAILABILITY_CACHE_STORE` est lié à `RedisAvailabilityCacheStore` depuis #35.
 * #33 avait posé le port et fait appeler l'invalidation par le chemin d'écriture
 * des absences — le point qui s'oublie et qui ne se rattrape pas ; #35 n'a eu
 * qu'à remplacer la ligne, ce qui était l'objet du découpage.
 *
 * **Deux services de lecture, et un seul est caché.** `AvailabilityQueryService`
 * lit le cache et sert les deux routes ; `AvailabilityService` calcule à froid
 * et sert `appointments`. Ce module n'exporte que le second : c'est ce qui rend
 * le cinquième critère de #35 vrai par construction — un cache périmé ne peut
 * pas provoquer de double réservation, puisque le chemin d'écriture ne peut pas
 * l'atteindre. Le jour où quelqu'un exporterait `AvailabilityQueryService`, la
 * garantie tomberait ; c'est pourquoi elle est écrite ici et vérifiée par
 * `availability.module.spec.ts`.
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
  controllers: [
    AvailabilityController,
    PublicAvailabilityController,
    StaffScheduleController,
    ClosingDaysController,
    StaffTimeOffController,
  ],
  providers: [
    TenantClockService,
    AvailabilityService,
    AvailabilityQueryService,
    StaffScheduleService,
    ClosingDaysService,
    AvailabilityRepository,
    StaffTimeOffService,
    StaffTimeOffRepository,
    AvailabilityCacheService,
    { provide: AVAILABILITY_CACHE_STORE, useClass: RedisAvailabilityCacheStore },
  ],
  exports: [
    TenantClockService,
    AvailabilityService,
    AvailabilityCacheService,
    StaffScheduleService,
    StaffTimeOffService,
  ],
})
export class AvailabilityModule {}
