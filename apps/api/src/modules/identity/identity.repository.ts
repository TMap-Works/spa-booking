import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LegalIdType } from '@spa/shared';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import { EmailAlreadyRegisteredError } from './identity.errors';
import type { StaffAccountState, UserProfile, UserRole } from './identity.types';
import { STAFF_ROLES } from './roles';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une seule requête
 * d'ici ait à le répéter — donc sans qu'aucune puisse l'oublier.
 *
 * Deux exceptions, nommées et argumentées, et elles seules :
 * `findTenantIdBySlug` — qui détermine le tenant, donc ne peut pas déjà le
 * connaître — et `listTenantTimeZones` — le relevé de démarrage, qui les
 * inspecte tous. Voir leurs commentaires respectifs.
 */

/** Le compte tel que le service en a besoin — empreinte comprise. */
export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
}

/** Une plage d'ouverture telle que la base la stocke — minutes locales (#343). */
export interface OpeningHourRecord {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * L'établissement tel qu'il sort vers une page publique. Aucun champ interne :
 * voir `PUBLIC_TENANT_SELECT`.
 *
 * Les cinq colonnes d'adresse sont nullables, comme les deux contacts : c'est le
 * service qui décide de la forme qui sort (`toPublicTenant`), et cette
 * interface décrit ce que la base rend, pas ce que l'API publie.
 */
export interface PublicTenantRecord {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  defaultCurrency: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
  openingHours: OpeningHourRecord[];
}

/**
 * La vue back-office : la vitrine, plus l'état d'activation (#343), plus
 * l'identité légale et le taux de taxe que le ticket de caisse imprime (#913).
 *
 * Ces sept colonnes n'appartiennent **pas** à `PublicTenantRecord`, et c'est
 * tout l'intérêt de la distinction entre les deux projections : un SIRET, un
 * numéro de TVA et un taux de taxe sont des données de pièce comptable, pas de
 * vitrine. Les poser plus haut les aurait servies sans authentification à qui
 * connaît le slug du salon.
 */
export interface TenantRecord extends PublicTenantRecord {
  isActive: boolean;
  legalName: string | null;
  legalIdType: LegalIdType | null;
  legalId: string | null;
  vatNumber: string | null;
  receiptFooter: string | null;
  /** `NOT NULL` avec défaut `TIC` — toute vente close doit avoir un numéro. */
  receiptPrefix: string;
  /** `NOT NULL` avec défaut `0` — en points de base, jamais un flottant. */
  taxRateBps: number;
}

/**
 * De quoi nommer un établissement et juger son fuseau — rien de plus (#604).
 *
 * Trois champs, et la projection du dépôt s'y tient : c'est ce qui garantit
 * qu'un signalement de fuseau ne peut pas emporter dans un journal les
 * coordonnées de contact du salon (CDC §5.1).
 */
export interface TenantTimeZoneRecord {
  id: string;
  name: string;
  timezone: string;
}

/**
 * Les réglages qu'un écran de back-office peut poser sur l'établissement.
 *
 * Ne porte que les champs **présents** : un `{ contactPhone: null }` efface le
 * numéro, un objet sans `contactPhone` n'y touche pas. La distinction est celle
 * d'`updateContactDetails`, et elle ne peut pas se faire plus bas — Prisma
 * ignore un `undefined` et écrirait `null` sur un `null`.
 *
 * Ni `slug`, ni `isActive`, ni `id` : le type l'interdit, et c'est ce qui
 * empêche cette charge utile de devenir la porte par laquelle un établissement
 * change d'adresse publique ou se réactive lui-même.
 */
export interface TenantSettingsChanges {
  name?: string;
  timezone?: string;
  defaultCurrency?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  countryCode?: string | null;
  // Identité légale et fiscalité (#913). `legalIdType` et `legalId` s'écrivent
  // **toujours ensemble** : la contrainte `tenants_legal_id_completeness_check`
  // refuse l'un sans l'autre, et c'est le service qui compose la paire à partir
  // de la charge utile et de l'état enregistré.
  legalName?: string | null;
  legalIdType?: LegalIdType | null;
  legalId?: string | null;
  vatNumber?: string | null;
  receiptFooter?: string | null;
  receiptPrefix?: string;
  taxRateBps?: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  /** L'empreinte que la dernière rotation a remplacée — `null` avant la première. */
  previousTokenHash: string | null;
  /** L'instant de la dernière rotation — `null` avant la première. */
  rotatedAt: Date | null;
}

/** La projection d’une session, partagée par sa création et sa lecture. */
const SESSION_SELECT = {
  id: true,
  userId: true,
  tokenHash: true,
  expiresAt: true,
  revokedAt: true,
  previousTokenHash: true,
  rotatedAt: true,
} as const;

/**
 * L'état de réinitialisation d'un compte — #809.
 *
 * ## Pourquoi une structure à part, et non trois champs sur `UserRecord`
 *
 * Parce que `UserRecord` traverse tout le module, jusqu'aux frontières où l'on
 * vérifie qu'aucune donnée sensible ne sort. Une empreinte de jeton de
 * réinitialisation y aurait voyagé dans chaque connexion, chaque lecture de
 * profil et chaque liste de comptes, pour n'être lue que par deux méthodes du
 * service. « La bonne défense est de ne pas la lire » — c'est le raisonnement
 * qui a déjà produit `STAFF_ACCOUNT_SELECT`.
 *
 * `role` et `isActive` en font partie parce que les deux décident : le premier
 * dit vers quel écran le lien pointe (quatrième critère), le second si le
 * message part du tout (sixième critère).
 */
export interface PasswordResetState {
  id: string;
  role: UserRole;
  isActive: boolean;
  /** `null` quand aucune réinitialisation n'est en cours. */
  passwordResetTokenHash: string | null;
  /** Nulle exactement quand l'empreinte l'est — la contrainte de la migration. */
  passwordResetExpiresAt: Date | null;
  /** Instant de la dernière demande, même si son jeton a servi ou a expiré. */
  passwordResetRequestedAt: Date | null;
}

/** La projection de cet état, écrite une fois. */
const PASSWORD_RESET_SELECT = {
  id: true,
  role: true,
  isActive: true,
  passwordResetTokenHash: true,
  passwordResetExpiresAt: true,
  passwordResetRequestedAt: true,
} as const;

/**
 * Projection du compte, écrite une fois.
 *
 * `passwordHash` n'est jamais dans un `select` destiné à sortir du module, et
 * `tenantId` non plus : le `select` explicite est ce qui rend cette garantie
 * vérifiable à la lecture, là où un `findUnique` nu ramènerait tout.
 */
const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  passwordHash: true,
  firstName: true,
  lastName: true,
  phone: true,
  isActive: true,
} as const;

/**
 * Projection sans l'empreinte, pour les lectures qui n'ont pas à la vérifier.
 *
 * Une liste de comptes n'a aucune raison de ramener une empreinte par ligne :
 * `toProfile` la retirerait à la sortie, mais elle aurait quand même traversé le
 * réseau, la mémoire du processus et, sur un chemin d'erreur, un log. La bonne
 * défense est de ne pas la lire.
 *
 * `isActive` y figure depuis #695 : c'est une lecture d'administration des
 * droits, et la liste du personnel ne pouvait pas dire quels comptes étaient
 * fermés. Le champ ne sort que par les routes gardées au rang `STAFF` au minimum
 * — `toProfile`, que lisent `/auth/me` et `PATCH /users/me`, continue de le
 * retirer.
 */
const PROFILE_SELECT = {
  id: true,
  email: true,
  role: true,
  firstName: true,
  lastName: true,
  phone: true,
  isActive: true,
} as const;

/**
 * La vitrine publique d'un établissement — servie **avant toute
 * authentification** à la page de réservation.
 *
 * La liste est une liste **blanche**, et c'est tout son intérêt : ce qui n'y
 * figure pas ne peut pas fuiter par distraction. `isActive` en est absent — il
 * dit qu'un salon a fermé, et à qui le demande —, comme `createdAt` et tout ce
 * qui n'aide pas à réserver. Elle reprend exactement `publicTenantSchema` du
 * contrat partagé (`packages/shared/src/schemas/tenant.ts`), qui fige la même
 * frontière côté front.
 *
 * `id` y est, et c'est la seule exception à « ne jamais exposer `tenantId` »
 * (tenant-isolation §4) : cet objet **est** l'établissement, l'identifiant n'y
 * révèle donc aucune frontière qu'il ne documente déjà. Le contrat partagé pose
 * la même exception, au même endroit et pour la même raison.
 */
/**
 * Ordre stable des plages d'ouverture : jour ISO croissant, puis heure
 * d'ouverture.
 *
 * Rendu par la base plutôt que retrié à chaque écran — sans `orderBy`,
 * PostgreSQL n'en garantit aucun, et la vitrine afficherait la semaine dans un
 * ordre différent d'un appel à l'autre.
 *
 * Déclaré à part et typé, plutôt qu'écrit dans le `select` : `as const` rendrait
 * le tableau `readonly`, que Prisma n'accepte pas dans un `orderBy`.
 */
const OPENING_HOURS_ORDER: Prisma.TenantOpeningHourOrderByWithRelationInput[] = [
  { weekday: 'asc' },
  { startMinute: 'asc' },
];

const PUBLIC_TENANT_SELECT = {
  id: true,
  slug: true,
  name: true,
  timezone: true,
  defaultCurrency: true,
  contactEmail: true,
  contactPhone: true,
  // Adresse et horaires — #343. Publiés comme les contacts : facultatifs, omis
  // quand ils manquent. Un salon sans adresse reste servi, et sa vitrine a la
  // forme qu'elle avait avant l'existence de ces colonnes.
  addressLine1: true,
  addressLine2: true,
  postalCode: true,
  city: true,
  countryCode: true,
  openingHours: {
    select: { weekday: true, startMinute: true, endMinute: true },
    orderBy: OPENING_HOURS_ORDER,
  },
} as const;

/**
 * La vue back-office ajoute ce que le public n'a pas à connaître : l'état
 * d'activation, l'identité légale et le taux de taxe (#913).
 *
 * Le contraste avec `PUBLIC_TENANT_SELECT` est la garde : un champ ajouté ici
 * n'atteint jamais la vitrine, et c'est le seul endroit où cela se décide.
 */
const TENANT_SELECT = {
  ...PUBLIC_TENANT_SELECT,
  isActive: true,
  legalName: true,
  legalIdType: true,
  legalId: true,
  vatNumber: true,
  receiptFooter: true,
  receiptPrefix: true,
  taxRateBps: true,
} as const;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Le type généré par Prisma exige `tenantId` : il décrit la colonne, et la
 * colonne est `NOT NULL`. Or le repository ne doit justement **pas** le fournir —
 * c'est l'extension de scoping qui le pose, depuis le contexte de requête, et qui
 * écrase ce qui s'y trouverait (`tenant-scope.extension.ts`).
 *
 * Les deux vérités ne se rencontrent pas dans le système de types : `$extends` ne
 * réécrit pas les types d'entrée de Prisma. La conversion est donc nécessaire, et
 * elle est **concentrée ici** — une fonction, un commentaire, deux sites d'appel —
 * plutôt que dispersée en autant de `as` que de créations.
 *
 * Ce qui la rend sûre n'est pas une promesse : c'est que l'extension refuse toute
 * opération sans contexte de tenant, et que la colonne est `NOT NULL` sans valeur
 * par défaut. Si l'extension venait à être contournée, l'insertion échouerait en
 * base — bruyamment, jamais en silence.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = 'P2002';

/** `UserRecord` sans son empreinte — ce qui peut sortir du module. */
export function toProfile(user: UserRecord): UserProfile {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
  };
}

/**
 * Le profil **plus** l'état d'activation — ce que rendent les routes
 * d'administration des comptes (#695).
 *
 * Écrit à côté de `toProfile` plutôt qu'en étalant `{ ...toProfile(u), isActive }`
 * sur chaque site d'appel : les trois routes concernées doivent rendre exactement
 * la même forme, et un champ ajouté à l'une seulement est précisément le défaut
 * que ce ticket corrige.
 */
export function toStaffAccount(user: UserRecord): StaffAccountState {
  return { ...toProfile(user), isActive: user.isActive };
}

@Injectable()
export class IdentityRepository {
  public constructor(
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
    // Dérogation au scoping. Deux requêtes du module passent par cette porte,
    // et deux seulement : `findTenantIdBySlug` et `listTenantTimeZones`.
    //
    // La première résout l'établissement depuis son slug — par construction une
    // opération **sans tenant courant**, puisque c'est elle qui va le
    // déterminer, avant toute authentification. Le filtre par tenant n'a donc
    // rien à filtrer : il y a un `slug` unique global, et c'est lui la clé. Le
    // résultat est immédiatement posé dans le contexte.
    //
    // La seconde balaie le fuseau de **tous** les établissements au démarrage
    // (#604), hors de toute requête HTTP : aucune portée n'y est résolue, et
    // rien de ce qu'elle rend ne sort par une route. Voir son commentaire.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /**
   * Résout un établissement actif depuis son slug public.
   *
   * Ne renvoie **que** l'identifiant : le reste de la fiche n'a rien à faire dans
   * le module `identity`, et un objet complet finirait par être renvoyé au client.
   */
  public async findTenantIdBySlug(slug: string): Promise<string | null> {
    const tenant = await this.prismaUnscoped.tenant.findUnique({
      where: { slug },
      select: { id: true, isActive: true },
    });

    // Un établissement désactivé se comporte comme un établissement inexistant :
    // distinguer les deux dirait à un visiteur qu'un salon a fermé, et lequel.
    if (tenant === null || !tenant.isActive) {
      return null;
    }
    return tenant.id;
  }

  /**
   * Le fuseau déclaré par **chaque** établissement — la matière du contrôle de
   * démarrage (#604).
   *
   * ## Pourquoi le client non scopé, et pourquoi c'est légitime ici
   *
   * Seconde dérogation de ce fichier, et de même nature que la première : le
   * balayage est inter-tenant **par construction** — il n'a pas d'établissement
   * courant à filtrer, il les inspecte tous —, et il s'exécute hors de toute
   * requête HTTP, au démarrage du module, là où aucune portée n'est résolue. Le
   * client scopé lèverait plutôt que de rendre les lignes.
   *
   * Rien de ce qu'elle rend ne sort par une route : le seul appelant est
   * `TenantTimeZoneAudit`, qui journalise et n'a pas de contrôleur.
   *
   * ## Pourquoi le tri se fait ici et le filtre ailleurs
   *
   * Le `where` qu'on voudrait écrire — « les fuseaux que le moteur ne résout
   * pas » — n'est pas exprimable en SQL : l'ensemble valide est celui d'ICU, il
   * suit tzdata, et PostgreSQL n'a aucun moyen de le tenir. C'est la raison
   * même pour laquelle #604 refuse d'y poser une contrainte `CHECK`. Le tri, en
   * revanche, revient à la base : `slug` est unique et indexé, ce qui rend le
   * relevé reproductible d'un démarrage à l'autre.
   *
   * ## Aucun `where`, pas même sur `isActive` — c'est un choix
   *
   * La revue de #604 a relevé qu'un salon désactivé au fuseau fautif se
   * signalerait à chaque démarrage de chaque tâche. C'est exact, et c'est
   * accepté : `isActive` est un état **réversible** — un salon se réactive
   * depuis le back-office —, et un fuseau fautif qui n'aurait été signalé que
   * pendant l'inactivité redeviendrait silencieux à l'instant précis où il se
   * remet à décaler des rendez-vous. Un relevé dont la couverture dépend d'un
   * drapeau qu'un écran peut retourner ne couvre rien de façon fiable.
   *
   * Le signalement reste par ailleurs **refermable** par celui qui le lit : un
   * `PATCH /api/v1/tenant` ou une correction en base fait disparaître la ligne
   * au démarrage suivant, salon actif ou non. Ce n'est donc pas un
   * avertissement qu'on ne peut pas éteindre — c'en est un qu'il faut traiter.
   *
   * ## Le coût
   *
   * Une lecture de trois colonnes sur `tenants`, une fois par démarrage de
   * processus. La table compte un établissement par salon abonné : à l'échelle
   * du MVP, c'est un aller-retour, pas une pagination.
   */
  public async listTenantTimeZones(): Promise<TenantTimeZoneRecord[]> {
    return this.prismaUnscoped.tenant.findMany({
      select: { id: true, name: true, timezone: true },
      orderBy: { slug: 'asc' },
    });
  }

  /**
   * La vitrine publique de l'établissement **de la portée courante**.
   *
   * Par le client **scopé**, et sans le moindre `where` : l'extension borne le
   * modèle racine sur son `id` (`tenant-scope.extension.ts`), si bien que cette
   * requête ne peut lire que l'établissement que le middleware a résolu. Passer
   * un identifiant en paramètre rouvrirait justement ce que le scoping ferme —
   * il faudrait alors se demander d'où il vient, à chaque site d'appel.
   *
   * Hors portée résolue, l'extension lève plutôt que de tout rendre : la route
   * publique est donc illisible tant que le slug n'a pas été résolu.
   */
  public async findCurrentPublicTenant(): Promise<PublicTenantRecord | null> {
    return this.prisma.tenant.findFirst({ select: PUBLIC_TENANT_SELECT });
  }

  /**
   * L'établissement courant tel que le back-office le règle — la vitrine, plus
   * `isActive` (#343).
   *
   * Même lecture que `findCurrentPublicTenant`, même client scopé, même absence
   * de `where` : l'extension borne le modèle racine sur son `id`. Ce qui les
   * distingue est la **projection**, et c'est le seul endroit où cela doit se
   * décider — un champ ajouté à `TENANT_SELECT` n'atteint jamais la vitrine.
   */
  public async findCurrentTenant(): Promise<TenantRecord | null> {
    return this.prisma.tenant.findFirst({ select: TENANT_SELECT });
  }

  /**
   * Le seul champ dont la normalisation d'un numéro de téléphone a besoin — le
   * pays de l'établissement courant, ISO 3166-1 alpha-2 (#824).
   *
   * Une lecture à un champ plutôt qu'un `findCurrentTenant` déjà écrit au-dessus,
   * et ce n'est pas une micro-optimisation : cette requête a lieu sur
   * l'inscription publique et sur chaque invitation, où rien d'autre de la fiche
   * du salon n'est utilisé. Rendre la vitrine entière ferait voyager jusque dans
   * ces services les coordonnées de contact du salon, qui n'ont aucune raison
   * d'y être (même arbitrage que `TenantTimeZoneRecord`, #604).
   *
   * `null` a deux causes indistinctes, et c'est voulu : l'établissement n'a pas
   * saisi son adresse — les cinq colonnes sont nullables —, ou la ligne a
   * disparu. Les deux se traitent pareil en aval : sans pays, un numéro national
   * n'est pas complétable et le refus le dit.
   *
   * Par le client **scopé** et sans `where`, comme ses deux voisines :
   * l'extension borne le modèle racine sur son `id`.
   */
  public async findCurrentTenantCountryCode(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { countryCode: true } });

    return tenant?.countryCode ?? null;
  }

  /**
   * Écrit les réglages de l'établissement courant — colonnes **et** semaine
   * d'ouverture — dans **une seule transaction** (#343, corrigé par #416).
   *
   * ## Pourquoi une seule méthode plutôt que deux
   *
   * Les deux écritures étaient exposées séparément, et l'appelant les enchaînait :
   * les colonnes d'abord, la semaine ensuite, dans sa propre transaction.
   * L'échec de la seconde laissait la première commitée — l'adresse enregistrée,
   * les horaires non, et aucune réponse rendue. Une surface qui offre les deux
   * portes séparément *invite* à cette séquence ; la refermer est le correctif,
   * pas une commodité de nommage. C'est aussi pour cela que l'écriture des
   * horaires n'est plus appelable seule : un `openingHours` absent n'y touche
   * pas, un tableau vide efface la semaine.
   *
   * ## Ce que la transaction garantit, et à qui
   *
   * Deux propriétés distinctes, souvent confondues :
   *
   * - pour l'**écrivain**, tout ou rien — c'est ce que #416 ajoute ;
   * - pour le **lecteur**, aucune fenêtre entre le `deleteMany` et le
   *   `createMany` où la vitrine servirait une semaine vide — c'est ce que la
   *   transaction de `replaceOpeningHours` tenait déjà, et qui est conservé.
   *
   * ## Le reste, inchangé
   *
   * `updateMany` et non `update`, pour la raison qui vaut partout dans ce
   * fichier : sous le scoping, le `where` du modèle racine porte son `id`, et le
   * compte de lignes est la propriété utile. Il vaut `0` si l'établissement a
   * disparu entre la résolution et l'écriture, ce qui donne le 404 attendu
   * plutôt qu'une exception « record not found » indistinguable d'un incident.
   * Ce `false` sort **avant** que la semaine ne soit touchée : un établissement
   * disparu ne voit pas ses horaires réécrits.
   *
   * Une demande qui ne porte **que** la semaine n'a pas de `updateMany` dont
   * lire le compte : l'existence s'y vérifie par un `count` scopé, dans la même
   * transaction. Sans lui, ce cas-là seul rendrait 200 — ou une violation de
   * clé étrangère, donc 500 — là où les autres rendent 404. Le contrat ne peut
   * pas dépendre des champs que le formulaire a envoyés.
   *
   * Une demande vide n'est pas une erreur — c'est une modification sans effet.
   * L'écrire quand même ferait tourner `updated_at` pour rien, et ouvrir une
   * transaction pour n'y rien faire coûterait un aller-retour de plus.
   *
   * Aucun `tenantId` n'est fourni nulle part : l'extension pose le filtre sur la
   * mise à jour et la suppression, la colonne sur la création, et elle
   * **écrase** ce qui s'y trouverait. Un `tenantId` qui aurait traversé la
   * validation n'aurait donc aucun effet — c'est ce qui rend impossible de vider
   * les horaires d'un établissement voisin.
   */
  public async updateTenantSettings(input: {
    changes: TenantSettingsChanges;
    /** Absent : la semaine n'est pas touchée. Vide : elle est effacée. */
    openingHours?: readonly OpeningHourRecord[];
  }): Promise<boolean> {
    const writesColumns = Object.keys(input.changes).length > 0;

    if (!writesColumns && input.openingHours === undefined) {
      return true;
    }

    return this.prisma.$transaction(async (tx) => {
      if (writesColumns) {
        const { count } = await tx.tenant.updateMany({ data: input.changes });

        if (count !== 1) {
          return false;
        }
      } else if ((await tx.tenant.count({})) !== 1) {
        // Ici, `openingHours` est nécessairement fourni — le cas « rien à
        // écrire » est sorti plus haut. Le `count` scopé tient le même rôle que
        // celui de l'`updateMany` : l'établissement a disparu, on ne réécrit
        // pas sa semaine et l'appelant obtient son 404.
        return false;
      }

      if (input.openingHours !== undefined) {
        await tx.tenantOpeningHour.deleteMany({});

        if (input.openingHours.length > 0) {
          await tx.tenantOpeningHour.createMany({
            data: input.openingHours.map((entry) =>
              withScopedTenant<Prisma.TenantOpeningHourUncheckedCreateInput>({
                weekday: entry.weekday,
                startMinute: entry.startMinute,
                endMinute: entry.endMinute,
              }),
            ),
          });
        }
      }

      return true;
    });
  }

  /**
   * Retrouve un compte par son adresse, dans le tenant courant.
   *
   * `findFirst` et non `findUnique` : l'unique du schéma est
   * `(tenant_id, email)`, et l'extension de scoping injecte `tenantId` dans le
   * `where` — or `findUnique` exige que le `where` désigne *exactement* une clé
   * unique, ce que `{ email, tenantId }` ne fait pas sous cette forme.
   */
  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { email },
      select: USER_SELECT,
    });
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id },
      select: USER_SELECT,
    });
  }

  /**
   * Un **compte interne** de l'établissement courant, par identifiant.
   *
   * Le filtre sur le rôle est ce qui distingue cette lecture de `findUserById`,
   * et il n'est pas cosmétique : sans lui, `GET /users/:id` — une route ouverte
   * au rang `STAFF` — rendrait la fiche d'une cliente, nom, e-mail et téléphone
   * compris, depuis un point d'entrée d'administration des droits. Les données
   * personnelles de la clientèle relèvent du module `crm` et de ses propres
   * permissions (CDC §5.1) ; ne pas les lire ici est plus sûr que d'espérer que
   * personne n'appelle la route avec le bon identifiant.
   *
   * Un compte `CLIENT` du tenant courant est donc **introuvable** par cette
   * méthode, exactement comme un compte d'un autre établissement — et pour la
   * même raison de forme : le service traduit `null` en 404, sans avoir à
   * choisir entre deux motifs de refus.
   */
  public async findStaffAccountById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findFirst({
      where: { id, role: { in: [...STAFF_ROLES] } },
      select: USER_SELECT,
    });
  }

  /**
   * Crée un compte dans le tenant courant.
   *
   * Aucun `tenantId` n'est passé : c'est l'extension qui le pose, et elle
   * **écrase** ce qui s'y trouverait. Un `tenantId` qui aurait traversé la
   * validation n'aurait donc aucun effet.
   *
   * La violation de `@@unique([tenantId, email])` est traduite ici, et pas
   * ailleurs : c'est le seul point du module qui connaît les codes d'erreur de
   * Prisma. Le contrôle préalable du service est une courtoisie — c'est la base
   * qui tranche, et deux inscriptions concurrentes sur la même adresse le
   * passent toutes les deux. Sans cette traduction, la perdante recevrait un 500
   * « erreur interne » là où le contrat annonce un 409.
   */
  public async createUser(input: {
    email: string;
    role: UserRole;
    /**
     * `null` crée un compte **en attente d'activation** : c'est ainsi qu'une
     * invitation de personnel se matérialise (#55), sans colonne nouvelle. La
     * colonne est déjà nullable au schéma — « un client peut exister sans
     * compte, saisi au comptoir par le staff » — et un compte sans empreinte est
     * inconnectable, `PasswordHasher.verify` refusant un `null` avant toute
     * comparaison.
     */
    passwordHash: string | null;
    firstName: string;
    lastName: string;
    phone: string | null;
    /**
     * Instant auquel la personne a accepté le traitement de ses données —
     * `null` quand personne n'a rien coché (#880).
     *
     * Obligatoire à l'appel, et non facultatif : les deux seuls points de
     * création de compte du module doivent **décider**, et un paramètre qu'on
     * peut omettre se serait oublié sur le chemin qui recueille l'accord. Le
     * chemin qui ne le recueille pas — l'invitation d'un membre du personnel
     * (#55) — passe `null`, ce qui est exactement ce que la colonne signifie.
     *
     * La date vient du **serveur** : ni le corps de la requête ni le contrat
     * n'en portent une (RGPD art. 7.1).
     */
    dataConsentAt: Date | null;
  }): Promise<UserRecord> {
    try {
      return await this.prisma.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: input.email,
          role: input.role,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          dataConsentAt: input.dataConsentAt,
        }),
        // `USER_SELECT` et non une projection élargie : la preuve s'écrit ici,
        // elle ne ressort pas par la porte de l'authentification. Aucune
        // surface d'`identity` n'a à la lire — voir l'en-tête de `USER_SELECT`.
        select: USER_SELECT,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  public async touchLastLogin(userId: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  /**
   * Les **comptes internes** de l'établissement courant — le « comptes staff »
   * du CDC §1.4.
   *
   * Le filtre sur `role` n'est pas cosmétique : sans lui, la lecture ramènerait
   * aussi la clientèle, qui se compte en milliers là où le personnel se compte
   * en dizaines. Les fiches clients relèvent du module `crm` et de sa
   * pagination ; ce point d'entrée-ci répond à une question d'administration des
   * droits, et sa taille est bornée par nature.
   *
   * `@@index([tenantId, role])` du schéma sert exactement cette requête — c'est
   * la seule qui filtre sur ce couple.
   *
   * La projection porte `isActive` depuis #695 : l'écran qui lit cette liste est
   * celui d'où l'on ferme et rouvre un accès, et il ne peut pas le faire à
   * l'aveugle.
   */
  public async listStaffAccounts(): Promise<StaffAccountState[]> {
    return this.prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      select: PROFILE_SELECT,
      // Ordre stable : le rang d'abord, l'adresse pour départager. Sans `orderBy`,
      // PostgreSQL n'en garantit aucun et la liste change d'un appel à l'autre.
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
    });
  }

  /**
   * Attribue un rôle à un compte de l'établissement courant.
   *
   * `updateMany` et non `update` : sous le scoping, le `where` porte à la fois
   * `id` et `tenantId`, ce qui n'est pas une clé unique au sens de Prisma. Le
   * compte est surtout la propriété utile — il vaut `0` pour un identifiant d'un
   * autre établissement, ce qui donne le 404 attendu plutôt qu'une exception
   * « record not found » indistinguable d'un incident.
   */
  public async updateUserRole(input: { userId: string; role: UserRole }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId },
      data: { role: input.role },
    });
    return count === 1;
  }

  /**
   * Active ou désactive un **compte interne** de l'établissement courant (#55).
   *
   * `is_active` et non un `DELETE` : le CDC réclame la désactivation « sans
   * suppression des rendez-vous passés », et les clés étrangères d'`Appointment`
   * et de `Staff` vers `users` sont en `Restrict` — un `DELETE` échouerait de
   * toute façon dès la première visite honorée. Le compte reste donc lisible,
   * l'historique reste comptable au reporting, et seule la connexion se ferme
   * (`AuthService.login` refuse un compte inactif, `refresh` éteint sa session).
   *
   * Le filtre sur le rôle borne l'opération au **personnel** : la clientèle
   * relève du module `crm`, et un identifiant de cliente rend ici `false`, donc
   * 404 — la même réponse qu'un identifiant d'un autre établissement, sans avoir
   * à choisir entre deux motifs de refus.
   */
  public async setStaffAccountActive(input: {
    userId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId, role: { in: [...STAFF_ROLES] } },
      data: { isActive: input.isActive },
    });
    return count === 1;
  }

  /**
   * Pose le **premier** mot de passe d'un compte invité — #55.
   *
   * `passwordHash: null` est dans le `where`, pas seulement vérifié en amont, et
   * c'est ce qui rend l'acceptation d'une invitation à usage unique **sans
   * colonne dédiée** : la première acceptation renseigne la colonne, toute autre
   * ne trouve plus de ligne à mettre à jour et reçoit `false`. Deux acceptations
   * concurrentes du même jeton se disputent la même ligne ; une seule gagne.
   *
   * C'est l'exacte transposition de la rotation atomique de `rotateSession`, et
   * ce qui permet de livrer l'invitation sans toucher au schéma — hors empreinte.
   *
   * Ne peut jamais **remplacer** un mot de passe existant : le `where` l'interdit.
   * Une réinitialisation de mot de passe est une autre procédure, avec sa propre
   * preuve de possession de l'adresse.
   */
  public async setInitialPassword(input: {
    userId: string;
    passwordHash: string;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId, passwordHash: null },
      data: {
        passwordHash: input.passwordHash,
        // « Le jeton est invalidé par tout changement de mot de passe » — le
        // deuxième critère de #809, appliqué ici aussi. Une invitation acceptée
        // *est* un mot de passe posé : un lien de réinitialisation demandé
        // entre-temps ne doit plus ouvrir le compte. Le cas est étroit — il
        // faudrait qu'une réinitialisation ait été demandée sur un compte encore
        // sans mot de passe — mais c'est justement le genre de cas qu'aucun
        // appelant ne pense à couvrir, et la colonne est ici.
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });
    return count === 1;
  }

  /**
   * L'état de réinitialisation d'un compte — #809.
   *
   * Une projection à part et non trois champs de plus dans `USER_SELECT` : le
   * reste du module n'a rien à faire d'une empreinte de jeton, et l'élargir
   * l'aurait fait voyager dans tous les `UserRecord` du module — jusqu'aux
   * frontières où l'on vérifie, justement, que rien de sensible ne sort.
   *
   * Rend `null` pour un compte d'un autre établissement, exactement comme pour
   * un compte inexistant : le client scopé ne fait pas la différence, et c'est ce
   * qui donne le refus indistinct du cinquième critère d'acceptation.
   */
  public async findPasswordResetState(userId: string): Promise<PasswordResetState | null> {
    return this.prisma.user.findFirst({
      where: { id: userId },
      select: PASSWORD_RESET_SELECT,
    });
  }

  /**
   * Arme le jeton de réinitialisation d'un compte — #809, premier et deuxième
   * critères.
   *
   * ## L'écriture **est** l'invalidation du jeton précédent
   *
   * L'empreinte est écrasée, pas ajoutée : le lien envoyé cinq minutes plus tôt
   * cesse d'ouvrir quoi que ce soit à l'instant même où celui-ci part. C'est ce
   * que « le jeton est invalidé par l'émission d'un nouveau jeton » demande, et
   * cela ne coûte aucune écriture supplémentaire — voir l'en-tête de la colonne
   * dans `schema.prisma`.
   *
   * `requestedAt` est écrit dans la même opération, et il borne le débit de la
   * demande suivante. Il ne s'efface jamais : une demande consommée doit
   * continuer de compter.
   *
   * ## C'est le `where` qui porte la limite de débit par adresse — #1034
   *
   * `notRequestedSince` est l'instant au plus tard auquel la demande précédente
   * doit se situer pour qu'une nouvelle soit servie. Il est **dans le `where`**, et non
   * dans une comparaison faite en amont : deux demandes parties ensemble sur la
   * même adresse lisent la même ligne, passent toutes deux le contrôle
   * applicatif, et arriveraient toutes deux ici. Sous `READ COMMITTED`, la
   * seconde bloque sur le verrou de ligne de la première, puis **réévalue** son
   * `where` contre la version que celle-ci vient d'écrire : `requested_at` y vaut
   * désormais l'instant de la gagnante, ni nul ni antérieur au seuil. Elle rend
   * `count: 0`, et le service n'émet rien.
   *
   * Sans cela, deux courriers partaient pour une seule fenêtre, et le lien du
   * premier n'ouvrait rien — la seconde écriture ayant écrasé son empreinte.
   * C'est la même classe de défaut que booking-engine §1 interdit au moteur de
   * réservation : une vérification applicative là où la base doit trancher.
   *
   * La valeur nulle est acceptée explicitement — un compte qui n'a jamais rien
   * demandé n'a pas de `requested_at` à comparer, et une comparaison SQL contre
   * `NULL` ne rend pas `true`.
   *
   * La comparaison est **large** (`lte`), et non stricte, parce qu'elle doit
   * décider exactement comme `AuthService.isWithinResetCooldown` : ce raccourci
   * refuse tant que l'écart est *strictement* inférieur au délai, donc il laisse
   * passer l'instant où l'écart vaut exactement le délai. Avec un `lt`, cet
   * instant-là — atteignable, `requested_at` étant un `timestamp(3)` à la
   * milliseconde — passait le raccourci puis se faisait refuser ici : la
   * personne recevait un 202 sans courrier, et le journal l'attribuait à une
   * demande concurrente. La garantie contre la course, elle, ne bouge pas : deux
   * demandes parties ensemble portent un `requested_at` gagnant proche de leur
   * propre `now`, très au-dessus du seuil, quelle que soit la borne.
   *
   * `updateMany` pour la raison qui vaut partout dans ce fichier : sous le
   * scoping, le `where` porte `id` **et** `tenantId`, ce qui n'est pas une clé
   * unique au sens de Prisma. Le compte de lignes donne le `false` attendu pour
   * un compte disparu entre la lecture et l'écriture, comme pour une demande
   * trop rapprochée — le service ne distingue pas les deux, et n'a pas à le
   * faire : l'un et l'autre valent « rien à envoyer ».
   */
  public async armPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedAt: Date;
    notRequestedSince: Date;
  }): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: input.userId,
        OR: [
          { passwordResetRequestedAt: null },
          { passwordResetRequestedAt: { lte: input.notRequestedSince } },
        ],
      },
      data: {
        passwordResetTokenHash: input.tokenHash,
        passwordResetExpiresAt: input.expiresAt,
        passwordResetRequestedAt: input.requestedAt,
      },
    });
    return count === 1;
  }

  /**
   * Pose le nouveau mot de passe **et** consomme le jeton, en une écriture —
   * #809, deuxième et troisième critères.
   *
   * ## C'est le `where` qui fait l'usage unique
   *
   * L'écriture est conditionnée à l'empreinte attendue. Deux confirmations
   * concurrentes du même lien se disputent donc la ligne : la première l'emporte
   * et efface l'empreinte, la seconde ne trouve plus rien à mettre à jour et
   * reçoit `false`. L'unicité d'usage est ainsi portée par la base, jamais par
   * une vérification applicative — c'est le même procédé que `rotateSession` et
   * que `setInitialPassword`, et c'est la seule forme qui tienne sous
   * concurrence (booking-engine §1 le dit du moteur de réservation, la raison
   * est la même).
   *
   * L'échéance est vérifiée ici **aussi**, et pas seulement par le service :
   * c'est la base qui tranche, pas le porteur ni l'horloge de la tâche qui a lu
   * la ligne une milliseconde plus tôt.
   *
   * ## Ce que l'écriture efface, et ce qu'elle garde
   *
   * L'empreinte et l'échéance partent ensemble — `users_password_reset_pair_check`
   * l'exige, et c'est de toute façon ce qu'« un seul usage » veut dire.
   * `password_reset_requested_at` reste : sans lui, se servir du lien rouvrirait
   * aussitôt le droit d'en demander un autre.
   *
   * ## La révocation des sessions est **dans la même transaction**
   *
   * « Révoque tous les refresh tokens du compte » est le troisième critère, et il
   * ne se tient pas en deux écritures indépendantes : si la seconde échoue — une
   * coupure de connexion, un basculement RDS —, le mot de passe est changé, le
   * jeton est consommé, et les sessions ouvertes ailleurs survivent. Rien ne
   * permet alors de rattraper l'écart : le lien ne peut plus servir, et la
   * personne croit avoir reprise la main sur son compte alors que l'appareil dont
   * elle se protégeait y est toujours connecté. Les deux écritures sont donc
   * atomiques, ou aucune n'a lieu.
   */
  public async consumePasswordReset(input: {
    userId: string;
    expectedTokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: {
          id: input.userId,
          passwordResetTokenHash: input.expectedTokenHash,
          passwordResetExpiresAt: { gt: input.now },
        },
        data: {
          passwordHash: input.passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      });

      if (count !== 1) {
        return false;
      }

      await tx.refreshToken.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: input.now },
      });

      return true;
    });
  }

  /**
   * Met à jour les **coordonnées** d'un compte de l'établissement courant (#47,
   * étendu par #55).
   *
   * Nommée d'après ce qu'elle fait et non d'après son premier appelant : elle
   * n'a jamais rien su de « son propre compte » — c'est le service qui décide
   * quel identifiant lui passer, celui du jeton pour `PATCH /users/me`, celui du
   * chemin pour `PATCH /users/:id`. Le nom `updateOwnProfile` promettait ici une
   * garantie que cette couche ne peut pas tenir, et l'aurait fait croire acquise
   * au second appelant.
   *
   * `updateMany` et non `update`, pour la raison d'`updateUserRole` : sous le
   * scoping, le `where` porte `id` **et** `tenantId`, ce qui n'est pas une clé
   * unique au sens de Prisma. Le compte de lignes est surtout la propriété
   * utile — il vaut `0` pour l'identifiant d'un autre établissement, ce qui donne
   * le 404 attendu plutôt qu'une exception « record not found » indistinguable
   * d'un incident.
   *
   * `changes` ne porte que les champs **présents** : un `{ phone: null }` efface
   * le numéro, un `changes` sans `phone` n'y touche pas. C'est le contrôleur qui
   * fait cette distinction, et elle ne peut pas se faire ici — Prisma ignore un
   * `undefined` et écrirait `null` sur un `null`, ce qui est précisément la
   * différence à conserver.
   *
   * Aucun `email`, aucun `role`, aucun `isActive` : le type l'interdit, et c'est
   * ce qui empêche cette méthode de devenir la porte par laquelle un compte se
   * promeut lui-même.
   */
  public async updateContactDetails(input: {
    userId: string;
    changes: { firstName?: string; lastName?: string; phone?: string | null };
  }): Promise<boolean> {
    // Une demande vide n'est pas une erreur — c'est une modification sans effet.
    // L'écrire quand même ferait tourner `updated_at` pour rien.
    if (Object.keys(input.changes).length === 0) {
      return true;
    }

    const { count } = await this.prisma.user.updateMany({
      where: { id: input.userId },
      data: input.changes,
    });
    return count === 1;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    return this.prisma.refreshToken.create({
      data: withScopedTenant<Prisma.RefreshTokenUncheckedCreateInput>({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      }),
      select: SESSION_SELECT,
    });
  }

  public async findSessionById(id: string): Promise<SessionRecord | null> {
    return this.prisma.refreshToken.findFirst({
      where: { id },
      select: SESSION_SELECT,
    });
  }

  /**
   * Fait tourner l'empreinte d'une session — **si** elle porte encore celle
   * qu'on a présentée.
   *
   * Le `tokenHash` attendu est dans le `where`, pas seulement vérifié en amont :
   * c'est ce qui rend la rotation atomique. Deux rafraîchissements concurrents
   * partant du même jeton se disputent la même ligne ; le premier la met à jour,
   * le second ne trouve plus rien à mettre à jour et reçoit `0`. Sans cette
   * condition, les deux réussiraient et la détection de réemploi ne verrait rien.
   *
   * L'empreinte remplacée et l'instant de la rotation sont conservés dans la
   * même écriture (#856) : c'est ce qui permet au perdant d'une course de se
   * reconnaître comme tel, au lieu de passer pour un réemploi. `rotatedAt` vaut
   * `null` pour l'estampillage d'une session qui s'ouvre : l'empreinte de
   * remplissage ne correspond à aucun jeton émis, il n'y a rien à retenir.
   *
   * Renvoie `true` si la rotation a eu lieu.
   */
  public async rotateSession(input: {
    sessionId: string;
    expectedTokenHash: string;
    nextTokenHash: string;
    expiresAt: Date;
    rotatedAt: Date | null;
  }): Promise<boolean> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: {
        id: input.sessionId,
        tokenHash: input.expectedTokenHash,
        revokedAt: null,
      },
      data: {
        tokenHash: input.nextTokenHash,
        expiresAt: input.expiresAt,
        ...(input.rotatedAt === null
          ? {}
          : { previousTokenHash: input.expectedTokenHash, rotatedAt: input.rotatedAt }),
      },
    });

    return count === 1;
  }

  /**
   * Éteint une session. Idempotent : `revoked_at` n'est posé que s'il est encore
   * nul, une session révoquée ne se « re-révoque » donc pas à une date plus
   * tardive — ce qui garderait une trace fausse de l'instant de la déconnexion.
   */
  public async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Éteint **toutes** les sessions vivantes d'un compte.
   *
   * Appelée quand c'est le **compte** qui change d'état, et par personne d'autre :
   * une rétrogradation de rôle et une désactivation voyagent dans des jetons déjà
   * signés, et resteraient sans effet le temps du renouvellement si la chaîne
   * n'était pas coupée partout (`users.service.ts`).
   *
   * Un réemploi de jeton, lui, n'est pas de cette nature et n'appelle plus cette
   * méthode depuis #862 : il n'incrimine qu'une session — celle dont l'empreinte
   * ressort —, et `revokeSession` suffit à l'éteindre. Étendre la révocation au
   * compte entier déconnectait les autres appareils sans rien ôter à qui aurait
   * volé le jeton.
   */
  public async revokeAllSessionsOfUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
