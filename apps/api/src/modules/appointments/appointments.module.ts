import { Module } from '@nestjs/common';

import { AvailabilityModule } from '../availability/availability.module';
import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { AppointmentLifecycleService } from './appointment-lifecycle.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsRepository } from './appointments.repository';
import { AppointmentsService } from './appointments.service';
import { AppointmentEvents } from './events/appointment-events';
import { PublicAppointmentsController } from './public-appointments.controller';

/**
 * Module `appointments` — cycle de vie du rendez-vous (CDC §2.3).
 *
 * ## Ce qu'il contient
 *
 * #31 a posé la **garantie** : la contrainte `appointments_no_overlap` vit en
 * base, et `AppointmentsRepository` n'en porte que la traduction — écrire sans
 * vérifier d'abord, convertir le refus de PostgreSQL en
 * `SlotNoLongerAvailableError`. #37 pose la surface qui s'en sert :
 * `AppointmentsService`, `PublicAppointmentsController` et l'événement de
 * domaine `appointment.created`. #39 y ajoute le **report** — une annulation et
 * une création liées par `rescheduled_from_id`, dans une seule transaction — et
 * l'événement `appointment.rescheduled` qui l'annonce. #40 pose l'**annulation**
 * — `AppointmentLifecycleService`, qui porte à lui seul la table des transitions
 * du cycle de vie, une route par côté du comptoir, et l'événement
 * `appointment.cancelled`.
 *
 * Le verrou Redis de saisie appartient à #38, la création au comptoir à #50.
 *
 * ## Ce qu'il importe, et pourquoi ces trois-là seulement
 *
 * - `CatalogModule`, pour `ServicesService` : la durée, les deux tampons et le
 *   prix d'une prestation. C'est la porte que le catalogue a explicitement
 *   ouverte pour ce module — un **appel de service**, la première des deux voies
 *   autorisées entre modules (api-module §3), jamais un import de son repository.
 * - `AvailabilityModule`, pour `AvailabilityService` : le contrôle « ce créneau
 *   était-il proposable ? ». Rejouer le moteur plutôt que réécrire ses six règles
 *   est ce qui empêche l'agenda affiché et l'agenda réservable de diverger. Son
 *   en-tête annonce d'ailleurs cet usage depuis #34.
 *
 * - `IdentityModule`, et **seulement pour ses gardes** : `@AuthAtLeast('STAFF')`
 *   monte `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter.
 *   C'est la même voie que `CatalogModule` emprunte, et rien ici n'atteint
 *   `IdentityRepository` — rien ne le doit.
 *
 * Cet import est arrivé avec #40 : jusque-là, toutes les routes du module
 * étaient publiques et sans garde, parce qu'on réserve sans compte. L'annulation
 * a ouvert la première surface de back-office — le comptoir annule pour une
 * cliente qui téléphone, et cela ne peut pas être une route ouverte.
 *
 * `AppointmentLifecycleService` est un fournisseur et non un module : c'est une
 * règle du domaine de ce module, pas une porte pour les autres.
 *
 * ## Ce qu'il exporte, et ce qu'il a cessé d'exporter
 *
 * `AppointmentsService` et `AppointmentEvents`. Le premier est la porte du
 * module ; le second est ce à quoi `notifications` (S4) s'abonnera pour envoyer
 * la confirmation et planifier le rappel J-1 — sans que ce module ait à savoir
 * qu'ils existent.
 *
 * `AppointmentsRepository` **n'est plus exporté**. #31 le faisait faute de
 * service à exporter à sa place, en annonçant que c'était transitoire : un module
 * n'importe jamais le repository d'un autre (api-module §3). La dette est
 * refermée ici.
 *
 * ## Pourquoi ce module apparaît maintenant dans `AppModule`
 *
 * #31 l'avait laissé hors du graphe : un module sans contrôleur n'expose rien, et
 * l'enregistrer aurait fait porter à `app.module.ts` — fichier que plusieurs
 * tickets du jalon S2 modifient en parallèle — un conflit sans contrepartie.
 * `POST /api/v1/public/:tenantSlug/appointments` est la raison qui manquait.
 */
@Module({
  imports: [CatalogModule, AvailabilityModule, IdentityModule],
  controllers: [PublicAppointmentsController, AppointmentsController],
  providers: [
    AppointmentsService,
    AppointmentsRepository,
    AppointmentEvents,
    AppointmentLifecycleService,
  ],
  exports: [AppointmentsService, AppointmentEvents],
})
export class AppointmentsModule {}
