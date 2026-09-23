import { Injectable } from '@nestjs/common';

import type { ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
// Import **de valeur** et non `import type` : Nest lit le type du paramètre de
// constructeur dans les métadonnées émises par TypeScript, et un `import type`
// s'efface à la compilation — l'injection échouerait alors au démarrage.
import { CrmRepository } from './crm.repository';

/**
 * Une transaction Prisma en cours, telle que le corps d'un `$transaction`
 * interactif la reçoit.
 *
 * Les six membres retirés sont exactement ceux de `ITXClientDenyList` du runtime
 * Prisma — ceux qu'un client de transaction n'expose pas. Ils sont écrits en
 * clair plutôt qu'importés de `@prisma/client/runtime/library`, qui n'est pas une
 * surface publique du paquet : la liste est figée depuis longtemps, et un
 * décalage se verrait à la compilation du premier `$transaction` qui passe une
 * portée à cette signature.
 *
 * Le client est le **scopé** : l'extension de tenant s'applique aux opérations
 * d'une transaction comme à celles d'un client nu. C'est ce qui fait qu'aucune
 * ligne écrite ou lue ici ne peut sortir de l'établissement courant, sans qu'un
 * `tenantId` ait à traverser cette signature (tenant-isolation §3).
 *
 * Avec une réserve, et il faut la dire : l'extension ne couvre pas le SQL brut
 * (ADR 0006). La lecture qui juge un rôle sous `FOR SHARE` — celle
 * d'`assertBookableWithin`, depuis #465 — descend au `$queryRaw` de cette portée
 * et écrit donc son propre `tenant_id = …`, lu du contexte de requête. La
 * frontière tient toujours, mais pour cette requête-là elle tient par
 * `requireTenantId` et non par l'extension ; le détail est dans `CrmRepository`.
 */
export type ClientDirectoryScope = Omit<
  ScopedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * La porte du fichier client pour les **autres modules** — la seule (#313).
 *
 * Elle n'a plus qu'un battant depuis #1222, et un seul propos :
 * `assertBookableWithin` confirme qu'une fiche désignée en est bien une. Elle ne
 * rend qu'un identifiant, elle travaille dans la transaction de l'appelant, et
 * elle existe pour qu'aucun module voisin n'ait à connaître `users.role`.
 *
 * ## Ce qu'elle existe pour supprimer
 *
 * `AppointmentsRepository.findOrCreateClient` écrivait lui-même dans `users` :
 * `appointments.client_id` est `NOT NULL`, il fallait bien une fiche, et ni `crm`
 * ni `identity` n'ouvraient de porte pour en obtenir une. C'était la table d'un
 * autre domaine écrite par un module qui ne la possède pas — ce qu'api-module §3
 * n'admet pas.
 *
 * Cette écriture-là n'existe plus du tout : réserver exige un compte depuis la
 * décision PO du 22/09/2026 (#1136), les deux surfaces désignent une fiche, et
 * le second battant — `resolveWithin`, qui résolvait des coordonnées et créait
 * au besoin — est parti avec le champ `client` du contrat (#1222). Ce qui reste
 * ici **juge**, et n'écrit rien.
 *
 * ## Pourquoi cette porte prend une transaction, alors qu'un service ignore Prisma
 *
 * C'est l'entorse à api-module §2, et elle est le prix d'un jugement qui ne vaut
 * que là où il est rendu : un rôle lu hors de la transaction d'insertion, ou
 * sans verrou de ligne, serait périmé avant d'avoir servi — une fiche promue au
 * personnel entre le contrôle et l'`INSERT` passerait. C'est la « vérification
 * applicative suivie d'un `INSERT` » que booking-engine §1 interdit, et la seule
 * façon d'y échapper est que le contrôle et l'écriture partagent une
 * transaction, qu'une transaction Prisma ne transmet que par son client.
 *
 * Trois précautions bornent l'entorse :
 *
 * 1. la portée est **opaque** ici — ce fichier ne l'ouvre pas, ne la valide pas,
 *    ne la referme pas ; il la transmet. C'est `AppointmentsRepository` qui
 *    l'ouvre, parce que c'est lui qui porte le verrou consultatif d'agenda, la
 *    contrainte d'exclusion et la boucle de réessai (ADR 0006) ;
 * 2. le **SQL reste dans le dépôt** : `CrmRepository.assertClientBookableWithin`
 *    est le seul à nommer une table et un rôle ;
 * 3. rien de `crm` ne sort par là. La porte rend un identifiant, jamais une fiche
 *    — pas de nom, pas d'adresse, pas de note interne. Un module voisin ne peut
 *    donc pas s'en servir pour lire la clientèle.
 *
 * ## Ce que cette porte n'ouvre pas
 *
 * La **lecture** du fichier client. `CrmModule` n'exporte ni `CustomersService`,
 * ni `CustomerHistoryService`, ni `CrmRepository` : un module qui voudrait
 * afficher une cliente n'a toujours aucun chemin pour cela, et c'est voulu — le
 * fichier client ne se lit que par ses propres routes, gardées.
 */
@Injectable()
export class ClientDirectoryService {
  public constructor(private readonly repository: CrmRepository) {}

  /**
   * Confirme qu'un identifiant désigne une fiche **du fichier client** de
   * l'établissement courant, **dans la transaction donnée**, et le rend (#465).
   *
   * La seule porte de ce service depuis #1222 : elle part d'une fiche que
   * l'appelant a désignée — le compte du jeton au tunnel, celle que l'opérateur
   * a choisie au comptoir — et ne crée jamais rien. Elle répond à la question
   * « cette réservation peut-elle se rattacher à cette ligne ? », elle la pose
   * dans la transaction d'insertion, et elle ne laisse sortir qu'un identifiant.
   *
   * ## Ce que cette porte referme
   *
   * `appointments.client_id` référence `users`, dont les comptes `STAFF`,
   * `MANAGER` et `ADMIN` font partie. Les deux clés étrangères composites jugent
   * l'existence de la fiche et son établissement, jamais son **rôle** : un membre
   * du personnel qui posait l'identifiant d'un collègue obtenait un rendez-vous
   * valide dont la cliente était un employé. Le tunnel public refusait déjà ce
   * cas depuis #313, par une porte qui ne résolvait que des `CLIENT` ; le
   * comptoir **désignait** au lieu de résoudre, et ne traversait donc rien.
   * Depuis #1136 les deux surfaces désignent, et passent toutes deux par ici.
   *
   * ## Pourquoi elle rend l'identifiant plutôt que `void`
   *
   * Pour qu'`appointments` écrive sur sa ligne un identifiant **vérifié**, obtenu
   * d'une porte de `crm`, et jamais celui qu'il détenait. Un `void` l'aurait
   * laissé réutiliser sa propre variable, et un refactor futur aurait pu perdre
   * l'appel sans que rien ne change de type.
   *
   * ## Ce qu'elle n'ouvre toujours pas
   *
   * La **lecture** du fichier client. Elle rend un identifiant que l'appelant
   * détenait déjà, ou lève. Elle n'apprend rien de la fiche — ni nom, ni adresse,
   * ni note interne — et ne peut donc pas servir à parcourir la clientèle.
   *
   * @throws {NotFoundError} l'identifiant ne désigne aucune fiche cliente de cet
   * établissement — inconnu, du salon voisin, ou compte du personnel. Le même
   * 404 dans les trois cas, délibérément : voir `assertClientBookableWithin`.
   */
  public async assertBookableWithin(
    scope: ClientDirectoryScope,
    clientId: string,
  ): Promise<string> {
    return this.repository.assertClientBookableWithin(scope, clientId);
  }
}
