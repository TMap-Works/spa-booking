import { Injectable } from '@nestjs/common';

import type { ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
// La **même** canonisation que `/auth/login`, que l'invitation du personnel et
// que `CustomersService.create`. La recopier créerait une seconde définition de
// « la même adresse », et c'est exactement ce que `@@unique([tenantId, email])`
// ne pardonne pas.
import { normalizeEmail } from '../identity/email';
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
 * (ADR 0006). Les deux lectures qui jugent un rôle sous `FOR SHARE` — celle de
 * `resolveWithin` depuis #468, celle d'`assertBookableWithin` depuis #465 —
 * descendent au `$queryRaw` de cette portée et écrivent donc leur propre
 * `tenant_id = …`, lu du contexte de requête. La frontière tient toujours, mais
 * pour ces deux requêtes elle tient par `requireTenantId` et non par
 * l'extension ; le détail est dans `CrmRepository`.
 */
export type ClientDirectoryScope = Omit<
  ScopedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Les coordonnées à partir desquelles une fiche se résout — ou se crée.
 *
 * C'est le vocabulaire de **cette porte**, et il est délibérément plus pauvre que
 * `CustomersService.create` : ni note interne, ni statut d'activité. Une
 * réservation en ligne n'a rien à écrire dans le dossier interne du salon, et un
 * champ ici l'aurait ouvert à un corps de requête public.
 */
export interface ClientContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
}

/**
 * La porte du fichier client pour les **autres modules** — la seule (#313).
 *
 * Elle a deux battants depuis #465, et un seul propos : `resolveWithin` obtient
 * une fiche à partir de coordonnées, `assertBookableWithin` confirme qu'une
 * fiche désignée en est bien une. Les deux ne rendent qu'un identifiant, les
 * deux travaillent dans la transaction de l'appelant, et les deux existent pour
 * qu'aucun module voisin n'ait à connaître `users.role`.
 *
 * ## Ce qu'elle existe pour supprimer
 *
 * `AppointmentsRepository.findOrCreateClient` écrivait lui-même dans `users` :
 * `appointments.client_id` est `NOT NULL`, il fallait bien une fiche, et ni `crm`
 * ni `identity` n'ouvraient de porte pour en obtenir une. C'était la table d'un
 * autre domaine écrite par un module qui ne la possède pas — ce qu'api-module §3
 * n'admet pas. L'écriture est ici désormais, et `appointments` la demande.
 *
 * ## Pourquoi cette porte prend une transaction, alors qu'un service ignore Prisma
 *
 * C'est l'entorse à api-module §2, et elle est le prix d'un critère qui ne se
 * satisfait pas autrement : **un 409 de créneau ne doit laisser aucune fiche
 * derrière lui**. Résoudre la cliente dans une transaction et poser le rendez-vous
 * dans une autre laisse, à chaque course perdue, une fiche publique sans
 * rendez-vous au fichier du salon. La seule façon d'y échapper est que les deux
 * écritures partagent une transaction, et une transaction Prisma ne se transmet
 * que par son client.
 *
 * Trois précautions bornent l'entorse :
 *
 * 1. la portée est **opaque** ici — ce fichier ne l'ouvre pas, ne la valide pas,
 *    ne la referme pas ; il la transmet. C'est `AppointmentsRepository` qui
 *    l'ouvre, parce que c'est lui qui porte le verrou consultatif d'agenda, la
 *    contrainte d'exclusion et la boucle de réessai (ADR 0006) ;
 * 2. le **SQL reste dans le dépôt** : `CrmRepository.resolveClientWithin` est le
 *    seul à nommer une table, un rôle et un code d'erreur Prisma ;
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
   * L'identifiant de la fiche cliente de ces coordonnées dans l'établissement
   * courant — trouvée, ou créée sans compte, **dans la transaction donnée**.
   *
   * La fiche créée n'a pas de `passwordHash` : elle existe pour être jointe à un
   * rendez-vous, pas pour ouvrir une session. C'est ce qui rend vrai « un client
   * peut réserver sans compte, avec seulement ses coordonnées » (#37), et c'est
   * la même fiche inconnectable que la saisie au comptoir produit.
   *
   * ## L'adresse est canonisée ici, et pas seulement par l'appelant
   *
   * Le DTO du tunnel public le fait déjà (`@NormalizeEmail`), et cette porte le
   * refait : elle est ouverte à tout module, et l'unicité `(tenant_id, email)`
   * porte sur les octets. Une porte qui ferait confiance à son appelant sur ce
   * point laisserait naître deux fiches pour `Alice@Lilas.test` et
   * `alice@lilas.test` le jour où un second appelant oublierait de canoniser.
   *
   * Le reste des coordonnées traverse **tel quel** : le prénom, le nom et le
   * numéro sont validés et élagués par la surface qui les reçoit, et cette porte
   * n'a pas de règle de saisie propre à imposer.
   *
   * ## Le rôle est jugé sous verrou de ligne (#468)
   *
   * Comme `assertBookableWithin`, et pour la même raison : le refus qu'elle porte
   * garde une insertion, et une décision lue sans verrou serait périmée avant
   * d'avoir servi. Le détail — pourquoi `FOR SHARE` plutôt qu'exclusif, et ce que
   * ce verrou ne ferme pas — est dans `CrmRepository.resolveClientWithin`, seul
   * endroit du module qui écrive la requête.
   *
   * @throws {ClientEmailNotBookableError} l'adresse porte un compte du personnel
   * de cet établissement — 409, jamais un `P2002` nu en 500.
   * @throws {ClientRecordRaceError} deux résolutions concurrentes ont créé la même
   * fiche : à l'appelant de rejouer sa transaction.
   * @throws {MissingTenantContextError} aucune portée de tenant n'est ouverte.
   */
  public async resolveWithin(
    scope: ClientDirectoryScope,
    contact: ClientContact,
  ): Promise<string> {
    return this.repository.resolveClientWithin(scope, {
      ...contact,
      email: normalizeEmail(contact.email),
    });
  }

  /**
   * Confirme qu'un identifiant désigne une fiche **du fichier client** de
   * l'établissement courant, **dans la transaction donnée**, et le rend (#465).
   *
   * La seconde porte de ce service, et la jumelle de `resolveWithin` : celle-là
   * part de coordonnées et crée au besoin, celle-ci part d'une fiche que le
   * comptoir a désignée et ne crée jamais rien. Toutes deux répondent à la même
   * question — « cette réservation peut-elle se rattacher à cette ligne ? » —,
   * toutes deux la posent dans la transaction d'insertion, et toutes deux ne
   * laissent sortir qu'un identifiant.
   *
   * ## Ce que cette porte referme
   *
   * `appointments.client_id` référence `users`, dont les comptes `STAFF`,
   * `MANAGER` et `ADMIN` font partie. Les deux clés étrangères composites jugent
   * l'existence de la fiche et son établissement, jamais son **rôle** : un membre
   * du personnel qui posait l'identifiant d'un collègue obtenait un rendez-vous
   * valide dont la cliente était un employé. Le tunnel public refusait déjà ce
   * cas depuis #313 (`resolveWithin` ne résout que des `CLIENT`) ; le comptoir
   * **désigne** au lieu de résoudre, et ne traversait donc pas cette porte.
   *
   * ## Pourquoi elle rend l'identifiant plutôt que `void`
   *
   * Pour que l'appelant ait la même forme des deux côtés de sa `ClientReference`
   * — un identifiant vérifié, obtenu d'une porte de `crm` — et qu'aucune branche
   * ne puisse repartir avec un identifiant qui n'aurait pas traversé le contrôle.
   * Un `void` aurait laissé `appointments` réutiliser sa propre variable, et un
   * refactor futur aurait pu perdre l'appel sans que rien ne change de type.
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
