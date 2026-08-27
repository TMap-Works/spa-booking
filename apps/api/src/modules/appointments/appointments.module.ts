import { Module } from '@nestjs/common';

import { AppointmentsRepository } from './appointments.repository';

/**
 * Module `appointments` — cycle de vie du rendez-vous (CDC §2.3).
 *
 * ## Ce qu'il contient aujourd'hui, et pourquoi si peu
 *
 * #31 ne livre pas d'endpoint : il livre la **garantie** qui les tiendra tous.
 * La contrainte `appointments_no_overlap` vit en base, et ce module n'en porte
 * que la traduction — `AppointmentsRepository.create`, qui écrit sans vérifier
 * d'abord et convertit le refus de PostgreSQL en `SlotNoLongerAvailableError`.
 *
 * Le service, les DTO et `POST /api/v1/appointments` appartiennent à #37 ; le
 * report à #39, l'annulation à #40. Découper ainsi n'est pas une commodité : la
 * garantie anti-double-réservation est le risque n°1 du projet (CDC §6), et elle
 * mérite d'être posée, relue et prouvée pour elle-même plutôt que noyée dans le
 * diff d'un contrôleur.
 *
 * ## Pourquoi il n'est pas encore importé par `AppModule`
 *
 * Un module sans contrôleur n'expose rien : l'enregistrer ne changerait aucun
 * comportement observable, et `app.module.ts` est hors de l'empreinte de ce
 * ticket — d'autres tickets de la même vague y touchent. C'est #37 qui l'y
 * inscrira, en même temps que le contrôleur qui lui donne une surface. D'ici là,
 * le repository s'exerce directement contre un vrai moteur
 * (`test/appointments-exclusion.integration-spec.ts`), ce qui est de toute façon
 * le seul endroit où la contrainte se prouve.
 *
 * ## Ce qu'il exporte, et jusqu'à quand
 *
 * `AppointmentsRepository`, faute de service à exporter à sa place. C'est
 * transitoire et cela doit le rester : un module n'importe jamais le repository
 * d'un autre (api-module §3). Dès que #37 aura posé `AppointmentsService`,
 * c'est lui que ce module exportera, et le repository redeviendra privé.
 */
@Module({
  providers: [AppointmentsRepository],
  exports: [AppointmentsRepository],
})
export class AppointmentsModule {}
