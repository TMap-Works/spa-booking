import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotFoundError } from '../../common/errors';
import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type { ClientContact, ClientDirectoryScope } from './client-directory.service';
import {
  ClientEmailNotBookableError,
  ClientRecordRaceError,
  CustomerEmailTakenError,
} from './crm.errors';
import type {
  Customer,
  CustomerSummary,
  CustomerVisit,
  ExportedAppointment,
} from './crm.types';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une seule requête
 * d'ici ait à le répéter — donc sans qu'aucune puisse l'oublier. Le module n'a
 * **aucune** dérogation : rien dans un fichier client n'est légitimement
 * inter-tenant, et `prismaUnscoped` n'y est donc pas injecté du tout. C'est plus
 * sûr qu'un client disponible dont on se promet de ne pas se servir
 * (tenant-isolation §3).
 *
 * ## Deux tables lues, aucun repository voisin importé
 *
 * Ce dépôt lit `users` et `appointments`. Ce n'est pas une entorse à
 * api-module §3, qui interdit d'**importer le repository d'un autre module** —
 * un `../../identity/identity.repository` serait le défaut visé, et il n'y en a
 * pas ici. C'est une lecture directe du schéma, faite par le seul fichier du
 * module qui a le droit de le connaître.
 *
 * Le choix mérite d'être argumenté, parce que l'alternative existait :
 *
 * - **`users`** — une fiche cliente *est* une ligne `users` de rôle `CLIENT`.
 *   Passer par `IdentityService` aurait demandé d'y ajouter une lecture de la
 *   clientèle, c'est-à-dire d'ouvrir dans le module d'authentification la porte
 *   que `findStaffAccountById` ferme délibérément (« les données personnelles de
 *   la clientèle relèvent du module `crm` »). Le couplage aurait changé de
 *   forme, pas de nature, et il aurait affaibli `identity`.
 * - **`appointments`** — l'historique agrégé est une **projection en lecture
 *   seule** sur des rendez-vous déjà écrits. Il ne décide rien : ni statut, ni
 *   créneau, ni prix. `AppointmentsService` porte des règles de cycle de vie qui
 *   n'ont aucune part à une somme et à un compteur, et lui faire porter une
 *   requête d'agrégation CRM aurait mis la question de `crm` dans le module
 *   `appointments`.
 *
 * Ce que le module écrit dans `appointments` : **trois colonnes de texte
 * libre**, et seulement à l'anonymisation (#81). La lecture a été la seule
 * opération de ce dépôt sur cette table jusqu'à ce ticket ; `anonymize` y met à
 * `NULL` `client_note`, `staff_note` et `cancellation_reason`, parce que le
 * droit à l'oubli ne s'arrête pas à la fiche — c'est dans ces trois textes-là
 * qu'un humain a écrit ce qu'il savait de la personne. Rien du cycle de vie du
 * rendez-vous n'est touché : ni statut, ni créneau, ni prix, ni auteur
 * d'annulation. Le détail de l'arbitrage est sur la méthode.
 *
 * ## Deux méthodes travaillent dans la transaction d'un autre module
 *
 * `resolveClientWithin` prend une portée de transaction en paramètre au lieu
 * d'utiliser `this.prisma` (#313), et sa raison est un critère d'atomicité qui
 * traverse deux modules : la fiche cliente d'une réservation d'invité et le
 * rendez-vous doivent être écrits ou abandonnés **ensemble**, faute de quoi
 * chaque course perdue sur un créneau laisse une fiche publique sans
 * rendez-vous. Le client reçu est le même client scopé, si bien que l'extension
 * de tenant continue de s'appliquer mot pour mot. Le détail de l'arbitrage est
 * dans `client-directory.service.ts`, la porte qui l'expose.
 *
 * `assertClientBookableWithin` la rejoint pour l'autre façon de désigner une
 * cliente — un `clientId` posé par le comptoir (#465) — et pour une raison
 * voisine mais distincte : elle ne lit pas pour informer, elle lit pour
 * **décider**, et une décision prise hors de la transaction d'insertion serait
 * périmée avant d'avoir servi.
 *
 * ## Les deux lisent le rôle sous verrou, et sont les seules à écrire du SQL brut
 *
 * `assertClientBookableWithin` a porté seule le `SELECT … FOR SHARE` de #465
 * pendant que sa jumelle publique s'en passait ; #468 a refermé l'écart. Les
 * deux décident du même fait — « cette ligne `users` est-elle une fiche du
 * fichier client ? » — juste avant une insertion qui en dépend, et une décision
 * de ce genre lue sans verrou est périmée par construction sous `READ
 * COMMITTED`. Le verrou de ligne ne s'exprimant pas dans le client Prisma, ces
 * deux lectures — et elles seules — sont écrites en SQL.
 *
 * Elles écrivent donc aussi leur filtre `tenant_id` à la main : le SQL brut ne
 * repasse pas par l'extension de scoping (tenant-isolation §3, ADR 0006), et
 * `requireTenantId` est la seule source de cette valeur. C'est toute la
 * dérogation du module — la recherche, les projections, l'historique et les
 * **deux créations** continuent de passer par le client scopé, qui pose le
 * tenant sans qu'aucune requête ait à le nommer.
 */

/** Le compte tel que le fichier client le lit — jamais l'empreinte, jamais le tenant. */
const CUSTOMER_SUMMARY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  isActive: true,
} as const;

/**
 * La fiche complète — la seule projection du dépôt qui lise `internal_note`.
 *
 * La note n'est lue que là où elle est servie. Une liste qui la ramènerait
 * ferait transiter deux mille caractères par ligne à travers le réseau, la
 * mémoire du processus et, sur un chemin d'erreur, un journal. La bonne défense
 * est de ne pas la lire (même raisonnement que `PROFILE_SELECT` d'`identity`
 * pour l'empreinte de mot de passe).
 */
const CUSTOMER_SELECT = {
  ...CUSTOMER_SUMMARY_SELECT,
  internalNote: true,
  createdAt: true,
  // Les trois colonnes de #81. Elles sont sur la fiche complète et non sur le
  // résumé : la liste du back-office n'affiche ni consentement ni date
  // d'anonymisation, et une projection qui les lirait quand même les ferait
  // transiter deux cents fois pour rien.
  marketingConsent: true,
  marketingConsentAt: true,
  anonymizedAt: true,
} as const;

/**
 * Un rendez-vous **tel que l'export le lit** — plus large que `VISIT_SELECT`,
 * parce que le droit d'accès n'a pas le même périmètre qu'un écran (#81).
 *
 * Les trois champs de texte libre que l'historique ne montre pas sont ici :
 * `client_note`, ce que la cliente a écrit en réservant ; `staff_note`, ce que
 * le salon a noté sur ce rendez-vous ; et le motif d'annulation. Tous les trois
 * sont des données **la concernant**, et l'art. 15 du RGPD ne connaît pas
 * d'exception pour celles qu'on aurait préféré garder pour soi.
 *
 * Ce qui n'y est **pas** : `tenant_id`, `staff_id`, `service_id`. Le nom du
 * praticien et celui de la prestation sont lus par relation — ils décrivent la
 * visite —, mais les identifiants internes de l'établissement n'ont rien à faire
 * dans un document remis à une personne (tenant-isolation §4).
 */
const EXPORT_APPOINTMENT_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  priceAmountMinor: true,
  priceCurrency: true,
  clientNote: true,
  staffNote: true,
  cancelledAt: true,
  cancellationReason: true,
  createdAt: true,
  service: { select: { name: true } },
  staff: { select: { displayName: true } },
} as const;

/**
 * Les statuts qui occupent encore l'agenda — les mêmes que le prédicat partiel
 * de la contrainte d'exclusion, et que l'`upcomingVisits` de l'historique.
 *
 * Ce sont eux qui retiennent l'anonymisation : un rendez-vous à venir est un
 * contrat en cours d'exécution, et le RGPD n'impose pas d'effacer tant qu'il
 * l'est (art. 17.1.b).
 */
const OCCUPYING_STATUSES = ['PENDING', 'CONFIRMED'] as const;

/**
 * Une visite, réduite à ce que l'historique en montre.
 *
 * Lectures de relation : elles ne repassent pas par l'extension de scoping, mais
 * se parcourent par clé étrangère depuis une ligne **déjà bornée** au tenant
 * courant par l'opération de premier niveau. Ce sont les clés composites
 * `(tenant_id, service_id)` et `(tenant_id, staff_id)` de la migration initiale
 * qui interdisent que cette ligne en désigne une d'un autre établissement.
 */
const VISIT_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  priceAmountMinor: true,
  priceCurrency: true,
  service: { select: { name: true } },
  staff: { select: { displayName: true } },
} as const;

/**
 * Le rôle des fiches du fichier client.
 *
 * Écrit une fois : toute lecture et toute écriture de ce dépôt le porte, et
 * c'est ce qui rend un compte du personnel **introuvable** depuis les routes du
 * CRM — symétrique exact de `findStaffAccountById` d'`identity`, qui rend une
 * fiche cliente introuvable depuis l'administration des droits. Les deux
 * surfaces se refusent mutuellement, et aucune des deux n'a de `if` à écrire :
 * le filtre est dans le `where`, le `null` devient un 404.
 */
const CUSTOMER_ROLE = 'CLIENT' as const;

/**
 * Statut d'un rendez-vous honoré — le seul qui compte dans le total dépensé et
 * dans les bornes de l'historique.
 *
 * C'est le **seul** statut que ce dépôt nomme. Les quatre autres ne sont ni
 * filtrés ni cités : `countVisitsByStatus` les rend tels quels par `groupBy`, et
 * c'est le service qui décide ce que chacun vaut dans l'agrégat. Un sixième
 * statut ajouté au schéma remonterait donc jusqu'ici sans qu'aucune requête ne
 * change.
 */
const HONORED = 'COMPLETED' as const;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `identity` et `catalog` : le
 * type généré par Prisma exige `tenantId` — la colonne est `NOT NULL` — alors
 * que le repository ne doit justement pas le fournir. C'est l'extension qui le
 * pose depuis le contexte de requête, et qui **écrase** ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Ce qu'une lecture verrouillée de fiche rend — l'identifiant, le rôle à juger,
 * et l'état d'anonymisation (#81).
 *
 * Les deux premières colonnes sont transtypées en `text` dans la requête :
 * `role` parce que c'est une énumération PostgreSQL, dont le driver rendrait
 * autrement une valeur dépendante du catalogue, et `id` par symétrie de lecture.
 * La troisième est réduite à un booléen dans le `SELECT` : la décision a besoin
 * du **fait**, pas de l'instant. Rien d'autre n'est projeté — ni nom, ni
 * adresse, ni note interne : une lecture qui décide n'a pas à ramener ce dont la
 * décision n'a pas besoin.
 */
interface LockedClientRow {
  id: string;
  role: string;
  anonymized: boolean;
}

/** Champs modifiables d'une fiche — tous facultatifs, aucun ne l'est tous. */
export interface CustomerPatch {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  internalNote?: string | null;
  /**
   * Consentement au démarchage — #81.
   *
   * Il voyage **toujours** avec sa date : c'est le service qui les apparie, et
   * un consentement écrit sans instant serait un consentement que l'art. 7.1 du
   * RGPD ne permet pas de démontrer.
   */
  marketingConsent?: boolean;
  marketingConsentAt?: Date | null;
}

/**
 * Ce que l'anonymisation écrit à la place de l'identité — #81.
 *
 * Le pseudonyme est calculé par le service et non ici : c'est une décision sur
 * ce qu'on garde d'une personne, pas sur la façon de l'écrire. Le dépôt, lui,
 * sait ce qu'il faut vider en même temps — et cette liste-là est une propriété
 * du schéma, donc de ce fichier.
 */
export interface AnonymizedIdentity {
  firstName: string;
  lastName: string;
  email: string;
  anonymizedAt: Date;
}

/**
 * Ce qu'une demande d'anonymisation a produit — quatre issues, et aucune n'est
 * une erreur d'exécution.
 *
 * Un type somme plutôt qu'un `Customer | null` doublé d'un compteur lu à part :
 * les trois refus se décident **dans la transaction**, et les faire remonter
 * autrement aurait obligé le service à reposer au dehors une question déjà
 * tranchée dedans — c'est-à-dire à rouvrir la fenêtre que cette transaction
 * ferme. C'est le service qui traduit chaque issue en réponse HTTP ; le dépôt
 * ne connaît aucune erreur de domaine.
 */
export type AnonymizationOutcome =
  /** La fiche vient d'être anonymisée. */
  | { outcome: 'anonymized'; customer: Customer }
  /** Elle l'était déjà : rien n'a été réécrit, et c'est ce qui rend l'appel idempotent. */
  | { outcome: 'already-anonymized'; customer: Customer }
  /** Des rendez-vous occupent encore l'agenda — la transaction a été annulée. */
  | { outcome: 'upcoming-appointments'; upcomingAppointments: number }
  /** Inconnue, d'un autre établissement, ou compte du personnel — indistinctement. */
  | { outcome: 'not-found' };

/**
 * Le signal qui annule la transaction d'anonymisation quand la règle métier
 * tombe — interne à ce fichier, et jamais visible d'un appelant.
 *
 * Ce n'est pas une erreur de domaine : `anonymize` la rattrape et la traduit en
 * issue. Elle existe parce qu'une transaction Prisma interactive ne s'annule
 * que par une levée, et qu'il faut ici écrire avant de pouvoir décider.
 */
class UpcomingAppointmentsAbort extends Error {
  public constructor(public readonly upcomingAppointments: number) {
    super("Rendez-vous à venir : l'anonymisation est annulée.");
    this.name = 'UpcomingAppointmentsAbort';
    Error.captureStackTrace?.(this, UpcomingAppointmentsAbort);
  }
}

/** Critères de `GET /customers`, tels que le service les a normalisés. */
export interface CustomerSearchCriteria {
  /** Terme de recherche déjà élagué, ou `null` — « tout le fichier ». */
  term: string | null;
  includeInactive: boolean;
  page: number;
  pageSize: number;
}

/** Une page brute : les lignes, et le total sur lequel se calcule le nombre de pages. */
export interface CustomerSearchResult {
  items: CustomerSummary[];
  totalItems: number;
}

/** Le décompte des visites par statut, tel que `groupBy` le rend. */
export interface VisitCountByStatus {
  status: string;
  count: number;
}

/** Le total dépensé, par devise — voir `sumHonoredByCurrency`. */
export interface HonoredTotalByCurrency {
  currency: string;
  amountMinor: number;
}

/** Les bornes temporelles de l'historique d'une fiche. */
export interface VisitBounds {
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
}

@Injectable()
export class CrmRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Le fichier client de l'établissement courant, filtré et paginé.
   *
   * ## Ce que la recherche interroge, et avec quel index
   *
   * Un seul terme, trois axes — c'est ce que fait un front-desk qui a un nom au
   * téléphone, un numéro sur un SMS ou une adresse sur une confirmation, et qui
   * n'a pas à choisir un champ avant de chercher :
   *
   * | Axe | Prédicat | Ce qui le sert |
   * |---|---|---|
   * | nom, prénom | préfixe, insensible à la casse | `(tenant_id, role, last_name, first_name)` |
   * | e-mail | préfixe sur l'adresse **canonisée** | `(tenant_id, email)` |
   * | téléphone | préfixe | `(tenant_id, phone)` |
   *
   * L'e-mail est comparé en minuscules **sans** `mode: 'insensitive'`, et c'est
   * délibéré : `normalizeEmail` canonise à l'écriture, la colonne ne contient
   * donc que des minuscules, et une comparaison sensible à la casse sur une
   * donnée déjà canonisée est exacte *et* utilisable par l'index unique. Les
   * noms, eux, sont stockés tels que saisis : la recherche doit y être
   * insensible, ce qui interdit à PostgreSQL d'utiliser le B-tree pour le
   * préfixe. Ce qui reste — et qui est l'essentiel — c'est que l'index borne
   * d'abord les lignes candidates à **un établissement et à sa seule
   * clientèle** ; le prédicat de nom filtre à l'intérieur de cet ensemble, pas
   * de la table.
   *
   * La recherche est **par préfixe** et non « contient » : aucun B-tree ne sert
   * un `%dur%`, et le promettre aurait été promettre un balayage complet. Le
   * passage à `pg_trgm` pour une recherche infixe est une décision à prendre sur
   * volumétrie réelle.
   *
   * ## Pourquoi `$transaction` autour des deux requêtes
   *
   * La page et son total sont lus dans la même transaction, **en lecture
   * répétable** : sans elle, une création concurrente entre les deux donnerait
   * un `totalItems` qui ne correspond à aucune des pages rendues. Le niveau
   * d'isolation est explicite parce que le défaut de PostgreSQL — `READ
   * COMMITTED` — prend un instantané **par instruction** : la transaction seule
   * ne suffirait pas, et la garantie annoncée ici serait fausse. Les deux
   * requêtes ne lisent rien qu'elles n'écrivent, il n'y a donc aucun échec de
   * sérialisation à rattraper.
   */
  public async search(criteria: CustomerSearchCriteria): Promise<CustomerSearchResult> {
    const where = this.searchWhere(criteria);

    const [items, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.user.findMany({
          where,
          select: CUSTOMER_SUMMARY_SELECT,
          // Ordre stable : le nom, puis le prénom, puis l'identifiant pour
          // départager deux homonymes. Sans troisième critère, deux fiches de même
          // nom peuvent changer de page d'un appel à l'autre — et l'une disparaît
          // de la pagination pendant que l'autre s'y répète.
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
          skip: (criteria.page - 1) * criteria.pageSize,
          take: criteria.pageSize,
        }),
        this.prisma.user.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { items, totalItems };
  }

  /**
   * Une fiche cliente de l'établissement courant, par identifiant.
   *
   * Rend `null` pour un identifiant inconnu, pour celui d'une fiche d'un autre
   * établissement **et** pour celui d'un compte du personnel, indistinctement.
   * Le service traduit les trois en 404 : distinguer la deuxième confirmerait
   * l'existence d'une ressource voisine (tenant-isolation §4), et distinguer la
   * troisième dirait qui travaille au salon à qui n'a que le droit de lire des
   * fiches.
   *
   * `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
   * `where`, et `findUnique` exige que le `where` désigne *exactement* une clé
   * unique — ce que `{ id, tenantId, role }` ne fait pas sous cette forme.
   */
  public async findById(id: string): Promise<Customer | null> {
    return this.prisma.user.findFirst({
      where: { id, role: CUSTOMER_ROLE },
      select: CUSTOMER_SELECT,
    });
  }

  /**
   * Crée une fiche cliente dans l'établissement courant.
   *
   * `passwordHash: null` — la fiche naît **inconnectable**, et c'est la
   * définition de la saisie au comptoir : elle existe pour être réservée et
   * rappelée, pas pour ouvrir une session. La colonne est nullable au schéma
   * depuis l'origine, précisément pour ce cas (« un client peut exister sans
   * compte, saisi au comptoir par le staff »).
   *
   * Aucun `tenantId` n'est passé : c'est l'extension qui le pose, et elle
   * **écrase** ce qui s'y trouverait. Un `tenantId` qui aurait traversé la
   * validation n'aurait donc aucun effet.
   *
   * La violation de `@@unique([tenantId, email])` est traduite ici, et pas
   * ailleurs : c'est le seul point du module qui connaît les codes d'erreur de
   * Prisma. Sans cette traduction, une saisie concurrente sur la même adresse
   * recevrait un 500 là où le contrat annonce un 409.
   */
  public async create(input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    internalNote: string | null;
    marketingConsent: boolean;
    marketingConsentAt: Date | null;
  }): Promise<Customer> {
    try {
      return await this.prisma.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: input.email,
          role: CUSTOMER_ROLE,
          passwordHash: null,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          internalNote: input.internalNote,
          marketingConsent: input.marketingConsent,
          marketingConsentAt: input.marketingConsentAt,
        }),
        select: CUSTOMER_SELECT,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new CustomerEmailTakenError();
      }
      throw error;
    }
  }

  /**
   * La fiche cliente de ces coordonnées — trouvée, ou créée sans compte —
   * **dans la transaction de l'appelant** (#313).
   *
   * C'est l'écriture que `AppointmentsRepository.findOrCreateClient` faisait
   * jusqu'ici, déplacée dans le module qui possède la table (api-module §3).
   *
   * ## Pourquoi `scope` et non `this.prisma`
   *
   * Parce que le critère à tenir est une propriété de **transaction** : « un 409
   * de créneau ne laisse aucune fiche derrière lui ». Écrire par `this.prisma`
   * ouvrirait une transaction implicite distincte de celle qui pose le
   * rendez-vous, et la fiche survivrait au `ROLLBACK` de l'insertion. Le client
   * reçu est le scopé, dérivé du même : l'extension y injecte `tenantId` sur la
   * lecture comme sur la création, et rien ici ne le nomme.
   *
   * ## La lecture ne filtre **pas** sur le rôle, et c'est le propos
   *
   * Un `WHERE "email" = …` sans `role`, puis une décision explicite sur ce qu'il
   * trouve. L'inverse — filtrer sur `role = 'CLIENT'` — aurait rendu zéro ligne
   * pour une adresse portée par un compte du personnel, donc conduit à une
   * création que `@@unique([tenantId, email])` refuse en `P2002` nu : un 500 sur
   * un cas parfaitement prévisible. Lire le rôle et le juger ici est ce qui
   * transforme cette collision en un refus choisi
   * (`ClientEmailNotBookableError`, 409).
   *
   * ## Le rôle est lu sous `FOR SHARE`, comme au comptoir (#468)
   *
   * Cette lecture était nue jusqu'à #468, et le refus qu'elle porte n'était donc
   * pas atomique par rapport à l'insertion qu'il garde. Sous `READ COMMITTED`,
   * chaque instruction prend son propre instantané : la lecture voyait `CLIENT`,
   * une transaction concurrente promouvait la fiche au personnel et validait, et
   * l'insertion passait — les deux clés étrangères de `appointments.client_id`
   * prouvent l'existence de la ligne et son établissement, jamais son rôle.
   * C'était exactement la « vérification applicative suivie d'un `INSERT` » que
   * booking-engine §1 interdit, et c'est ce que sa jumelle
   * `assertClientBookableWithin` refermait déjà pour la route de comptoir.
   *
   * Le verrou est **partagé** et non exclusif, pour la même raison que là-bas :
   * deux réservations d'invité sur la même adresse chez deux praticiens
   * différents doivent pouvoir avancer de front. Seuls les écrivains de la
   * ligne attendent — ceux, précisément, qui pourraient la promouvoir.
   *
   * ## Ce que ce verrou ne ferme pas, et ce qui le ferme à sa place
   *
   * La fenêtre de l'adresse **libre**. `FOR SHARE` verrouille les lignes rendues,
   * et une lecture qui n'en rend aucune ne verrouille rien : deux transactions
   * concurrentes peuvent toutes deux constater l'adresse libre et tenter la
   * création. Ce n'est pas un trou laissé ouvert, c'est la course que
   * `@@unique([tenantId, email])` arbitre déjà — la perdante reçoit `P2002`,
   * traduit plus bas en `ClientRecordRaceError`, et `writingAgenda` rejoue la
   * transaction entière (#313). La tentative suivante lit alors, sous verrou, la
   * fiche que la gagnante vient d'écrire, et la juge.
   *
   * Fermer cette seconde fenêtre par un verrou demanderait de verrouiller une
   * ligne qui n'existe pas — un verrou de prédicat, c'est-à-dire `SERIALIZABLE`
   * sur la transaction de l'agenda. Le prix serait des échecs de sérialisation
   * sur des réservations sans rapport entre elles, pour remplacer un arbitrage
   * que la contrainte d'unicité rend déjà, gratuitement et sans faux positif.
   *
   * ## L'ordre des verrous, et pourquoi il n'ajoute aucun cycle d'attente
   *
   * `AppointmentsRepository.insert` prend d'abord le verrou consultatif
   * d'agenda, **puis** appelle cette porte : le `FOR SHARE` arrive donc toujours
   * après lui, exactement comme celui du comptoir. Les deux chemins acquièrent
   * dans le même ordre, et aucun ne détient de verrou de ligne `users` avant
   * l'agenda (ADR 0006).
   *
   * ## Ce que le prédicat ne regarde pas : `is_active`
   *
   * Une fiche désactivée est réutilisée telle quelle. Elle désigne la **même
   * personne**, et la désactivation gouverne les écrans du back-office — la
   * recherche du fichier client l'exclut par défaut —, pas l'identité de qui
   * réserve. L'écarter n'aurait laissé que deux issues, l'une impossible et
   * l'autre nuisible : créer une seconde fiche, ce que l'unicité interdit, ou
   * refuser — c'est-à-dire faire de cette route publique un oracle sur le fichier
   * client du salon, précisément la donnée que ce module protège.
   *
   * ## Ce que cette méthode ne fait **pas** : mettre à jour
   *
   * Une fiche trouvée est rendue telle quelle. Le prénom, le nom et le téléphone
   * envoyés par un visiteur non authentifié n'écrasent jamais ceux d'une fiche
   * existante : sans cela, un appel public suffirait à réécrire le nom et le
   * numéro de n'importe quelle cliente dont on connaît l'adresse. La correction
   * d'une fiche relève du back-office, sous garde (`PATCH /customers/:id`).
   *
   * @throws {ClientEmailNotBookableError} l'adresse porte un compte du personnel
   * de cet établissement, ou une fiche anonymisée (#81) — jugé sous verrou, donc
   * encore vrai à l'insertion.
   * @throws {ClientRecordRaceError} deux créations concurrentes, dont celle-ci a
   * perdu — l'appelant rejoue sa transaction.
   * @throws {MissingTenantContextError} aucune portée de tenant n'est ouverte :
   * le filtre écrit à la main n'aurait aucune valeur à porter.
   */
  public async resolveClientWithin(
    scope: ClientDirectoryScope,
    contact: ClientContact,
  ): Promise<string> {
    // Le SQL brut ne repasse pas par l'extension de scoping (ADR 0006) : le
    // filtre d'établissement est écrit dans la requête, et il vient du contexte
    // de requête — jamais d'un paramètre que l'appelant choisirait. Sans
    // contexte ouvert, la lecture échoue ici plutôt que de traverser les
    // établissements (tenant-isolation §3).
    const tenantId = requireTenantId('User', 'resolveClientWithin');

    // `(tenant_id, email)` est l'index unique du schéma : ce couple de prédicats
    // le sert tel quel, et rend au plus une ligne.
    const rows = await scope.$queryRaw<LockedClientRow[]>`
      SELECT "id"::text AS id, "role"::text AS role, "anonymized_at" IS NOT NULL AS anonymized
      FROM "users"
      WHERE "email" = ${contact.email} AND "tenant_id" = ${tenantId}::uuid
      FOR SHARE
    `;

    // Le rôle est lu **pour être jugé**, jamais rendu : c'est la seule
    // information dont la décision a besoin, et elle ne quitte pas ce fichier.
    const existing = rows[0];
    if (existing !== undefined) {
      // L'anonymisation pèse ici exactement comme dans `assertClientBookableWithin`
      // (#81) : une fiche anonymisée reste de rôle `CLIENT`, si bien que le seul
      // filtre de rôle la laissait passer. Le pseudonyme est **dérivé de l'`id`**
      // et figure dans l'export remis à la personne : rattacher une réservation
      // publique à cette adresse-là aurait réinscrit au fichier client quelqu'un
      // qui venait d'en sortir. Le refus est le même que pour un compte du
      // personnel — l'adresse existe et n'est pas réservable — et non un silence,
      // parce qu'écarter la ligne du prédicat conduirait à une création que
      // `@@unique([tenantId, email])` refuse, donc à une boucle de réessais.
      if (existing.role !== CUSTOMER_ROLE || existing.anonymized) {
        throw new ClientEmailNotBookableError();
      }
      return existing.id;
    }

    try {
      const created = await scope.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: contact.email,
          role: CUSTOMER_ROLE,
          // Aucun mot de passe : la fiche existe pour être jointe, pas pour se
          // connecter. `AuthService` refuse déjà une identité sans empreinte.
          passwordHash: null,
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
          // Aucune note interne : le dossier du salon ne s'écrit pas depuis une
          // surface publique. `ClientContact` n'a d'ailleurs pas de champ pour.
        }),
        select: { id: true },
      });
      return created.id;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        // Relire l'adresse ici serait vain : la violation a abandonné la
        // transaction, et toute instruction suivante échouerait en `25P02`. Le
        // réessai appartient à celui qui a ouvert la transaction.
        throw new ClientRecordRaceError();
      }
      throw error;
    }
  }

  /**
   * Vérifie qu'un identifiant désigne bien une **fiche du fichier client** de
   * l'établissement courant, **dans la transaction de l'appelant** (#465).
   *
   * La jumelle de `resolveClientWithin`, pour l'autre façon de désigner une
   * cliente : là-bas des coordonnées à résoudre, ici une fiche déjà désignée par
   * le comptoir. Les deux répondent à la même question — « cette réservation
   * peut-elle se rattacher à cette ligne `users` ? » — et les deux la posent au
   * même endroit, à l'intérieur de la transaction qui pose le rendez-vous.
   *
   * ## Ce que les clés étrangères ne savaient pas juger
   *
   * `appointments_client_id_fkey` prouve que la ligne `users` existe,
   * `appointments_tenant_id_client_id_fkey` qu'elle est du bon établissement.
   * Ni l'une ni l'autre ne regarde le **rôle** : un membre du personnel qui
   * posait l'identifiant d'un collègue obtenait un rendez-vous parfaitement
   * valide dont la cliente était un employé — invisible dans l'annuaire CRM, qui
   * filtre sur `role = CLIENT`, et pourtant compté comme cliente par le
   * reporting (#465). Une contrainte de schéma aurait été plus forte, mais
   * `users` ne porte aucune colonne dérivée sur laquelle une clé étrangère
   * partielle pourrait s'appuyer.
   *
   * ## Pourquoi du SQL brut, comme sa jumelle et pour la même raison
   *
   * Pour le `FOR SHARE`, que le client Prisma n'exprime pas — et sans lequel
   * cette méthode serait exactement la « vérification applicative suivie d'un
   * `INSERT` » que booking-engine §1 interdit. Elle a porté ce verrou seule
   * jusqu'à #468, qui l'a étendu à `resolveClientWithin` : les deux lectures qui
   * jugent un rôle avant d'insérer sont désormais les deux seules du module à
   * descendre au SQL, et les deux seules à écrire leur `tenant_id` à la main.
   * Sous `READ COMMITTED`, chaque
   * instruction prend son propre instantané : une lecture nue verrait `CLIENT`,
   * une transaction concurrente promouvrait la fiche en `STAFF` et validerait,
   * et l'insertion qui suit passerait — les clés étrangères, elles, restent
   * satisfaites. Le verrou partagé ferme cette fenêtre : la ligne ne peut plus
   * être modifiée ni supprimée jusqu'au `COMMIT` de l'appelant, si bien que le
   * rôle jugé ici est celui que le rendez-vous désignera. C'est le second
   * critère de #465 — « une fiche qui changerait de rôle entre-temps ne passe
   * pas ».
   *
   * `FOR SHARE` et non `FOR UPDATE` : deux réservations de comptoir pour la même
   * cliente chez deux praticiens différents doivent pouvoir avancer de front. Le
   * verrou partagé les laisse cohabiter et ne bloque que les écrivains de cette
   * ligne, qui sont précisément ceux dont il faut se prémunir.
   *
   * ## Le tenant est écrit à la main, et il le faut
   *
   * Le SQL brut ne repasse pas par l'extension de scoping (tenant-isolation §3,
   * ADR 0006) : `tenant_id = …` est donc écrit ici, depuis le contexte de
   * requête et de nulle part d'autre. C'est ce qui fait qu'une fiche du salon
   * voisin ne rend aucune ligne — donc le même refus qu'un identifiant inventé.
   *
   * ## Le refus est un 404, et c'est un arbitrage (#465)
   *
   * `NotFoundError`, exactement celle que `AppointmentsRepository.create` lève
   * déjà pour une fiche inconnue ou celle d'un autre établissement — même classe,
   * même message. Les trois causes deviennent ainsi **littéralement**
   * indiscernables, ce qu'aucune classe d'erreur distincte remappée plus haut ne
   * garantirait aussi solidement. C'est la conduite que ce dépôt tient déjà
   * partout ailleurs : `findById`, `update` et `setActive` replient « c'est un
   * compte du personnel » sur « introuvable », pour ne pas dire qui travaille au
   * salon à qui n'a que le droit de lire des fiches.
   *
   * Un 409 `CLIENT_NOT_BOOKABLE`, symétrique du `CLIENT_EMAIL_NOT_BOOKABLE` du
   * tunnel public, a été écarté : la symétrie est trompeuse. Ce 409-là existe
   * parce que `@@unique([tenantId, email])` ne laisse **aucune** troisième voie —
   * la visiteuse ne pourra jamais réserver sous cette adresse, et un front qui la
   * renverrait au calendrier la ferait tourner en rond (#452). Ici la voie existe
   * et elle est triviale : le comptoir a désigné la mauvaise ligne, et la bonne
   * est à un choix de tiroir. « Introuvable au fichier client » est à la fois vrai
   * et actionnable ; « définitivement non réservable » ne le serait pas.
   *
   * ## Une fiche anonymisée n'est plus réservable (#81)
   *
   * Elle reste de rôle `CLIENT` — elle doit le rester, sinon elle disparaîtrait
   * du fichier client et de son propre export —, si bien que le seul filtre de
   * rôle la laissait passer. Rattacher un nouveau rendez-vous à une personne
   * qui vient d'exercer son droit à l'oubli l'aurait réinscrite au fichier par
   * la bande, et le refus muet est le même que pour les trois autres cas.
   *
   * C'est aussi ce qui referme la course inverse : `anonymize` verrouille la
   * ligne par son `UPDATE` et compte les rendez-vous après, donc une
   * réservation qui démarre pendant l'anonymisation attend son `COMMIT`, relit
   * la ligne sous ce verrou — et la trouve anonymisée.
   *
   * @throws {NotFoundError} l'identifiant ne désigne aucune fiche cliente
   * réservable de cet établissement — inconnu, du salon voisin, compte du
   * personnel, ou fiche anonymisée, indistinctement.
   */
  public async assertClientBookableWithin(
    scope: ClientDirectoryScope,
    clientId: string,
  ): Promise<string> {
    const tenantId = requireTenantId('User', 'assertClientBookableWithin');

    // `anonymized_at IS NULL` ferme la quatrième porte, celle que #81 ouvrait :
    // une fiche anonymisée reste de rôle `CLIENT` — elle doit le rester, sans
    // quoi elle disparaîtrait du fichier client et de son propre export — et
    // les clés étrangères ne regardent pas davantage l'anonymisation que le
    // rôle. Sans ce prédicat, le comptoir pouvait rattacher un rendez-vous à
    // une personne qui venait d'exercer son droit à l'oubli. Le prédicat est
    // constant : il n'ajoute aucun paramètre lié, et le verrou reste le même.
    const rows = await scope.$queryRaw<{ role: string }[]>`
      SELECT "role"::text AS role
      FROM "users"
      WHERE "id" = ${clientId}::uuid AND "tenant_id" = ${tenantId}::uuid
        AND "anonymized_at" IS NULL
      FOR SHARE
    `;

    if (rows[0]?.role !== CUSTOMER_ROLE) {
      throw new NotFoundError('Cliente introuvable.');
    }

    return clientId;
  }

  /**
   * Écrit les champs **présents** du correctif sur une fiche cliente.
   *
   * `updateMany` et non `update` : l'extension complète le `where` par le
   * tenant, et `update` exigerait une clé unique que `{ id, tenantId, role }`
   * n'est pas. Le retour est le nombre de lignes touchées, ramené à un booléen —
   * `false` couvre indistinctement « inconnu ici », « d'un autre établissement »
   * et « c'est un compte du personnel ».
   */
  public async update(id: string, patch: CustomerPatch): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id, role: CUSTOMER_ROLE },
      data: patch,
    });
    return result.count > 0;
  }

  /**
   * Active ou désactive une fiche, **sans rien supprimer**.
   *
   * Il n'y a pas de `DELETE` sur cette ressource, et ce n'est pas un choix de
   * style : `appointments.client_id` référence `users` en `Restrict`, si bien
   * qu'une fiche ayant honoré une seule visite ne se supprime pas. Le reporting
   * du CDC §1.4 doit par ailleurs continuer à compter ces visites.
   */
  public async setActive(id: string, isActive: boolean): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { id, role: CUSTOMER_ROLE },
      data: { isActive },
    });
    return result.count > 0;
  }

  /**
   * **Tous** les rendez-vous d'une fiche, du plus ancien au plus récent — la
   * matière de l'export de portabilité (#81).
   *
   * ## Pourquoi aucune borne, contrairement à `recentVisits`
   *
   * Parce que les deux lectures ne servent pas la même chose. `recentVisits`
   * alimente un écran, et un écran affiche une fenêtre. Celle-ci alimente un
   * document remis à une personne au titre de l'art. 20 du RGPD : un export
   * tronqué n'est pas un export, et le tronquer **en silence** serait le pire
   * des deux mondes — un document qui a l'air complet et ne l'est pas.
   *
   * La borne existe quand même, elle est simplement dans la nature des données :
   * ce sont les rendez-vous d'**une** personne dans **un** établissement. Une
   * cliente hebdomadaire depuis dix ans en compte cinq cents. Le jour où ce
   * raisonnement cesserait d'être vrai, la réponse ne serait pas une pagination
   * — elle rendrait le document non conforme — mais une remise en pièce jointe,
   * c'est-à-dire une autre décision de conception.
   *
   * ## L'ordre est chronologique, et pas celui de l'historique
   *
   * `recentVisits` va du plus récent au plus ancien : c'est ce qu'un écran de
   * back-office veut voir en premier. Un dossier se lit dans l'autre sens, du
   * début à la fin. L'index `(tenant_id, client_id, starts_at)` sert les deux.
   */
  public async allAppointmentsForExport(customerId: string): Promise<ExportedAppointment[]> {
    const rows = await this.prisma.appointment.findMany({
      where: { clientId: customerId },
      select: EXPORT_APPOINTMENT_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      serviceName: row.service.name,
      staffName: row.staff.displayName,
      priceAmountMinor: row.priceAmountMinor,
      priceCurrency: row.priceCurrency,
      clientNote: row.clientNote,
      staffNote: row.staffNote,
      cancelledAt: row.cancelledAt,
      cancellationReason: row.cancellationReason,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Anonymise une fiche cliente **sans supprimer sa ligne** — le droit à l'oubli
   * du CDC §5.1, deuxième critère de #81.
   *
   * ## Pourquoi une anonymisation et non une suppression
   *
   * `appointments.client_id` référence `users` en `Restrict`, et `payments`
   * comme `sales` s'accrochent à ces rendez-vous. Retirer la ligne emporterait
   * l'historique comptable des ventes passées — ce que le critère interdit
   * expressément, et ce que la base refuserait de toute façon. Ce qui part,
   * c'est **la personne** : ce qui reste, c'est un identifiant opaque, des
   * montants et des dates, que plus rien ne rattache à quelqu'un.
   *
   * ## Ce qui est vidé, et pourquoi cette liste-là
   *
   * | Colonne | Ce qu'elle devient | Pourquoi |
   * |---|---|---|
   * | `first_name`, `last_name`, `email` | le pseudonyme calculé par le service | `NOT NULL` : elles ne peuvent pas être vidées, seulement remplacées |
   * | `phone`, `internal_note` | `NULL` | nullables, et rien n'oblige à en garder une trace |
   * | `password_hash` | `NULL` | une identité anonymisée ne doit plus ouvrir de session |
   * | `is_active` | `false` | la fiche quitte les écrans de saisie ; il n'y a plus personne à y désigner |
   * | `marketing_consent` | `false`, sa date remise à `NULL` | un consentement sans personne pour l'avoir donné n'est plus un consentement |
   * | `appointments.client_note`, `staff_note`, `cancellation_reason` | `NULL` | trois textes libres saisis par des humains, où se retrouvent les données que ce geste doit effacer |
   *
   * Les trois dernières sont la raison d'être de la transaction. Une
   * anonymisation qui ne toucherait que `users` laisserait « allergique au
   * monoï, habite au-dessus de la pharmacie » dans une note de rendez-vous, et
   * le geste n'aurait alors effacé que ce qui était le plus facile à effacer.
   *
   * ## Le seul endroit du module qui écrive dans `appointments`
   *
   * Et c'est une entorse assumée à ce que le dépôt annonce plus haut. Elle est
   * bornée à trois colonnes de **texte libre** : ni statut, ni créneau, ni prix,
   * ni auteur d'annulation. Rien de ce qui relève du cycle de vie du rendez-vous
   * n'est touché, donc rien de ce qu'`AppointmentsService` décide. Passer par ce
   * module-là aurait demandé de lui apprendre ce qu'est une donnée personnelle,
   * et d'ouvrir dans `crm` une porte pour la lui réclamer — pour trois `NULL`.
   *
   * ## L'écriture est conditionnelle, et c'est ce qui la rend idempotente
   *
   * `anonymized_at: null` dans le `where` : une fiche déjà anonymisée n'est pas
   * réécrite, donc ne reçoit pas un second pseudonyme ni une seconde date. Le
   * `count` à zéro ne distingue pas ce cas de « cette fiche n'est pas ici » —
   * c'est la relecture qui tranche, et elle rend `already-anonymized` ou
   * `not-found`. Deux demandes concurrentes obtiennent ainsi la même réponse,
   * la seconde sans rien réécrire.
   *
   * ## L'écriture précède la règle, et il le faut (booking-engine §1)
   *
   * Le refus « des rendez-vous à venir occupent encore l'agenda » est compté
   * **après** l'`UPDATE` de la fiche, à l'intérieur de la même transaction, et
   * il annule la transaction quand il tombe. L'ordre inverse — compter puis
   * écrire — aurait été exactement la « vérification applicative suivie d'une
   * écriture » que le projet refuse :
   *
   * - `AppointmentsRepository.insert` lit la ligne `users` sous `FOR SHARE`
   *   avant d'insérer (#465, #468). Un compte fait **avant** toute prise de
   *   verrou aurait pris son propre instantané sous `READ COMMITTED`, aurait
   *   manqué la réservation en cours de validation, et l'anonymisation serait
   *   passée sur une cliente attendue jeudi ;
   * - l'`UPDATE` de la ligne `users`, lui, **entre en conflit** avec ce
   *   `FOR SHARE`. Il attend donc la validation de toute réservation en vol, et
   *   le compte qui le suit voit le rendez-vous qu'elle vient d'écrire. Une
   *   réservation qui démarre ensuite attend, elle, notre `COMMIT`.
   *
   * Écrire d'abord et laisser la transaction arbitrer coûte un `ROLLBACK` sur le
   * chemin de refus, ce qui est le prix d'une décision juste. Aucun verrou
   * d'agenda n'est pris ici, et aucun cycle d'attente n'est donc créé : la
   * réservation prend l'agenda puis la ligne, celle-ci ne prend que la ligne
   * (ADR 0006).
   *
   * Le tenant n'est nommé nulle part : toutes les opérations passent par le
   * client scopé, à l'intérieur d'une transaction dérivée de lui. La fiche du
   * salon voisin est donc invisible à l'`updateMany`, et ses rendez-vous au
   * compte comme au nettoyage.
   */
  public async anonymize(
    id: string,
    identity: AnonymizedIdentity,
    upcomingFrom: Date,
  ): Promise<AnonymizationOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const scrubbed = await tx.user.updateMany({
          where: { id, role: CUSTOMER_ROLE, anonymizedAt: null },
          data: {
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: identity.email,
            phone: null,
            internalNote: null,
            passwordHash: null,
            isActive: false,
            marketingConsent: false,
            marketingConsentAt: null,
            anonymizedAt: identity.anonymizedAt,
          },
        });

        if (scrubbed.count === 0) {
          const existing = await tx.user.findFirst({
            where: { id, role: CUSTOMER_ROLE },
            select: CUSTOMER_SELECT,
          });
          return existing === null
            ? { outcome: 'not-found' as const }
            : { outcome: 'already-anonymized' as const, customer: existing };
        }

        // La ligne est désormais verrouillée par l'`UPDATE` ci-dessus : ce
        // compte-ci voit toute réservation validée, et bloque celles qui
        // suivent jusqu'à l'issue de cette transaction.
        //
        // La borne porte sur `ends_at` et non sur `starts_at` : un rendez-vous
        // **commencé et non terminé** est un contrat en cours d'exécution au
        // même titre qu'un rendez-vous de jeudi (art. 17.1.b). Le borner par
        // `starts_at` aurait laissé anonymiser la cliente installée dans le
        // fauteuil, et effacé au passage les notes du rendez-vous en cours.
        const upcoming = await tx.appointment.count({
          where: {
            clientId: id,
            status: { in: [...OCCUPYING_STATUSES] },
            endsAt: { gt: upcomingFrom },
          },
        });

        if (upcoming > 0) {
          // Lever annule la transaction : l'anonymisation écrite quelques
          // lignes plus haut n'a jamais eu lieu.
          throw new UpcomingAppointmentsAbort(upcoming);
        }

        await tx.appointment.updateMany({
          where: { clientId: id },
          data: { clientNote: null, staffNote: null, cancellationReason: null },
        });

        const anonymized = await tx.user.findFirst({
          where: { id, role: CUSTOMER_ROLE },
          select: CUSTOMER_SELECT,
        });

        // `null` est impossible ici — l'`UPDATE` vient de toucher la ligne, et
        // la transaction la tient — mais le type de Prisma ne le sait pas, et
        // un `!` mentirait sur ce qui est garanti par quoi.
        return anonymized === null
          ? { outcome: 'not-found' as const }
          : { outcome: 'anonymized' as const, customer: anonymized };
      });
    } catch (error: unknown) {
      if (error instanceof UpcomingAppointmentsAbort) {
        return { outcome: 'upcoming-appointments', upcomingAppointments: error.upcomingAppointments };
      }
      throw error;
    }
  }

  /**
   * Les visites les plus récentes d'une fiche.
   *
   * Bornée par `take` : l'historique **affiché** est une fenêtre, l'agrégat qui
   * l'accompagne porte sur la totalité. Un décompte calculé sur cette liste
   * mentirait dès que la fiche dépasse la fenêtre.
   *
   * `orderBy: startsAt desc` sert l'index `(tenant_id, client_id, starts_at)` du
   * schéma initial — le seul qui filtre sur ce couple, posé pour cette question.
   */
  public async recentVisits(customerId: string, take: number): Promise<CustomerVisit[]> {
    const rows = await this.prisma.appointment.findMany({
      where: { clientId: customerId },
      select: VISIT_SELECT,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take,
    });

    return rows.map((row) => ({
      appointmentId: row.id,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      serviceName: row.service.name,
      // La relation est **obligatoire** au schéma (`Appointment.staff`), donc
      // toujours jointe. Le type de sortie la déclare pourtant nullable : c'est
      // le contrat qui anticipe une fiche praticien retirée, et le jour où le
      // schéma l'autorisera, seule cette ligne changera.
      staffName: row.staff.displayName,
      priceAmountMinor: row.priceAmountMinor,
      priceCurrency: row.priceCurrency,
    }));
  }

  /**
   * Le décompte des rendez-vous d'une fiche, **par statut**.
   *
   * Un `groupBy` plutôt que cinq `count` : une seule requête, et l'ajout d'un
   * sixième statut au schéma n'en demanderait pas une sixième. C'est le service
   * qui décide ce que chaque statut vaut dans l'agrégat — le dépôt ne fait que
   * compter.
   */
  public async countVisitsByStatus(customerId: string): Promise<VisitCountByStatus[]> {
    const rows = await this.prisma.appointment.groupBy({
      by: ['status'],
      where: { clientId: customerId },
      _count: { _all: true },
    });

    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }

  /**
   * Première et dernière **visite honorée** d'une fiche.
   *
   * Sur les seuls `COMPLETED` : « depuis quand est-elle cliente » et « quand
   * est-elle venue la dernière fois » sont des questions sur des soins reçus. Un
   * rendez-vous annulé n'est pas une venue, et un rendez-vous à venir n'a pas
   * encore eu lieu — les compter décalerait la dernière visite dans le futur.
   */
  public async honoredVisitBounds(customerId: string): Promise<VisitBounds> {
    const bounds = await this.prisma.appointment.aggregate({
      where: { clientId: customerId, status: HONORED },
      _min: { startsAt: true },
      _max: { startsAt: true },
    });

    return { firstVisitAt: bounds._min.startsAt, lastVisitAt: bounds._max.startsAt };
  }

  /**
   * Le total dépensé sur les visites honorées, **ventilé par devise**.
   *
   * La ventilation n'est pas de la sur-ingénierie : chaque rendez-vous fige sa
   * devise à la réservation (`appointments.price_currency`), et un établissement
   * qui change de devise laisse derrière lui des lignes dans l'ancienne.
   * Additionner les entiers sans regarder leur code produirait une somme qui ne
   * veut rien dire — exactement ce que le couple montant + devise du projet
   * existe pour rendre impossible. C'est le service qui décide quoi faire d'une
   * fiche à deux devises ; le dépôt ne masque pas le fait.
   */
  public async sumHonoredByCurrency(customerId: string): Promise<HonoredTotalByCurrency[]> {
    const rows = await this.prisma.appointment.groupBy({
      by: ['priceCurrency'],
      where: { clientId: customerId, status: HONORED },
      _sum: { priceAmountMinor: true },
    });

    return rows.map((row) => ({
      currency: row.priceCurrency,
      // `_sum` est nul sur un groupe vide ; un groupe rendu par `groupBy` ne
      // l'est jamais, mais le type de Prisma ne le sait pas et `0` est la valeur
      // juste pour ce cas impossible.
      amountMinor: row._sum.priceAmountMinor ?? 0,
    }));
  }

  /** Le `where` du fichier client — écrit une fois, partagé par la page et son total. */
  private searchWhere(criteria: CustomerSearchCriteria): Prisma.UserWhereInput {
    return {
      role: CUSTOMER_ROLE,
      // Une fiche désactivée n'a rien à faire dans l'écran de prise de
      // rendez-vous, qui est l'usage dominant. Le back-office qui veut la
      // retrouver le demande explicitement.
      ...(criteria.includeInactive ? {} : { isActive: true }),
      ...(criteria.term === null ? {} : { OR: matchesTerm(criteria.term) }),
    };
  }
}

/**
 * Les métacaractères de `LIKE` — et le `\` qui sert à les neutraliser.
 *
 * `startsWith` de Prisma construit le motif `LIKE 'terme%'` **sans échapper** ce
 * que le terme contient : `%` y reste un joker « n'importe quelle suite » et `_`
 * un joker « n'importe quel caractère ». Un terme saisi n'est pas un motif, et
 * l'écart n'est pas théorique — `?q=%%` rendrait le fichier client entier au
 * prix d'un balayage complet sur les quatre axes, et `?q=jean_` désignerait
 * `jeanne` comme `jeanX`.
 */
const LIKE_METACHARACTERS = /[\\%_]/g;

/**
 * Neutralise les métacaractères de `LIKE` dans un terme saisi.
 *
 * `\` est le caractère d'échappement par défaut de `LIKE` sur PostgreSQL, et le
 * motif voyage en paramètre lié : préfixer les trois caractères suffit à rendre
 * au terme son sens littéral, `ILIKE` compris.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(LIKE_METACHARACTERS, '\\$&');
}

/**
 * Les quatre prédicats de la recherche libre, pour un terme donné.
 *
 * Hors de la classe et exporté : c'est la seule partie de la recherche qui soit
 * du raisonnement plutôt que de l'accès, et la sortir la rend testable sans
 * client Prisma — la forme du `OR` est ce qui décide de l'index utilisé.
 */
export function matchesTerm(term: string): Prisma.UserWhereInput[] {
  // Un terme est une saisie, jamais un motif : ce qu'il contient de `%` ou de
  // `_` doit se chercher tel quel.
  const prefix = escapeLikeTerm(term);

  return [
    { lastName: { startsWith: prefix, mode: 'insensitive' } },
    { firstName: { startsWith: prefix, mode: 'insensitive' } },
    // Sensible à la casse **sur une donnée déjà canonisée** : la colonne ne
    // contient que des minuscules (`normalizeEmail` à l'écriture), et c'est ce
    // qui permet à l'index unique `(tenant_id, email)` de servir ce préfixe.
    { email: { startsWith: prefix.toLowerCase() } },
    { phone: { startsWith: prefix } },
  ];
}
