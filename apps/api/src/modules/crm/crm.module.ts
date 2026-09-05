import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { ClientDirectoryService } from './client-directory.service';
import { CrmRepository } from './crm.repository';
import { CustomerHistoryService } from './customer-history.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * Module `crm` — fiches clientes, coordonnées, notes internes, historique de
 * visites (CDC §2.3, #56).
 *
 * ## Ce qu'il importe
 *
 * `IdentityModule`, et seulement pour ses **gardes** : `@AuthAtLeast(...)` monte
 * `JwtAuthGuard` et `RolesGuard`, qui ont des dépendances à injecter. C'est la
 * voie prévue par api-module §3 — un appel de service, jamais un import du
 * repository d'un autre module. Rien ici n'atteint `IdentityRepository`, et rien
 * ne le doit : c'est `CrmRepository` qui lit la clientèle, avec sa propre
 * projection et son propre filtre de rôle.
 *
 * Rien d'`AppointmentsModule` non plus, alors que l'historique lit des
 * rendez-vous. C'est délibéré, et argumenté en tête de `crm.repository.ts` :
 * l'historique est une **projection en lecture seule** qui ne décide d'aucune
 * règle de cycle de vie, et importer le module aurait couplé `crm` au cycle de
 * vie du rendez-vous pour n'en tirer qu'une somme et un compteur.
 *
 * ## Ce qu'il exporte, et ce qu'il continue de garder
 *
 * `ClientDirectoryService`, et **rien d'autre** (#313).
 *
 * C'est la porte par laquelle `appointments` obtient la fiche d'une cliente qui
 * réserve sans compte. Elle a été ouverte parce que la table des fiches est celle
 * de ce module : jusqu'à #313, `AppointmentsRepository` écrivait lui-même dans
 * `users`, faute de porte — la table d'un autre domaine écrite par un module qui
 * ne la possède pas, ce qu'api-module §3 n'admet pas.
 *
 * Ce qu'elle laisse passer est étroit à dessein : un identifiant de fiche, jamais
 * une fiche. Pas de nom, pas d'adresse, pas de téléphone, pas de note interne, et
 * aucune lecture du fichier client. `CustomersService`, `CustomerHistoryService`
 * et `CrmRepository` restent hors du graphe des autres modules : un module qui
 * voudrait **afficher** une cliente n'a toujours aucun chemin pour cela, et c'est
 * la propriété que ce module tient depuis #56.
 *
 * `notifications` joindra un destinataire par la ligne `users` que `identity`
 * connaît déjà, et `reporting` agrège des rendez-vous et des paiements, pas des
 * fiches : aucun des deux n'a de raison d'emprunter cette porte.
 *
 * ## Aucun contrôleur public
 *
 * Le fichier client n'a **aucune** surface non authentifiée. C'est la propriété
 * la plus importante de ce module : il ne contient que des données personnelles,
 * et la moindre route publique — même en lecture, même bornée — serait un
 * annuaire de la clientèle d'un salon offert à qui connaît son slug.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerHistoryService, ClientDirectoryService, CrmRepository],
  exports: [ClientDirectoryService],
})
export class CrmModule {}
