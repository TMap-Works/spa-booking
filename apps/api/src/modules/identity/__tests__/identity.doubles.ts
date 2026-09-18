import { randomUUID } from 'node:crypto';

import { DEFAULT_RECEIPT_PREFIX } from '@spa/shared';

import { getTenantId } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import { toStaffAccount } from '../identity.repository';
import type {
  IdentityRepository,
  OpeningHourRecord,
  PasswordResetState,
  PublicTenantRecord,
  SessionRecord,
  TenantRecord,
  TenantSettingsChanges,
  TenantTimeZoneRecord,
  UserRecord,
} from '../identity.repository';
import type { StaffAccountState } from '../identity.types';
import { STAFF_ROLES, USER_ROLE_RANK, type UserRole } from '../roles';

/**
 * Doubles du module `identity`, partagés par ses suites unitaires.
 *
 * Le dépôt en mémoire reproduit **une propriété précise** du vrai : le scoping
 * par tenant. Chaque ligne porte son `tenantId`, et toute lecture le filtre —
 * exactement ce que l'extension Prisma fait en vrai. Un double qui ignorerait le
 * tenant ferait passer les tests d'isolation pour de mauvaises raisons, ce qui
 * est pire que de ne pas les écrire.
 */

/** Configuration minimale — coût bcrypt plancher, la suite ne mesure pas le temps. */
export function fakeConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    nodeEnv: 'test',
    isProduction: false,
    bcryptCost: 4,
    jwtSecret: 'unit-test-access-key-not-a-secret-000001',
    jwtRefreshSecret: 'unit-test-refresh-key-not-a-secret-00002',
    jwtExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    ...overrides,
  } as AppConfigService;
}

/**
 * L'erreur rejetée par une promesse, pour les assertions qui portent sur son
 * **contenu** — code, message, `details` — et pas seulement sur son type.
 *
 * `expect(...).rejects` ne rend pas l'erreur, et un `.catch((error) => error)`
 * donne un type union avec la valeur de succès, qu'il faut ensuite transtyper.
 * Ici la promesse qui aboutit est un échec de test explicite, et ce qui revient
 * est l'erreur, rien d'autre.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

export function silentLogger(): StructuredLogger {
  return {
    // `log` manquait, et l'`as unknown as` le laissait passer : le double ne
    // portait que les trois niveaux que le module employait jusqu'ici. Le
    // premier appelant de `log` — `IdentityEvents`, #809 — échouait donc en
    // `this.logger.log is not a function`, sur un chemin que la production sert
    // très bien. Les quatre niveaux sont désormais là, pour que le prochain
    // n'ait pas à le redécouvrir.
    log: (): void => undefined,
    error: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;
}

type StoredTenant = TenantRecord;

interface StoredUser extends UserRecord {
  tenantId: string;
  /**
   * La preuve de consentement, telle que la colonne la porte (#880).
   *
   * Sur le **stockage** et non sur `UserRecord` : `USER_SELECT` ne la lit pas,
   * et un double qui la rendrait avec le compte laisserait passer une projection
   * élargie par distraction. Ce qui l'observe, c'est la suite qui l'observe en
   * base — la lire ici sert à prouver ce que le service a écrit, pas à l'offrir
   * à `toProfile`.
   *
   * Facultative, et c'est ce qui la rend adoptable : des suites d'autres modules
   * poussent des comptes directement dans `users` pour se donner un praticien ou
   * une cliente, et exiger ici une preuve de consentement leur ferait renseigner
   * un champ dont leur scénario ne dit rien. Absent se lit comme `null` — aucun
   * accord recueilli en ligne —, ce que la colonne signifie déjà.
   */
  dataConsentAt?: Date | null;
  /**
   * L'état de réinitialisation, tel que les trois colonnes le portent (#809).
   *
   * Sur le **stockage** et non sur `UserRecord`, pour la raison de
   * `dataConsentAt` : `USER_SELECT` ne les lit pas, et un double qui les rendrait
   * avec le compte laisserait passer une projection élargie par distraction —
   * ici une empreinte de jeton, dans chaque connexion.
   *
   * Facultatives, donc : un compte poussé par une suite d'un autre module n'a
   * aucune réinitialisation en cours, et absent se lit comme `null`, ce que les
   * colonnes signifient déjà.
   */
  passwordResetTokenHash?: string | null;
  passwordResetExpiresAt?: Date | null;
  passwordResetRequestedAt?: Date | null;
}

interface StoredSession extends SessionRecord {
  tenantId: string;
}

/**
 * Dépôt en mémoire.
 *
 * Il filtre sur le **vrai** contexte de tenant (`getTenantId()`), celui-là même
 * que l'extension Prisma consulte. C'est ce qui rend les tests d'isolation
 * probants : un double qui tiendrait son propre `currentTenantId` ne testerait
 * que sa propre comptabilité, et laisserait passer précisément la faute qu'on
 * cherche — une garde qui n'ouvre pas la portée, ou qui l'ouvre sur le mauvais
 * établissement.
 *
 * Le défaut est fermé, comme en vrai : sans portée résolue, aucune lecture.
 */
export class FakeIdentityRepository {
  public readonly tenants = new Map<string, string>();
  public readonly tenantRecords = new Map<string, StoredTenant>();
  public readonly users: StoredUser[] = [];
  public readonly sessions: StoredSession[] = [];

  /**
   * Déclare un établissement.
   *
   * `isActive` est modélisé parce que le vrai dépôt s'en sert : un salon
   * désactivé se comporte comme un salon inexistant, et un double qui
   * l'ignorerait ferait passer au vert une résolution que la production refuse.
   */
  public addTenant(
    // `string` et non le littéral gabarit qu'infère `randomUUID()` : une suite
    // qui **re-déclare** l'établissement de sa fixture pour lui poser un pays
    // (#824) lui repasse l'identifiant qu'elle a reçu, et il est typé `string`.
    // Le gabarit ne décrivait de toute façon rien qu'on veuille imposer ici —
    // le double ne valide pas la forme d'un UUID.
    slug: string,
    tenantId: string = randomUUID(),
    overrides: Partial<Omit<StoredTenant, 'id' | 'slug'>> = {},
  ): string {
    this.tenants.set(slug, tenantId);
    this.tenantRecords.set(tenantId, {
      id: tenantId,
      slug,
      name: `Établissement ${slug}`,
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
      contactEmail: `contact@${slug}.test`,
      contactPhone: '+33100000000',
      // Adresse et horaires **absents** par défaut (#343) : c'est l'état d'un
      // salon fraîchement inscrit, et celui de tous les établissements déjà en
      // base au moment de la migration. Les poser par défaut aurait fait passer
      // au vert une vitrine qui ne se sert jamais sans eux — alors que le
      // critère est justement qu'un salon sans adresse reste servi. Les tests
      // qui les veulent les déclarent en `overrides`.
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
      openingHours: [],
      isActive: true,
      // Identité légale **absente** par défaut, pour la raison qui vaut déjà
      // pour l'adresse : c'est l'état d'un salon fraîchement inscrit, et celui
      // de tous les établissements en base au moment de la migration de #818.
      legalName: null,
      legalIdType: null,
      legalId: null,
      vatNumber: null,
      receiptFooter: null,
      // Le préfixe et le taux, eux, ont un défaut en base — les poser ici à
      // `null` ferait passer au vert un ticket numéroté `null-2026-000123`.
      receiptPrefix: DEFAULT_RECEIPT_PREFIX,
      taxRateBps: 0,
      ...overrides,
    });
    return tenantId;
  }

  public addUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string | null;
    /**
     * `UserRole` comme en base : le double n'écrit que des rôles que
     * `enum UserRole` connaît, et il les connaît désormais tous les quatre
     * (#202). Un double capable d'écrire un rôle que PostgreSQL refuserait
     * ferait passer au vert un scénario impossible en production — c'est
     * `roles.spec.ts` qui tient cette équivalence, en comparant le vocabulaire
     * à l'énumération réellement générée.
     */
    role?: UserRole;
    isActive?: boolean;
    /**
     * Facultatif ici, obligatoire sur `createUser` — et l'asymétrie est
     * délibérée (#880). `createUser` est le **code de production** : il doit
     * décider. `addUser` sème un compte déjà là, dont l'immense majorité des
     * suites ne sait rien du consentement ; `null` est ce qu'est un compte
     * antérieur à la colonne, et c'est le bon défaut.
     */
    dataConsentAt?: Date | null;
  }): StoredUser {
    const user: StoredUser = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email: input.email,
      role: input.role ?? 'CLIENT',
      passwordHash: input.passwordHash,
      firstName: 'Alice',
      lastName: 'Durand',
      phone: null,
      isActive: input.isActive ?? true,
      dataConsentAt: input.dataConsentAt ?? null,
    };
    this.users.push(user);
    return user;
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Défaut fermé, comme l'extension : sans tenant, pas de données. Ne jamais
      // retomber sur « toutes les lignes » — c'est le mode ouvert qui fuit.
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }
    return tenantId;
  }

  /**
   * Résolution du slug — la **seule** lecture légitimement hors portée, comme le
   * `prismaUnscoped` du vrai dépôt : c'est elle qui détermine le tenant, elle ne
   * peut donc pas déjà le connaître. Elle ne pose rien dans le contexte : c'est
   * `AuthService` qui appelle `setRequestTenantId`, et c'est ce chemin-là qu'on
   * veut exercer.
   */
  public async findTenantIdBySlug(slug: string): Promise<string | null> {
    const tenantId = this.tenants.get(slug);
    if (tenantId === undefined) {
      return null;
    }
    // Désactivé = introuvable, comme dans le vrai dépôt.
    return this.tenantRecords.get(tenantId)?.isActive === false ? null : tenantId;
  }

  /**
   * Le fuseau de **tous** les établissements (#604) — seconde lecture
   * légitimement hors portée, comme dans le vrai dépôt : le relevé de démarrage
   * les inspecte tous et n'a pas de tenant courant à filtrer.
   *
   * Elle rend les trois seules colonnes que la vraie projection rend, et le tri
   * par `slug` est celui que la base applique : un double plus généreux
   * laisserait passer un signalement qui journalise des coordonnées.
   */
  public async listTenantTimeZones(): Promise<TenantTimeZoneRecord[]> {
    return [...this.tenantRecords.values()]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((tenant) => ({ id: tenant.id, name: tenant.name, timezone: tenant.timezone }));
  }

  /**
   * La vitrine de l'établissement **de la portée** — le pendant du `findFirst`
   * scopé sur le modèle racine, que l'extension borne sur son `id`.
   *
   * Elle passe par `requireTenant()` comme toutes les autres lectures : sans
   * portée résolue, rien. C'est ce qui rend probant le test « une route publique
   * ne répond pas avant que le middleware ait résolu le slug ».
   *
   * Les colonnes réservées au back-office sont **retirées une par une**, et non
   * par un `...reste` qui n'en écarterait qu'une : le vrai dépôt ne les lit pas
   * (`PUBLIC_TENANT_SELECT` les ignore), et un double qui les rendrait quand
   * même ferait passer au vert une projection publique élargie — c'est-à-dire un
   * SIRET, un numéro de TVA et un taux de taxe servis sans authentification à
   * qui connaît le slug (#913).
   */
  public async findCurrentPublicTenant(): Promise<PublicTenantRecord | null> {
    const tenantId = this.requireTenant();
    const stored = this.tenantRecords.get(tenantId);
    if (stored === undefined) {
      return null;
    }
    const {
      isActive: _isActive,
      legalName: _legalName,
      legalIdType: _legalIdType,
      legalId: _legalId,
      vatNumber: _vatNumber,
      receiptFooter: _receiptFooter,
      receiptPrefix: _receiptPrefix,
      taxRateBps: _taxRateBps,
      ...vitrine
    } = stored;
    return vitrine;
  }

  /**
   * La vue back-office du même établissement — la vitrine, plus `isActive`
   * (#343).
   *
   * Même `requireTenant()` que la lecture publique, et c'est le point : elle
   * n'accepte aucun identifiant en paramètre, donc aucun appelant ne peut en
   * désigner un autre. Le vrai dépôt tient la même propriété par le client
   * scopé, qui borne le modèle racine sur son `id`.
   */
  public async findCurrentTenant(): Promise<StoredTenant | null> {
    const tenantId = this.requireTenant();
    return this.tenantRecords.get(tenantId) ?? null;
  }

  /**
   * Le pays de l'établissement de la portée — la seule chose dont la
   * normalisation d'un numéro ait besoin (#824).
   *
   * Même `requireTenant()` que ses deux voisines : un double qui rendrait le
   * pays sans portée résolue ferait passer au vert une normalisation menée hors
   * de tout établissement, c'est-à-dire un numéro complété avec le pays du
   * voisin.
   */
  public async findCurrentTenantCountryCode(): Promise<string | null> {
    const tenantId = this.requireTenant();
    return this.tenantRecords.get(tenantId)?.countryCode ?? null;
  }

  /**
   * Écrit les réglages de l'établissement **de la portée** — colonnes et semaine
   * d'ouverture ensemble (#343, remodelé par #416).
   *
   * Trois propriétés du vrai dépôt sont reproduites, et chacune parce qu'un test
   * en dépend :
   *
   * 1. **Une seule écriture, tout ou rien.** L'état suivant se construit à part
   *    et ne remplace l'état courant qu'une fois la dernière part appliquée. Le
   *    double n'offre donc, comme le vrai, aucune porte par laquelle poser les
   *    colonnes sans la semaine — c'est le défaut que #416 supprime, et un
   *    double qui garderait les deux méthodes le laisserait réapparaître sans
   *    qu'aucune suite ne rougisse.
   * 2. **Le `false` de la portée vide** — le pendant du `count === 0`
   *    d'`updateMany` sous le client scopé, que le service traduit en 404.
   * 3. **Le scoping** : seul `tenantRecords.get(tenantId)` est touché, ce qui
   *    rend observable en test qu'une écriture du voisin ne vide pas les
   *    horaires de l'appelant. Le vrai dépôt le tient par l'extension, qui pose
   *    `tenant_id` sur le `deleteMany` comme sur le `createMany`.
   *
   * `openingHours` absent ne touche pas à la semaine ; un tableau vide l'efface.
   */
  public async updateTenantSettings(input: {
    changes: TenantSettingsChanges;
    openingHours?: readonly OpeningHourRecord[];
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const stored = this.tenantRecords.get(tenantId);
    if (stored === undefined) {
      return false;
    }

    const next: StoredTenant = { ...stored, ...input.changes };
    if (input.openingHours !== undefined) {
      next.openingHours = [...input.openingHours];
    }

    this.tenantRecords.set(tenantId, next);
    return true;
  }

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    return this.users.find((user) => user.tenantId === tenantId && user.email === email) ?? null;
  }

  public async findUserById(id: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    return this.users.find((user) => user.tenantId === tenantId && user.id === id) ?? null;
  }

  public async findStaffAccountById(id: string): Promise<UserRecord | null> {
    const tenantId = this.requireTenant();
    const staffRoles: readonly string[] = STAFF_ROLES;
    return (
      this.users.find(
        (user) =>
          user.tenantId === tenantId && user.id === id && staffRoles.includes(user.role),
      ) ?? null
    );
  }

  public async createUser(input: {
    email: string;
    role: UserRole;
    /** `null` = compte invité, en attente d'activation (#55) — comme le vrai. */
    passwordHash: string | null;
    firstName: string;
    lastName: string;
    phone: string | null;
    /** Comme le vrai (#880) : posé par l'appelant, `null` quand rien n'a été coché. */
    dataConsentAt: Date | null;
  }): Promise<UserRecord> {
    const tenantId = this.requireTenant();
    const user: StoredUser = {
      id: randomUUID(),
      tenantId,
      email: input.email,
      role: input.role,
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      isActive: true,
      dataConsentAt: input.dataConsentAt,
    };
    this.users.push(user);
    // `USER_SELECT` ne porte pas la preuve : la retirer ici est ce qui fait de ce
    // double un témoin fidèle du vrai dépôt.
    const { dataConsentAt: _proof, tenantId: _scope, ...record } = user;
    return record;
  }

  public async touchLastLogin(_userId: string): Promise<void> {
    // Sans effet observable ici : la colonne ne participe à aucune décision.
  }

  /**
   * Les comptes internes de l'établissement courant.
   *
   * Reproduit les trois propriétés du vrai dont un test dépend : le filtre de
   * tenant, le filtre sur les rôles internes — la clientèle n'y figure pas —
   * et l'ordre stable `(role, email)`. Un double qui rendrait les lignes dans
   * l'ordre d'insertion ferait passer une assertion d'ordre pour de mauvaises
   * raisons.
   *
   * Le tri des rôles passe par `USER_ROLE_RANK` et **non** par `localeCompare` :
   * `orderBy: { role: 'asc' }` porte sur une colonne `enum`, et PostgreSQL
   * ordonne un enum par son ordre de **déclaration**, pas alphabétiquement. Un
   * tri alphabétique rendrait `[ADMIN, STAFF]` là où la base rend
   * `[STAFF, ADMIN]` — une assertion d'ordre serait alors verte sur l'inverse du
   * résultat réel, jusqu'au jour où un test sur vraie base la contredirait.
   * `roles.spec.ts` verrouille la concordance des deux ordres.
   */
  public async listStaffAccounts(): Promise<StaffAccountState[]> {
    const tenantId = this.requireTenant();
    const staffRoles: readonly string[] = STAFF_ROLES;
    return this.users
      .filter((user) => user.tenantId === tenantId && staffRoles.includes(user.role))
      .sort((left, right) =>
        left.role === right.role
          ? left.email.localeCompare(right.email)
          : USER_ROLE_RANK[left.role] - USER_ROLE_RANK[right.role],
      )
      // `toStaffAccount` et non `toProfile` : la projection du vrai dépôt porte
      // `isActive` depuis #695, et un double qui l'omettrait laisserait passer
      // une régression que seule la recette verrait.
      .map((user) => toStaffAccount(user));
  }

  /**
   * Attribue un rôle à un compte de l'établissement courant.
   *
   * Rend `false` — et n'écrit rien — pour un identifiant inconnu **ou**
   * appartenant à un autre établissement, exactement comme le `updateMany` scopé
   * du vrai dépôt rend `count: 0`. C'est cette valeur-là qui devient le 404.
   */
  public async updateUserRole(input: { userId: string; role: UserRole }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === input.userId,
    );
    if (user === undefined) {
      return false;
    }
    user.role = input.role;
    return true;
  }

  /**
   * Active ou désactive un compte **du personnel** de l'établissement courant
   * (#55).
   *
   * Reproduit les deux filtres du vrai — le tenant et les rôles internes — parce
   * qu'un test dépend des deux : un identifiant d'un autre établissement rend
   * `false`, et un identifiant de cliente aussi. Un double qui ne filtrerait que
   * le tenant ferait passer au vert la désactivation d'une fiche cliente depuis
   * l'administration du personnel.
   */
  public async setStaffAccountActive(input: {
    userId: string;
    isActive: boolean;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const staffRoles: readonly string[] = STAFF_ROLES;
    const user = this.users.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.id === input.userId &&
        staffRoles.includes(candidate.role),
    );
    if (user === undefined) {
      return false;
    }
    user.isActive = input.isActive;
    return true;
  }

  /**
   * Pose le **premier** mot de passe d'un compte invité (#55).
   *
   * La condition `passwordHash === null` est reproduite ici parce qu'elle **est**
   * la propriété testée : c'est elle qui rend l'invitation à usage unique, et un
   * double qui écrirait par-dessus une empreinte existante ferait passer au vert
   * un rejeu que la base refuse.
   */
  public async setInitialPassword(input: {
    userId: string;
    passwordHash: string;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.id === input.userId &&
        candidate.passwordHash === null,
    );
    if (user === undefined) {
      return false;
    }
    user.passwordHash = input.passwordHash;
    // Comme le vrai : poser un mot de passe invalide le jeton de
    // réinitialisation en cours (#809, deuxième critère). Un double qui
    // l'oublierait ferait passer au vert un lien qui survit à l'activation du
    // compte qu'il désigne.
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    return true;
  }

  /**
   * L'état de réinitialisation d'un compte — #809.
   *
   * Rend `null` pour un compte d'un autre établissement, et c'est **la**
   * propriété que la suite d'isolation exerce : le vrai dépôt lit par le client
   * scopé, qui ne distingue pas « ailleurs » de « nulle part ». Un double qui
   * chercherait par identifiant seul ferait passer au vert la fuite que le
   * cinquième critère interdit.
   */
  public async findPasswordResetState(userId: string): Promise<PasswordResetState | null> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === userId,
    );

    if (user === undefined) {
      return null;
    }

    return {
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      passwordResetTokenHash: user.passwordResetTokenHash ?? null,
      passwordResetExpiresAt: user.passwordResetExpiresAt ?? null,
      passwordResetRequestedAt: user.passwordResetRequestedAt ?? null,
    };
  }

  /**
   * Arme le jeton de réinitialisation — #809.
   *
   * L'écriture **écrase** l'empreinte précédente, comme le vrai : c'est ce qui
   * fait que l'émission d'un nouveau jeton invalide l'ancien, et un double qui
   * les accumulerait ferait passer au vert deux liens vivants pour un compte.
   */
  public async armPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedAt: Date;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === input.userId,
    );

    if (user === undefined) {
      return false;
    }

    user.passwordResetTokenHash = input.tokenHash;
    user.passwordResetExpiresAt = input.expiresAt;
    user.passwordResetRequestedAt = input.requestedAt;
    return true;
  }

  /**
   * Pose le mot de passe **et** consomme le jeton — #809.
   *
   * Les trois conditions du `where` réel sont reproduites, et chacune porte un
   * cas de la suite : le tenant (isolation), l'empreinte attendue (le rejeu), et
   * l'échéance (le jeton périmé). Un double qui n'en vérifierait qu'une ferait
   * passer au vert exactement le scénario que le critère 5 demande de refuser.
   *
   * `password_reset_requested_at` n'est pas effacé, comme dans le vrai : se
   * servir du lien ne rouvre pas le droit d'en demander un autre aussitôt.
   */
  public async consumePasswordReset(input: {
    userId: string;
    expectedTokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const user = this.users.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.id === input.userId &&
        candidate.passwordResetTokenHash === input.expectedTokenHash &&
        candidate.passwordResetExpiresAt !== null &&
        candidate.passwordResetExpiresAt !== undefined &&
        candidate.passwordResetExpiresAt.getTime() > input.now.getTime(),
    );

    if (user === undefined) {
      return false;
    }

    user.passwordHash = input.passwordHash;
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;

    // Comme le vrai, et **dans la même opération** : le troisième critère exige
    // que toutes les sessions du compte tombent, et le vrai dépôt les révoque
    // dans la transaction qui pose le mot de passe. Un double qui laisserait
    // l'appelant s'en charger ferait passer au vert un service qui l'oublierait.
    for (const session of this.sessions) {
      if (session.userId === input.userId && session.revokedAt === null) {
        session.revokedAt = input.now;
      }
    }

    return true;
  }

  /**
   * Met à jour les coordonnées d'un compte de l'établissement courant (#47,
   * étendu par #55).
   *
   * Reproduit les deux propriétés du vrai dont un test dépend : le filtre de
   * tenant — un identifiant d'un autre établissement rend `false` et n'écrit
   * rien, exactement comme le `updateMany` scopé rend `count: 0` — et la
   * distinction entre « champ absent » et « champ à `null` », qui est ce qui
   * permet d'effacer un numéro sans effacer aussi le prénom.
   */
  public async updateContactDetails(input: {
    userId: string;
    changes: { firstName?: string; lastName?: string; phone?: string | null };
  }): Promise<boolean> {
    const tenantId = this.requireTenant();

    // Comme le vrai : une demande vide est une modification sans effet, et non
    // une erreur. Le dire ici plutôt que de laisser le double répondre `false`
    // sur un compte inconnu est ce qui garde les deux implémentations
    // indiscernables du point de vue du service.
    if (Object.keys(input.changes).length === 0) {
      return true;
    }

    const user = this.users.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === input.userId,
    );
    if (user === undefined) {
      return false;
    }

    // Une par une, et seulement si présente : `Object.assign(user, changes)`
    // recopierait aussi les clés à `undefined` d'un objet construit autrement,
    // et effacerait des valeurs que l'appelant n'a pas voulu toucher.
    if (input.changes.firstName !== undefined) {
      user.firstName = input.changes.firstName;
    }
    if (input.changes.lastName !== undefined) {
      user.lastName = input.changes.lastName;
    }
    if (input.changes.phone !== undefined) {
      user.phone = input.changes.phone;
    }
    return true;
  }

  public async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    const tenantId = this.requireTenant();
    const session: StoredSession = {
      id: randomUUID(),
      tenantId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      previousTokenHash: null,
      rotatedAt: null,
    };
    this.sessions.push(session);
    return session;
  }

  public async findSessionById(id: string): Promise<SessionRecord | null> {
    const tenantId = this.requireTenant();
    const session = this.sessions.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    // Une copie, comme la ligne que Prisma rend : une rotation concurrente ne
    // doit pas modifier sous les pieds du service la session qu'il vient de lire.
    return session === undefined ? null : { ...session };
  }

  public async rotateSession(input: {
    sessionId: string;
    expectedTokenHash: string;
    nextTokenHash: string;
    expiresAt: Date;
    rotatedAt: Date | null;
  }): Promise<boolean> {
    const tenantId = this.requireTenant();
    const session = this.sessions.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.id === input.sessionId &&
        candidate.tokenHash === input.expectedTokenHash &&
        candidate.revokedAt === null,
    );
    if (session === undefined) {
      return false;
    }
    if (input.rotatedAt !== null) {
      session.previousTokenHash = session.tokenHash;
      session.rotatedAt = input.rotatedAt;
    }
    session.tokenHash = input.nextTokenHash;
    session.expiresAt = input.expiresAt;
    return true;
  }

  public async revokeSession(sessionId: string): Promise<void> {
    const tenantId = this.requireTenant();
    for (const session of this.sessions) {
      if (session.tenantId === tenantId && session.id === sessionId && session.revokedAt === null) {
        session.revokedAt = new Date();
      }
    }
  }

  public async revokeAllSessionsOfUser(userId: string): Promise<void> {
    const tenantId = this.requireTenant();
    for (const session of this.sessions) {
      if (session.tenantId === tenantId && session.userId === userId && session.revokedAt === null) {
        session.revokedAt = new Date();
      }
    }
  }

  /** Vue typée pour l'injection dans `AuthService`. */
  public asRepository(): IdentityRepository {
    return this as unknown as IdentityRepository;
  }
}
