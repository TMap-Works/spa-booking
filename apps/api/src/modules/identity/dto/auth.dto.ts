import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EMAIL_ADDRESS_MAX_LENGTH,
  NAME_MAX_LENGTH,
  LOCALES,
  PASSWORD_MIN_LENGTH,
  PERMISSIONS,
  PHONE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  type Locale,
  type PasswordResetRequest,
  type Permission,
  type TenantBillingStatus,
  type TenantScopedLoginRequest,
  authSessionResponseSchema,
  authenticatedAccountSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  passwordSchema,
  sessionUserSchema,
  tenantScopedLoginRequestSchema,
  tenantScopedRegisterRequestSchema,
} from '@spa/shared';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { UserProfile, UserRole } from '../identity.types';
import { USER_ROLES } from '../roles';

/**
 * DTO d'entrée et de sortie du module `identity` — **validés par le contrat
 * partagé** (#510).
 *
 * ## Ce que ces classes sont devenues, et ce qu'elles ne sont plus
 *
 * Les deux corps de session — connexion et inscription — ne décrivent plus la
 * frontière : ils la **documentent**. `tenantScopedLoginRequestSchema` et
 * `tenantScopedRegisterRequestSchema` de `@spa/shared` les décrivent, et ce sont
 * eux qui les jugent, montés par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * **Typer un paramètre de handler par l'une de ces classes viderait le corps de
 * la requête.**
 *
 * ## Les écarts constatés avant de substituer, et ce qu'ils changent
 *
 * | Champ | Le DTO validait | Le contrat valide | Verdict |
 * |---|---|---|---|
 * | `tenantSlug` | `@Trim()` + minuscules + `@MaxLength(63)` + le motif de slug | `slugSchema` — les mêmes normalisations, le même motif, la même borne | resserré depuis #837 : `slugSchema` refuse en plus les noms réservés à la plateforme (`www`, `api`, `origin`…). Aucun établissement ne peut en porter, et la résolution publique les rend déjà 404 : un corps qui en nomme un est refusé à la frontière plutôt qu'en `INVALID_CREDENTIALS` |
 * | `email` | `@IsEmail()` + `@MaxLength(320)` | `emailSchema` — `.trim().toLowerCase()`, `.max(254)`, `.email()` | identique **en refus** : validator.js porte déjà les 254 octets de la RFC 5321 en dur, et la borne de 320 (la largeur de la colonne) n'était donc jamais atteinte. La canonisation, elle, passe du service à la frontière — `normalizeEmail` y était déjà appliquée avant toute lecture |
 * | `password` (connexion) | `@MaxLength(200)` | `submittedPasswordSchema` — `.min(1).max(128)` | resserré, dans le sens autorisé : aucun mot de passe légitime ne dépasse 72 octets, puisque c'est là que bcrypt s'arrête |
 * | `password` (inscription) | `@MinLength(12)` + `@MaxLength(72)` | `passwordSchema` — `.min(12).max(128)` | **le seul écart de fond**, et il va dans le sens interdit : 128 relâcherait la borne de 72. Voir le `.extend()` ci-dessous |
 * | `firstName`, `lastName` | `@MinLength(1)` + `@MaxLength(80)` | `nameSchema` — `.trim().min(1).max(80)` | identique, plus l'élagage : sans lui, `"   "` passait pour un prénom |
 * | `phone` (inscription) | `@IsString()` + `@MaxLength(32)` | `phoneSchema` — motif de numéro **et** plancher de chiffres (#66) | resserré, et c'est le sens que l'en-tête d'`e164PhoneSchema` réclamait : le formulaire d'`apps/web` valide déjà avec ce schéma-là, si bien que le refus s'affiche sur le champ avant la soumission plutôt qu'en bloc après. Depuis #824 le contrat s'arrête là — il décrit la **forme** de la saisie, national compris — et le dernier mot revient au service, qui normalise en E.164 avec le pays de l'établissement (`../phone`) |
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : un `tenantId` ou
 * un `role` glissé dans un de ces corps est **refusé**, pas silencieusement
 * ignoré — c'est le deuxième invariant que l'en-tête de
 * `packages/shared/src/schemas/identity.ts` énonce (tenant-isolation §2).
 *
 * Écart assumé, tranché en #554 : `AcceptInvitationDto` reste sous `class-validator`, faute de
 * schéma. Le contrat ne décrit pas la première connexion d'un membre du
 * personnel invité (#55) — il n'a ni `acceptInvitationRequestSchema`, ni
 * `invitationTokenSchema` —, et l'inventer ici en dupliquerait la définition
 * dans le module qui la consomme, c'est-à-dire exactement ce que ce ticket
 * supprime ailleurs. Reste à faire : porter la forme dans `packages/shared`,
 * avec la borne de 4096 octets du jeton et la même politique de mot de passe que
 * l'inscription.
 */

/**
 * La politique de mot de passe **à la création**, telle que ce module
 * l'applique : celle du contrat, plafonnée à ce que bcrypt lit réellement.
 *
 * `passwordSchema` plafonne à `PASSWORD_MAX_LENGTH` (128), là où bcrypt ne
 * considère que les **72 premiers octets** : au-delà, deux mots de passe
 * distincts partageant leur préfixe deviennent équivalents, et l'utilisateur
 * croit avoir choisi un secret plus long qu'il ne l'est. Relâcher jusqu'à 128
 * pour suivre le contrat serait donc le sens interdit par l'ADR 0008 — on
 * resserre le contrat, on ne relâche pas l'API.
 *
 * Écart assumé, tranché en #554 : la borne appartient au contrat, où elle vaudrait pour tout
 * appelant plutôt que pour ce module seul — mais la poser là-bas suppose de
 * décider si le plafond de bcrypt est une règle d'API ou une règle de contrat,
 * et le schéma est lu par les formulaires d'`apps/web` autant que par ici.
 */
const BCRYPT_SIGNIFICANT_BYTES = 72;

const bcryptBoundedPasswordSchema = passwordSchema.max(BCRYPT_SIGNIFICANT_BYTES, {
  message: `password : ${String(BCRYPT_SIGNIFICANT_BYTES)} caractères au maximum`,
});

const registerRequestSchema = tenantScopedRegisterRequestSchema.extend({
  password: bcryptBoundedPasswordSchema,
});

/**
 * Les deux pipes de session — ce sont **eux** qui valident, et non les classes.
 *
 * Instanciés une fois au chargement du module plutôt qu'à chaque décoration :
 * les schémas ne changent pas d'une requête à l'autre, et la garde `.strict()`
 * du pipe se paie ainsi une seule fois, à l'amorçage.
 */
export const loginBody = new ZodValidationPipe(tenantScopedLoginRequestSchema);
export const registerBody = new ZodValidationPipe(registerRequestSchema);

/**
 * Les deux corps de la réinitialisation (#809) — validés par le contrat, comme
 * ceux de session.
 *
 * La confirmation étend le schéma partagé de la même borne de 72 octets que
 * l'inscription, et pour la même raison : le mot de passe est **choisi** ici, et
 * bcrypt ne considère pas ce qui suit son 72e octet. Relâcher jusqu'à 128 pour
 * suivre le contrat serait le sens interdit par l'ADR 0008 — on resserre l'API,
 * on ne la relâche pas.
 *
 * Un compte du personnel ou une cliente qui récupère son accès n'a aucune raison
 * d'être moins bien protégé qu'à l'inscription : la politique est la même des
 * trois côtés.
 */
const passwordResetConfirmSchema = passwordResetConfirmRequestSchema.extend({
  password: bcryptBoundedPasswordSchema,
});

export const passwordResetBody = new ZodValidationPipe(passwordResetRequestSchema);
export const passwordResetConfirmBody = new ZodValidationPipe(passwordResetConfirmSchema);

/** La demande de réinitialisation, telle que le contrat la rend au contrôleur. */
export type PasswordResetBody = PasswordResetRequest;

/** La confirmation, telle que le contrat bornée la rend au contrôleur. */
export type PasswordResetConfirmBody = z.infer<typeof passwordResetConfirmSchema>;

/** La demande de connexion, telle que le contrat la rend au contrôleur. */
export type LoginBody = TenantScopedLoginRequest;

/** La demande d'inscription, telle que le contrat la rend au contrôleur. */
export type RegisterBody = z.infer<typeof registerRequestSchema>;

/**
 * Le slug d'établissement des deux corps de session — la documentation de
 * `slugSchema`.
 *
 * Il **désigne** un établissement, il n'en accorde aucun accès : le serveur le
 * résout contre la table `tenants` puis vérifie les identifiants dans cette
 * portée-là. Un slug d'un autre salon ne fait que rendre `INVALID_CREDENTIALS`.
 */
class TenantScopedRequest {
  @ApiProperty({
    description:
      "Slug public de l'établissement. Résolu contre la table `tenants` avant " +
      'toute lecture — il désigne un établissement, il n’en accorde aucun accès. ' +
      'Élagué et abaissé à la frontière.',
    example: 'salon-des-lilas',
    maxLength: SLUG_MAX_LENGTH,
  })
  public tenantSlug!: string;
}

/** La connexion — la documentation de `tenantScopedLoginRequestSchema`. */
export class LoginDto extends TenantScopedRequest {
  @ApiProperty({ example: 'alice@example.test', maxLength: EMAIL_ADDRESS_MAX_LENGTH })
  public email!: string;

  @ApiProperty({
    description:
      'Mot de passe en clair — jamais journalisé, jamais stocké. **Aucun plancher ' +
      'de longueur à la connexion** : la politique s’applique au moment où le ' +
      'secret est choisi, et l’exiger ici distinguerait « trop court » de ' +
      '« faux », donc dirait qu’un mot de passe court est *le* mot de passe de ce ' +
      'compte.',
  })
  public password!: string;
}

/** L'inscription cliente — la documentation du schéma borné ci-dessus. */
export class RegisterDto extends TenantScopedRequest {
  @ApiProperty({ example: 'alice@example.test', maxLength: EMAIL_ADDRESS_MAX_LENGTH })
  public email!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: BCRYPT_SIGNIFICANT_BYTES,
    description:
      'Douze caractères au minimum — le seuil au-delà duquel une attaque par ' +
      'dictionnaire hors ligne cesse d’être triviale. Soixante-douze au maximum : ' +
      'bcrypt ne considère pas ce qui suit.',
  })
  public password!: string;

  @ApiProperty({ example: 'Alice', maxLength: NAME_MAX_LENGTH })
  public firstName!: string;

  @ApiProperty({ example: 'Durand', maxLength: NAME_MAX_LENGTH })
  public lastName!: string;

  @ApiPropertyOptional({
    example: '+261 34 12 345 67',
    maxLength: PHONE_MAX_LENGTH,
    description:
      'Facultatif. Accepté au format national (« 06 12 34 56 78 ») comme ' +
      'international (« +261 34 12 345 67 »), et **enregistré en E.164** : le ' +
      'national est complété avec le pays de l’établissement, et un numéro ' +
      'qu’aucun plan de numérotation n’attribue est refusé en 400 sur le champ ' +
      '(#824). Sans pays renseigné sur l’établissement, seule la forme ' +
      'internationale est acceptable.',
  })
  public phone?: string;

  @ApiProperty({
    example: true,
    description:
      'Accord au traitement des données, **obligatoire** : `false` et l’absence ' +
      'sont refusés de la même façon. C’est le seul champ de ce corps qui ne ' +
      'décrit pas le compte — il décrit ce qui autorise l’établissement à le ' +
      'tenir (CDC §5.1, RGPD art. 7.1). **Aucune date n’est acceptée** : le ' +
      'serveur horodate la réception lui-même, et un `dataConsentAt` glissé ici ' +
      'est refusé par le `.strict()` du contrat.',
  })
  public dataConsent!: boolean;

  /**
   * La langue de l'interface au moment de l'inscription — #844, huitième
   * critère d'acceptation.
   *
   * Facultative, et c'est ce qui la distingue de tout le reste de ce corps :
   * elle ne décrit pas une saisie, elle constate dans quelle langue la page
   * était affichée. Absente, le compte naît sans préférence — ce qui se lit
   * « aucune », jamais « anglais ».
   */
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'en',
    description:
      'Langue de l’interface au moment de l’inscription, enregistrée sur le ' +
      'compte créé. Facultative : absente, le compte naît sans préférence et ' +
      'retombe sur la langue de l’établissement. La casse est normalisée ; toute ' +
      'valeur hors `fr`/`en` est refusée en 400.',
  })
  public locale?: Locale;
}

/**
 * Première connexion d'un membre du personnel invité — #55.
 *
 * ## Aucun `tenantSlug`, contrairement à `LoginDto` et `RegisterDto`
 *
 * L'établissement est une revendication **signée** du jeton d'invitation, comme
 * il l'est du jeton de rafraîchissement. Le demander en plus donnerait deux
 * sources pour la même information — donc un désaccord possible, qu'il faudrait
 * arbitrer sur la foi d'une entrée utilisateur. Ce DTO n'étend donc pas
 * `TenantScopedRequest`, et ce n'est pas un oubli.
 *
 * ## Le mot de passe est borné comme à l'inscription
 *
 * Mêmes seuils que `RegisterDto`, et pour les mêmes raisons : douze caractères au
 * minimum parce qu'en deçà une attaque hors ligne redevient triviale, soixante-
 * douze au maximum parce que bcrypt ignore ce qui suit. Un compte du personnel
 * n'a aucune raison d'être moins bien protégé qu'un compte client — il en voit
 * les fiches.
 *
 * Cette classe **valide encore** : voir la note d’écart de l'en-tête — le
 * contrat ne décrit pas cette forme.
 */
export class AcceptInvitationDto {
  @ApiProperty({
    description:
      'Jeton d’invitation reçu de l’établissement. À usage unique : il cesse ' +
      'd’ouvrir quoi que ce soit dès que le mot de passe est posé.',
  })
  @IsString()
  // Borné comme tout ce qui traverse : un jeton légitime tient en quelques
  // centaines d'octets, et la borne évite qu'un corps arbitrairement long
  // atteigne la vérification de signature.
  @MaxLength(4096)
  public token!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, description: 'Douze caractères au minimum.' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `password : ${String(PASSWORD_MIN_LENGTH)} caractères au minimum`,
  })
  @MaxLength(BCRYPT_SIGNIFICANT_BYTES, {
    message: `password : ${String(BCRYPT_SIGNIFICANT_BYTES)} caractères au maximum`,
  })
  public password!: string;
}

/**
 * Demande de réinitialisation — la documentation de `passwordResetRequestSchema`
 * (#809).
 *
 * Elle étend `TenantScopedRequest` comme la connexion : la même adresse désigne
 * deux comptes distincts dans deux salons, et sans le slug la demande n'aurait
 * aucun moyen de savoir lequel des deux récupérer.
 */
export class PasswordResetRequestDto extends TenantScopedRequest {
  @ApiProperty({
    example: 'alice@example.test',
    maxLength: EMAIL_ADDRESS_MAX_LENGTH,
    description:
      'Adresse du compte. **Aucune réponse ne dit si elle est connue** : la ' +
      'route rend 202 dans tous les cas, sans quoi ce formulaire serait un ' +
      'annuaire de la clientèle du salon.',
  })
  public email!: string;
}

/**
 * Confirmation d'une réinitialisation — la documentation du schéma borné
 * ci-dessus (#809).
 *
 * ## Aucun `tenantSlug`, contrairement à la demande
 *
 * L'établissement est une revendication **signée** du jeton, comme il l'est du
 * jeton de rafraîchissement et de celui d'invitation. Le demander en plus
 * donnerait deux sources pour la même information — donc un désaccord possible,
 * qu'il faudrait arbitrer sur la foi d'une entrée utilisateur. Cette classe
 * n'étend donc pas `TenantScopedRequest`, et ce n'est pas un oubli.
 */
export class PasswordResetConfirmDto {
  @ApiProperty({
    description:
      'Jeton reçu par courrier. À usage unique, et il ne vit que trente ' +
      'minutes : il cesse d’ouvrir quoi que ce soit dès que le mot de passe est ' +
      'posé, dès qu’une demande plus récente est faite, et à son échéance.',
  })
  public token!: string;

  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: BCRYPT_SIGNIFICANT_BYTES,
    description:
      'Le nouveau mot de passe. Même politique qu’à l’inscription : douze ' +
      'caractères au minimum, soixante-douze au maximum — bcrypt ne considère ' +
      'pas ce qui suit.',
  })
  public password!: string;
}

/**
 * Le compte tel qu'il sort de l'API — la documentation de `sessionUserSchema`.
 *
 * **Ni `tenantId`, ni `passwordHash`.** Une entité Prisma renvoyée telle quelle
 * les exposerait tous les deux ; c'est pour cela qu'une entité ne sort jamais
 * d'un contrôleur (api-module §4).
 */
export class UserProfileDto implements UserProfile {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public email!: string;

  // `USER_ROLES` et non une liste recopiée : le document OpenAPI est le contrat,
  // et un contrat qui énumère d'autres rôles que la garde est un contrat faux.
  @ApiProperty({ enum: USER_ROLES })
  public role!: UserRole;

  @ApiProperty()
  public firstName!: string;

  @ApiProperty()
  public lastName!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '+261341234567',
    description:
      'Toujours en **E.164**, sans séparateur — c’est la forme sous laquelle ' +
      'l’API écrit tout numéro depuis #824. La mise en forme lisible revient au ' +
      'front, qui seul connaît la locale de qui regarde. `null` quand aucun ' +
      'numéro n’est renseigné.',
  })
  public phone!: string | null;

  /**
   * La langue préférée du compte — #844.
   *
   * `null` se lit « aucune préférence enregistrée », jamais « anglais » : c'est
   * alors `defaultLocale` de l'établissement qui tranche. Toujours émis, comme
   * `phone` et pour la même raison — un front qui distingue « absent » de
   * « vide » finit par afficher `undefined`.
   */
  @ApiProperty({
    nullable: true,
    enum: LOCALES,
    example: 'en',
    description:
      'Langue préférée du compte. `null` quand la personne n’en a jamais ' +
      'exprimé — la langue de l’établissement (`defaultLocale`) s’applique alors.',
  })
  public locale!: Locale | null;
}

/**
 * Le compte connecté **et ses permissions effectives** — ce que `GET /auth/me`
 * rend depuis #812 (cinquième critère, ADR 0013).
 *
 * ## Pourquoi cette classe étend `UserProfileDto` au lieu de le modifier
 *
 * Parce que `UserProfileDto` est aussi le `user` d'`AuthTokensDto`, c'est-à-dire
 * le corps des trois routes de session. Y ajouter les permissions les ferait
 * voyager dans la réponse d'une connexion, où elles n'ont rien à faire : un
 * droit qu'on découvre en même temps que son jeton invite à le mettre en cache
 * avec lui — donc à le garder après qu'un administrateur l'a retiré. La liste se
 * lit sur `/auth/me`, un appel que le back-office fait déjà à chaque rendu de
 * son shell, et qui coûte donc zéro requête de plus.
 *
 * La séparation est la même que celle de `staffAccountStateSchema` côté
 * contrat : une surface de plus, pas un champ de plus sur toutes les surfaces.
 */
export class AuthenticatedAccountDto extends UserProfileDto {
  @ApiProperty({
    description:
      'Les permissions effectives du compte, dans l’ordre du vocabulaire. ' +
      'Toujours émise, éventuellement vide — un compte `client` n’en a aucune. ' +
      'Le back-office construit son sommaire à partir de cette liste plutôt que ' +
      'd’une matrice recopiée.',
    enum: PERMISSIONS,
    isArray: true,
  })
  public permissions!: Permission[];

  @ApiPropertyOptional({
    description:
      'Où en est la facturation du salon (ADR 0016) : `status` et fin d’essai. ' +
      'Absent si le salon est introuvable.',
  })
  public billing?: { status: TenantBillingStatus; trialEndsAt: string | null };
}

/**
 * Réponse d'une connexion réussie — la documentation
 * d'`authSessionResponseSchema`.
 *
 * Le jeton de **rafraîchissement n'y figure pas** : il part en cookie `httpOnly`,
 * donc hors de portée de JavaScript. L'exposer ici annulerait exactement ce que
 * le cookie protège.
 */
export class AuthTokensDto {
  @ApiProperty({ description: 'Jeton d’accès, à poser en en-tête `Authorization: Bearer`.' })
  public accessToken!: string;

  @ApiProperty({ description: 'Durée de vie du jeton d’accès, en secondes.', example: 900 })
  public expiresIn!: number;

  @ApiProperty({ type: UserProfileDto })
  public user!: UserProfileDto;
}

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

/**
 * Les classes qui documentent `/api/docs` doivent annoncer **exactement** les
 * champs que les pipes acceptent.
 *
 * Sans cette garde, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce. Sur ces deux corps-ci, elle porte davantage : un
 * champ documenté comme acceptable sur une route d'authentification est une
 * invitation à l'envoyer.
 */
type _LoginDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof LoginDto, keyof z.input<typeof tenantScopedLoginRequestSchema>>
  | Exclude<keyof z.input<typeof tenantScopedLoginRequestSchema>, keyof LoginDto>
>;

type _RegisterDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof RegisterDto, keyof z.input<typeof registerRequestSchema>>
  | Exclude<keyof z.input<typeof registerRequestSchema>, keyof RegisterDto>
>;

/**
 * Les deux corps de la réinitialisation, tenus contre leurs schémas comme les
 * deux corps de session (#809).
 *
 * La garde porte ici quelque chose de plus qu'ailleurs : ces routes ne sont pas
 * authentifiées, et un champ documenté comme acceptable sur l'une d'elles est
 * une invitation à l'envoyer. Un `tenantSlug` annoncé sur la confirmation, par
 * exemple, aurait suggéré une seconde source pour un établissement que le jeton
 * porte déjà signé.
 */
type _PasswordResetRequestDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PasswordResetRequestDto, keyof z.input<typeof passwordResetRequestSchema>>
  | Exclude<keyof z.input<typeof passwordResetRequestSchema>, keyof PasswordResetRequestDto>
>;

type _PasswordResetConfirmDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PasswordResetConfirmDto, keyof z.input<typeof passwordResetConfirmSchema>>
  | Exclude<keyof z.input<typeof passwordResetConfirmSchema>, keyof PasswordResetConfirmDto>
>;

/**
 * Les deux sorties de session, tenues dans le sens que l'exécution ne peut pas
 * tenir.
 *
 * `sessionUserSchema` décrit ce que le **front lit** : son champ `role`
 * normalise la casse de l'énumération PostgreSQL (`CLIENT` → `client`). Valider
 * notre propre sortie contre lui à l'exécution changerait donc le format du fil
 * et casserait tout lecteur — c'est le premier point de vigilance de #510. La
 * **forme entrante** qu'il sait lire, elle, se tient à la compilation.
 */
type SessionUserWire = z.input<typeof sessionUserSchema>;
type AuthSessionResponseWire = z.input<typeof authSessionResponseSchema>;

type _UserProfileDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof UserProfileDto, keyof SessionUserWire>
  | Exclude<keyof SessionUserWire, keyof UserProfileDto>
>;

type _UserProfileDtoIsReadableByTheContract = AssertTrue<
  UserProfileDto extends SessionUserWire ? true : false
>;

/**
 * La sortie de `/auth/me`, tenue contre `authenticatedAccountSchema` dans le
 * même sens que les deux précédentes : la classe annonce exactement les champs
 * que le contrat sait lire, ni un de plus, ni un de moins.
 *
 * Sans cette garde, une permission ajoutée au vocabulaire sans sa `@ApiProperty`
 * décrirait une route qui rend ce qu'elle n'annonce pas — et le front, qui
 * construit son sommaire sur cette liste, afficherait une entrée de moins sans
 * qu'aucun test ne rougisse.
 */
type AuthenticatedAccountWire = z.input<typeof authenticatedAccountSchema>;

type _AuthenticatedAccountDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AuthenticatedAccountDto, keyof AuthenticatedAccountWire>
  | Exclude<keyof AuthenticatedAccountWire, keyof AuthenticatedAccountDto>
>;

type _AuthenticatedAccountDtoIsReadableByTheContract = AssertTrue<
  AuthenticatedAccountDto extends AuthenticatedAccountWire ? true : false
>;

type _AuthTokensDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AuthTokensDto, keyof AuthSessionResponseWire>
  | Exclude<keyof AuthSessionResponseWire, keyof AuthTokensDto>
>;

type _AuthTokensDtoIsReadableByTheContract = AssertTrue<
  AuthTokensDto extends AuthSessionResponseWire ? true : false
>;
