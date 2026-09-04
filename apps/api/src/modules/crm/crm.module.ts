import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
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
 * ## Ce qu'il n'exporte pas, et pourquoi
 *
 * Rien. Aucun autre module du périmètre MVP n'a de décision à prendre sur une
 * fiche cliente : `appointments` désigne son client par un identifiant que
 * l'authentification lui donne, `notifications` joindra un destinataire par la
 * ligne `users` que `identity` connaît déjà, et `reporting` agrège des
 * rendez-vous et des paiements, pas des fiches. Un `exports` posé « au cas où »
 * ouvrirait une porte que personne ne franchit et qu'il faudrait pourtant
 * maintenir.
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
  providers: [CustomersService, CustomerHistoryService, CrmRepository],
})
export class CrmModule {}
