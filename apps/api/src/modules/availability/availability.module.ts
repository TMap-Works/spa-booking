import { Module } from '@nestjs/common';

import { TenantClockService } from './tenant-clock.service';

/**
 * Module `availability` — créneaux libres, horaires du staff, plages bloquées
 * (CDC §2.3).
 *
 * ## Ce qu'il contient aujourd'hui
 *
 * L'horloge de l'établissement, et rien d'autre. #41 pose la frontière heure
 * locale ↔ UTC sur laquelle tout le reste du module reposera : le calcul de
 * créneaux (#31), les horaires récurrents du personnel (#32) et les plages
 * bloquées ne sont pas encore écrits, et rien ici ne les préempte.
 *
 * ## Pourquoi aucun contrôleur
 *
 * #41 n'ouvre **aucune route**. La conversion de fuseau n'est pas une ressource
 * qu'on interroge, c'est une règle que les autres endpoints appliquent. Exposer
 * un `/api/v1/availability/convert` ferait de la mécanique interne un contrat
 * public à maintenir, sans qu'aucun écran du MVP ne le consomme.
 *
 * ## Ce qu'il exporte
 *
 * `TenantClockService`, la seule porte d'entrée du module vers l'extérieur — un
 * appel de service, jamais un import de fichier profond (api-module §3). Le
 * module n'importe rien : l'horloge ne dépend ni du catalogue, ni de l'identité,
 * ni de la base. Le fuseau du tenant lui est passé en argument, ce qui la rend
 * utilisable aussi bien sous requête HTTP scopée que depuis un traitement
 * planifié inter-établissements.
 *
 * ## Branchement dans `AppModule`
 *
 * Délibérément non fait par #41 : le module n'a encore aucun consommateur, et
 * l'enregistrer sans besoin ferait porter à `AppModule` — fichier que plusieurs
 * tickets du jalon S2 modifient en parallèle — un conflit sans contrepartie.
 * C'est le premier consommateur (#31 ou #32) qui l'importera, en même temps que
 * le contrôleur qui le justifie.
 */
@Module({
  providers: [TenantClockService],
  exports: [TenantClockService],
})
export class AvailabilityModule {}
