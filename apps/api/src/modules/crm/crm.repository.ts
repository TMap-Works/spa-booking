import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type { ClientContact, ClientDirectoryScope } from './client-directory.service';
import {
  ClientEmailNotBookableError,
  ClientRecordRaceError,
  CustomerEmailTakenError,
} from './crm.errors';
import type { Customer, CustomerSummary, CustomerVisit } from './crm.types';

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
 * Ce que le module n'écrit **jamais** : aucune ligne d'`appointments`. La
 * lecture est la seule opération de ce dépôt sur cette table.
 *
 * ## Une méthode écrit dans la transaction d'un autre module
 *
 * `resolveClientWithin` prend une portée de transaction en paramètre au lieu
 * d'utiliser `this.prisma` (#313). C'est la seule de ce fichier, et sa raison est
 * un critère d'atomicité qui traverse deux modules : la fiche cliente d'une
 * réservation d'invité et le rendez-vous doivent être écrits ou abandonnés
 * **ensemble**, faute de quoi chaque course perdue sur un créneau laisse une
 * fiche publique sans rendez-vous. Le client reçu est le même client scopé, si
 * bien que l'extension de tenant continue de s'appliquer mot pour mot. Le détail
 * de l'arbitrage est dans `client-directory.service.ts`, la porte qui l'expose.
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
} as const;

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

/** Champs modifiables d'une fiche — tous facultatifs, aucun ne l'est tous. */
export interface CustomerPatch {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  internalNote?: string | null;
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
   * `findFirst({ where: { email } })` sans `role`, puis une décision explicite sur
   * ce qu'elle trouve. L'inverse — filtrer sur `role: 'CLIENT'` dans le `where` —
   * aurait rendu `null` pour une adresse portée par un compte du personnel, donc
   * conduit à une création que `@@unique([tenantId, email])` refuse en `P2002`
   * nu : un 500 sur un cas parfaitement prévisible. Lire le rôle et le juger ici
   * est ce qui transforme cette collision en un refus choisi
   * (`ClientEmailNotBookableError`, 409).
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
   * @throws {ClientEmailNotBookableError} l'adresse porte un compte du personnel.
   * @throws {ClientRecordRaceError} deux créations concurrentes, dont celle-ci a
   * perdu — l'appelant rejoue sa transaction.
   */
  public async resolveClientWithin(
    scope: ClientDirectoryScope,
    contact: ClientContact,
  ): Promise<string> {
    const existing = await scope.user.findFirst({
      where: { email: contact.email },
      // Le rôle est lu **pour être jugé**, jamais rendu : c'est la seule
      // information dont la décision a besoin, et elle ne quitte pas ce fichier.
      select: { id: true, role: true },
    });

    if (existing !== null) {
      if (existing.role !== CUSTOMER_ROLE) {
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
