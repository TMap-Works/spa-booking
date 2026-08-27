import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { AvailabilityRepository } from './availability.repository';
import { ClosingDaysController } from './closing-days.controller';
import { ClosingDaysService } from './closing-days.service';
import { StaffScheduleController } from './staff-schedule.controller';
import { StaffScheduleService } from './staff-schedule.service';
import { TenantClockService } from './tenant-clock.service';

/**
 * Module `availability` — créneaux libres, horaires du staff, plages bloquées
 * (CDC §2.3).
 *
 * ## Ce qu'il contient aujourd'hui
 *
 * L'horloge de l'établissement (#41) et les **horaires récurrents du personnel**
 * (#32) : la semaine de travail d'un praticien, les jours de fermeture de
 * l'établissement, et la conversion de ces heures murales en fenêtres de travail
 * UTC. Le calcul de créneaux (#34), l'option premier disponible (#36) et les
 * plages bloquées (#33) ne sont pas écrits, et rien ici ne les préempte.
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
 *
 * `ClosingDaysService` n'est pas exporté : les jours de fermeture entrent déjà
 * dans le calcul des fenêtres, et un module n'a pas à choisir entre plusieurs
 * portes pour la même information. `AvailabilityRepository` reste privé — un
 * module n'importe jamais celui d'un autre.
 *
 * ## Pourquoi ce module apparaît maintenant dans `AppModule`
 *
 * #41 l'avait délibérément laissé hors du graphe : il n'ouvrait aucune route, et
 * l'enregistrer sans besoin aurait fait porter à `AppModule` — fichier que
 * plusieurs tickets du jalon S2 modifient en parallèle — un conflit sans
 * contrepartie. #32 est le premier consommateur : il apporte quatre routes, donc
 * la raison d'enregistrer le module.
 */
@Module({
  imports: [IdentityModule],
  controllers: [StaffScheduleController, ClosingDaysController],
  providers: [TenantClockService, StaffScheduleService, ClosingDaysService, AvailabilityRepository],
  exports: [TenantClockService, StaffScheduleService],
})
export class AvailabilityModule {}
