import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@spa/shared';

import { NotFoundError } from '../../common/errors';
import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import { billedIntervalOf } from '../appointments/billed-interval';
// Import **de valeur** d'un module voisin sans dépendance Nest ni Prisma — même
// geste que le `billedIntervalOf` ci-dessus. `users.locale` est un `VARCHAR(5)`
// pour Prisma et une `Locale` pour le contrat : la conversion est écrite une
// seule fois, dans le module qui possède la colonne (#844). En recopier une
// seconde ici l'aurait fait diverger au premier repli changé — et la fiche
// cliente et le profil connecté auraient alors lu la même colonne de deux
// façons.
import { toAccountLocale } from '../identity/locale';
import type { ClientDirectoryScope } from './client-directory.service';
import { CustomerEmailTakenError } from './crm.errors';
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
 * ## Une méthode travaille dans la transaction d'un autre module
 *
 * `assertClientBookableWithin` prend une portée de transaction en paramètre au
 * lieu d'utiliser `this.prisma` (#465), et sa raison est qu'elle ne lit pas pour
 * informer, elle lit pour **décider** : une décision prise hors de la
 * transaction d'insertion serait périmée avant d'avoir servi. Le client reçu est
 * le même client scopé, si bien que l'extension de tenant continue de
 * s'appliquer mot pour mot. Le détail de l'arbitrage est dans
 * `client-directory.service.ts`, la porte qui l'expose.
 *
 * Elle avait une jumelle jusqu'à #1222, `resolveClientWithin`, qui résolvait une
 * fiche depuis des coordonnées et la créait au besoin (#313). Plus aucune route
 * ne l'atteignait depuis #1136 : réserver exige un compte, et les deux surfaces
 * désignent une fiche existante.
 *
 * ## Elle lit le rôle sous verrou, et c'est le seul SQL brut du module
 *
 * `assertClientBookableWithin` porte le `SELECT … FOR SHARE` de #465. Elle
 * décide d'un fait — « cette ligne `users` est-elle une fiche du fichier
 * client ? » — juste avant une insertion qui en dépend, et une décision de ce
 * genre lue sans verrou est périmée par construction sous `READ COMMITTED`. Le
 * verrou de ligne ne s'exprimant pas dans le client Prisma, cette lecture — et
 * elle seule — est écrite en SQL.
 *
 * Elle écrit donc aussi son filtre `tenant_id` à la main : le SQL brut ne
 * repasse pas par l'extension de scoping (tenant-isolation §3, ADR 0006), et
 * `requireTenantId` est la seule source de cette valeur. C'est toute la
 * dérogation du module — la recherche, les projections, l'historique et la
 * **création de fiche** continuent de passer par le client scopé, qui pose le
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
  // Les deux colonnes de #73, projetées par #525. Même arbitrage que les trois
  // précédentes : sur la fiche complète, pas sur le résumé. La liste du
  // back-office n'affiche aucun avis de délivrabilité, et une projection qui les
  // lirait quand même les ferait transiter deux cents fois pour rien.
  //
  // Ce module ne les **écrit** jamais : l'unique écriture est celle de
  // l'ingestion d'un événement de remise SES, dans `notifications`. Le fichier
  // client en est un lecteur, et le `select` dit exactement cela.
  emailSuppressedAt: true,
  emailSuppressionReason: true,
  // La langue préférée de la personne (#844), projetée par #852. Même arbitrage
  // que les cinq colonnes précédentes : sur la fiche complète, pas sur le
  // résumé — le comptoir lit la langue au moment où il ouvre une fiche pour
  // décrocher, jamais en parcourant deux cents lignes.
  //
  // Ce module ne l'**écrit** jamais : elle se pose depuis l'espace client
  // (`PATCH /users/me`) ou à la réservation, dans `identity` et `appointments`.
  // Le fichier client en est un lecteur, et le `select` dit exactement cela.
  locale: true,
} as const;

/**
 * La ligne de `users` telle que le contrat la veut — #852.
 *
 * Le seul écart entre la projection ci-dessus et {@link Customer} est `locale` :
 * la colonne est un `VARCHAR(5)` borné par `users_locale_check`, que Prisma type
 * `string | null` faute de pouvoir lire une contrainte `CHECK`. Quelqu'un doit
 * dire au compilateur ce que la base garantit déjà, et c'est ici — une fois,
 * pour les quatre lectures de `CUSTOMER_SELECT`, plutôt qu'à chacune.
 *
 * `toAccountLocale` plutôt qu'un `as Locale` nu : le `as` serait faux dans le
 * seul cas qui compte — une valeur posée à la main sur la base sortirait telle
 * quelle dans une réponse, où le front la rejetterait en validation. Le prédicat
 * la ramène à `null`, c'est-à-dire à « aucune préférence », qui est exactement
 * ce qu'une valeur illisible veut dire.
 */
function toCustomerRecord<T extends { locale: string | null }>(
  row: T,
): Omit<T, 'locale'> & { locale: Locale | null } {
  return { ...row, locale: toAccountLocale(row.locale) };
}

/**
 * Un rendez-vous **tel que l'export le lit** — plus large que `VISIT_SELECT`,
 * parce que le droit d'accès n'a pas le même périmètre qu'un écran (#81).
 *
 * Les trois champs de texte libre y sont : `client_note`, ce que la cliente a
 * écrit en réservant — le seul des trois que `VISIT_SELECT` lise aussi, depuis
 * #870 ; `staff_note`, ce que le salon a noté sur ce rendez-vous ; et le motif
 * d'annulation. Tous les trois sont des données **la concernant**, et l'art. 15
 * du RGPD ne connaît pas d'exception pour celles qu'on aurait préféré garder
 * pour soi.
 *
 * Ce qui n'y est **pas** : `tenant_id`, `staff_id`, `service_id`. Le nom du
 * praticien et celui de la prestation sont lus par relation — ils décrivent la
 * visite —, mais les identifiants internes de l'établissement n'ont rien à faire
 * dans un document remis à une personne (tenant-isolation §4).
 *
 * La durée et le tampon avant de la prestation y sont, sans être restitués :
 * ils servent à retrouver l'intervalle **facturé** de chaque ligne
 * (`billedIntervalOf`, #750). Un document qui daterait les visites sur
 * l'intervalle occupé annoncerait à la personne des heures que ni son espace
 * client ni le planning du salon n'ont jamais affichées.
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
  service: { select: { name: true, durationMinutes: true, bufferBeforeMinutes: true } },
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
 *
 * `durationMinutes` et `bufferBeforeMinutes` sont lus sur la même relation que
 * le nom, et pour la même raison que l'agenda les lit : ce sont eux qui
 * convertissent l'intervalle **occupé** de la colonne en intervalle **facturé**,
 * seul affichable (#750).
 *
 * `clientNote` y est entrée en #870, `staffNote` non — et l'écart entre les deux
 * est la seule chose à retenir de cette projection. La première est écrite par
 * le client sur son propre rendez-vous ; la seconde est écrite sur lui par le
 * salon, et `EXPORT_APPOINTMENT_SELECT` est la seule lecture de ce dépôt qui la
 * porte, parce qu'un droit d'accès n'a pas le périmètre d'un écran. Ajouter
 * `staffNote: true` ici la ferait remonter jusqu'au type partagé
 * `CustomerVisit`, que le parcours public lit aussi.
 */
const VISIT_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  priceAmountMinor: true,
  priceCurrency: true,
  clientNote: true,
  // Les deux moitiés de « ce rendez-vous a-t-il été perdu, ou déplacé » (#917) :
  // l'auteur d'annulation, nul sur l'origine d'un report, et le lien que porte
  // son successeur. `cancellationReason` reste dehors, avec `staffNote` et pour
  // la même raison — un texte libre écrit par un humain ne sort que par une
  // route gardée par un rôle (#317). Un auteur d'annulation, lui, est une
  // énumération de trois valeurs, déjà servie au parcours public par
  // `bookedAppointmentSchema` : l'ajouter ici n'ouvre aucune surface nouvelle.
  cancelledBy: true,
  rescheduledFromId: true,
  service: { select: { name: true, durationMinutes: true, bufferBeforeMinutes: true } },
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
  /**
   * Restreint la lecture aux clientes qui ont — ou ont eu — un rendez-vous avec
   * le **compte** désigné, et à elles seules (#812, quatrième critère).
   *
   * `null` se lit « tout le fichier de l'établissement », ce qu'ouvre
   * `customers:read:all`. Un identifiant se lit « celles de ce praticien »,
   * ce qu'ouvre `customers:read:own`.
   *
   * C'est un **identifiant de compte** (`users.id`) et non de fiche praticien :
   * le service le tient du jeton vérifié, et faire la traversée en une seule
   * requête évite une lecture de `staff` dont ce module n'a par ailleurs aucun
   * besoin. Un compte sans fiche praticien ne satisfait donc aucune ligne — le
   * `some` est faux partout — et la page rendue est vide, ce qui est la bonne
   * réponse : il n'a pas de clientèle.
   */
  ownedByUserId: string | null;
}

/** Une page brute : les lignes, et le total sur lequel se calcule le nombre de pages. */
export interface CustomerSearchResult {
  items: CustomerSummary[];
  totalItems: number;
}

/**
 * Le décompte des visites par statut **et par auteur d'annulation**, tel que
 * `groupBy` le rend.
 *
 * La seconde dimension n'a de sens que sur `CANCELLED`, et elle y est tout le
 * propos (#917) : `cancelledBy` nul y désigne l'origine d'un report, que
 * l'agrégat doit compter à part d'une annulation véritable. Partout ailleurs
 * elle vaut `null` sans rien dire, et le service l'ignore.
 */
export interface VisitCountByStatus {
  status: string;
  cancelledBy: string | null;
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
   * Le pays de l'établissement courant — ISO 3166-1 alpha-2, `null` s'il n'a pas
   * encore saisi son adresse (#824).
   *
   * Le seul champ de la table `tenants` que ce dépôt lise, et il ne le lit que
   * pour une chose : compléter un numéro de téléphone **national** saisi au
   * comptoir. Une lecture à un champ, pour la raison qui borne déjà
   * `CUSTOMER_SELECT` — une projection large ferait voyager les coordonnées du
   * salon dans un service qui n'en a pas l'usage.
   *
   * Ce n'est pas une entorse au « `crm` n'importe pas le dépôt d'`identity` »
   * (voir l'en-tête de ce fichier) : la requête est écrite ici, sur le client
   * scopé de ce module, et l'extension borne le modèle racine sur son `id`
   * (`tenant-scope.extension.ts`). Il n'y a ni `where`, ni identifiant en
   * paramètre — donc aucun moyen de désigner l'établissement d'à côté.
   */
  public async findCurrentTenantCountryCode(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { countryCode: true } });

    return tenant?.countryCode ?? null;
  }

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
   *
   * ## `ownedByUserId` ajoute un **quatrième** cas au même `null` (#812)
   *
   * « Existe dans cet établissement, mais n'est pas une de vos clientes » rejoint
   * les trois autres, et rend donc 404 comme elles — jamais 403. La nuance est
   * délibérée, et elle ne contredit pas l'`OWN_SCOPE_ONLY` des rendez-vous : là-
   * bas, l'appelant connaît déjà l'existence de la ressource — il voit le
   * fauteuil occupé —, et un 404 lui mentirait. Ici, c'est **l'existence de la
   * fiche qui est l'information protégée** : un 403 sur les identifiants du
   * fichier et un 404 sur les autres ferait de cette route un oracle qui
   * énumère la clientèle du salon, c'est-à-dire exactement ce que ce ticket
   * ferme (capture 3).
   */
  public async findById(id: string, ownedByUserId: string | null = null): Promise<Customer | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, role: CUSTOMER_ROLE, ...ownedByPredicate(ownedByUserId) },
      select: CUSTOMER_SELECT,
    });

    return row === null ? null : toCustomerRecord(row);
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
      return toCustomerRecord(
        await this.prisma.user.create({
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
        }),
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new CustomerEmailTakenError();
      }
      throw error;
    }
  }

  /**
   * Vérifie qu'un identifiant désigne bien une **fiche du fichier client** de
   * l'établissement courant, **dans la transaction de l'appelant** (#465).
   *
   * La seule façon de désigner une cliente depuis #1136 : une fiche déjà au
   * fichier du salon — le compte du jeton au tunnel, celle que l'opérateur a
   * choisie au comptoir. Elle répond à la question « cette réservation peut-elle
   * se rattacher à cette ligne `users` ? », et elle la pose à l'intérieur de la
   * transaction qui pose le rendez-vous.
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
   * ## Pourquoi du SQL brut
   *
   * Pour le `FOR SHARE`, que le client Prisma n'exprime pas — et sans lequel
   * cette méthode serait exactement la « vérification applicative suivie d'un
   * `INSERT` » que booking-engine §1 interdit. C'est la seule lecture du module
   * à descendre au SQL, et la seule à écrire son `tenant_id` à la main.
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

    return rows.map((row) => {
      const billed = billedIntervalOf(row, row.service);

      return {
        id: row.id,
        status: row.status,
        startsAt: billed.startsAt,
        endsAt: billed.endsAt,
        serviceName: row.service.name,
        staffName: row.staff.displayName,
        priceAmountMinor: row.priceAmountMinor,
        priceCurrency: row.priceCurrency,
        clientNote: row.clientNote,
        staffNote: row.staffNote,
        cancelledAt: row.cancelledAt,
        cancellationReason: row.cancellationReason,
        createdAt: row.createdAt,
      };
    });
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
            : { outcome: 'already-anonymized' as const, customer: toCustomerRecord(existing) };
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
          : { outcome: 'anonymized' as const, customer: toCustomerRecord(anonymized) };
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
   *
   * ## L'ordre reste celui de la colonne, l'affichage celui du soin
   *
   * Le tri porte sur `starts_at`, c'est-à-dire sur l'intervalle **occupé** :
   * c'est le seul que l'index sache servir, et le trier sur l'heure facturée
   * demanderait de lire toute la fiche avant d'en montrer dix lignes. Les deux
   * ordres ne diffèrent que si deux visites d'une même cliente se chevauchent à
   * quelques minutes près chez deux praticiens différents — la contrainte
   * d'exclusion ne porte que sur le praticien, pas sur la cliente —, et le prix
   * de cet écart est deux lignes interverties dans une fenêtre où elles se
   * voient toutes deux.
   */
  public async recentVisits(customerId: string, take: number): Promise<CustomerVisit[]> {
    const rows = await this.prisma.appointment.findMany({
      where: { clientId: customerId },
      select: VISIT_SELECT,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      take,
    });

    return rows.map((row) => {
      const billed = billedIntervalOf(row, row.service);

      return {
        appointmentId: row.id,
        status: row.status,
        startsAt: billed.startsAt,
        endsAt: billed.endsAt,
        serviceName: row.service.name,
        // La relation est **obligatoire** au schéma (`Appointment.staff`), donc
        // toujours jointe. Le type de sortie la déclare pourtant nullable : c'est
        // le contrat qui anticipe une fiche praticien retirée, et le jour où le
        // schéma l'autorisera, seule cette ligne changera.
        staffName: row.staff.displayName,
        priceAmountMinor: row.priceAmountMinor,
        priceCurrency: row.priceCurrency,
        clientNote: row.clientNote,
        cancelledBy: row.cancelledBy,
        rescheduledFromId: row.rescheduledFromId,
      };
    });
  }

  /**
   * Le décompte des rendez-vous d'une fiche, **par statut**.
   *
   * Un `groupBy` plutôt que cinq `count` : une seule requête, et l'ajout d'un
   * sixième statut au schéma n'en demanderait pas une sixième. C'est le service
   * qui décide ce que chaque statut vaut dans l'agrégat — le dépôt ne fait que
   * compter.
   *
   * ## Pourquoi `cancelled_by` est une seconde dimension du groupe (#917)
   *
   * Parce que la question « combien de créneaux cette cliente a-t-elle perdus »
   * n'a pas la même réponse que « combien en a-t-elle déplacés », et que la base
   * porte déjà la distinction : un report annule la ligne d'origine **sans**
   * auteur. Grouper sur le couple la rend d'une seule requête, là où un second
   * `count` filtré aurait parcouru les mêmes lignes une deuxième fois — et deux
   * requêtes qui comptent la même chose finissent par se contredire.
   */
  public async countVisitsByStatus(customerId: string): Promise<VisitCountByStatus[]> {
    const rows = await this.prisma.appointment.groupBy({
      by: ['status', 'cancelledBy'],
      where: { clientId: customerId },
      _count: { _all: true },
    });

    return rows.map((row) => ({
      status: row.status,
      cancelledBy: row.cancelledBy,
      count: row._count._all,
    }));
  }

  /**
   * Première et dernière **visite honorée** d'une fiche.
   *
   * Sur les seuls `COMPLETED` : « depuis quand est-elle cliente » et « quand
   * est-elle venue la dernière fois » sont des questions sur des soins reçus. Un
   * rendez-vous annulé n'est pas une venue, et un rendez-vous à venir n'a pas
   * encore eu lieu — les compter décalerait la dernière visite dans le futur.
   *
   * ## Ces deux bornes restent sur l'intervalle occupé, contrairement aux visites
   *
   * `min`/`max` sont calculés par le moteur sur `starts_at` seul : rendre la
   * borne facturée demanderait de joindre la prestation ligne à ligne, c'est-à-
   * dire de remplacer un agrégat indexé par un parcours. Le prix de l'écart est
   * connu et borné — les cinq à dix minutes du tampon avant —, et la fiche
   * affiche ces deux dates **au jour près** (`dayLabel`), où il ne se voit qu'à
   * cheval sur minuit.
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
      ...ownedByPredicate(criteria.ownedByUserId),
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
 * Le prédicat « ses clientes à lui », ou rien du tout — #812.
 *
 * ## Ce qu'il traverse, et pourquoi en une seule requête
 *
 * `users` (la cliente) → `clientAppointments` → `staff` → `userId`. La relation
 * nommée `AppointmentClient` est celle que le schéma déclare, et le `some`
 * s'écrit donc sans jointure explicite ni seconde lecture. Résoudre d'abord la
 * fiche praticien du compte aurait ajouté une requête **et** fait lire `staff` à
 * un module qui n'en a pas d'autre usage.
 *
 * ## Aucun `tenantId` ici, et ce n'est pas un oubli
 *
 * L'extension de scoping le pose sur le `where` de la lecture principale, et les
 * clés étrangères composites `(tenant_id, id)` du schéma interdisent qu'un
 * rendez-vous d'un salon désigne le praticien d'un autre : la traversée ne peut
 * donc pas sortir de l'établissement courant (tenant-isolation §1 et §3).
 *
 * ## Tous les statuts comptent, annulations comprises
 *
 * La question à laquelle ce prédicat répond est « cette personne est-elle une de
 * mes clientes ? », et une annulation ne la retire pas du fichier de qui devait
 * la recevoir : le praticien qui la rappelle pour reproposer un créneau a besoin
 * de son numéro. Restreindre aux rendez-vous honorés aurait fait disparaître une
 * fiche le jour où elle devient la plus utile.
 */
function ownedByPredicate(userId: string | null): Prisma.UserWhereInput {
  if (userId === null) {
    return {};
  }

  return { clientAppointments: { some: { staff: { userId } } } };
}

/**
 * Les prédicats de la recherche libre, pour un terme donné — quatre axes (nom,
 * prénom, adresse, téléphone), le dernier cherché sous deux écritures quand la
 * saisie porte des séparateurs.
 *
 * Hors de la classe et exporté : c'est la seule partie de la recherche qui soit
 * du raisonnement plutôt que de l'accès, et la sortir la rend testable sans
 * client Prisma — la forme du `OR` est ce qui décide de l'index utilisé.
 *
 * ## Le numéro est cherché sous sa forme compactée aussi (#824)
 *
 * Depuis que `users.phone` est canonisé en E.164, la colonne ne porte **aucun
 * séparateur** : `+261341234567`. Un terme tapé comme le numéro se lit — « +261
 * 34 99 » — ne serait plus le préfixe de rien, alors que c'est exactement la
 * recherche que le comptoir fait. Le terme est donc cherché deux fois : tel
 * quel, pour le stock que la reprise n'a pas su convertir, et compacté, pour la
 * forme canonique. Le `00` de composition internationale cède la place au `+`,
 * comme à l'écriture (`normalizeToE164`).
 *
 * Deux `startsWith` sur la même colonne restent servis par
 * `(tenant_id, phone)` : c'est deux parcours d'index, pas un balayage.
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
    ...phoneSearchForms(term).map((value) => ({ phone: { startsWith: escapeLikeTerm(value) } })),
  ];
}

/**
 * Les écritures sous lesquelles un terme peut désigner un numéro en base —
 * dédupliquées, dans l'ordre où l'index les servira (#824).
 *
 * Le terme brut d'abord : c'est lui qui trouve le stock que la reprise E.164 n'a
 * pas su convertir. Puis sa forme compactée, quand elle en diffère — le préfixe
 * de la colonne canonisée.
 *
 * Rendu **non échappé**, et c'est ce qui permet à `FakeCrmRepository` de
 * l'appeler : le double rejoue la recherche en mémoire, par `startsWith` de
 * JavaScript, où un `\` inséré devant un `%` ne neutraliserait rien mais
 * ajouterait un caractère. L'échappement pour `LIKE` appartient donc à
 * `matchesTerm`, qui est le seul à parler à PostgreSQL. C'est l'arbitrage que
 * `crm.repository.spec.ts` réclame : une propriété réécrite des deux côtés
 * cesse d'être testée.
 *
 * Ce qui n'y est **pas**, et qui demanderait le pays de l'établissement : le
 * national à préfixe interurbain (« 0612 ») ne se ramène pas à « +33612 » sans
 * savoir dans quel pays on se trouve, et ce `where` est construit sans lecture.
 * Une issue de suivi le porte.
 */
export function phoneSearchForms(term: string): string[] {
  const trimmed = term.trim();
  const compact = trimmed.replace(/[\s().-]/g, '');
  const candidate = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;

  return candidate === trimmed || candidate === '' ? [term] : [term, candidate];
}
