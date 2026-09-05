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
   * @throws {ClientEmailNotBookableError} l'adresse porte un compte du personnel
   * de cet établissement — 409, jamais un `P2002` nu en 500.
   * @throws {ClientRecordRaceError} deux résolutions concurrentes ont créé la même
   * fiche : à l'appelant de rejouer sa transaction.
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
}
