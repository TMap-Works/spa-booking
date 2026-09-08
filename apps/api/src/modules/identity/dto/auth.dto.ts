import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EMAIL_ADDRESS_MAX_LENGTH,
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  type TenantScopedLoginRequest,
  authSessionResponseSchema,
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
 * | `tenantSlug` | `@Trim()` + minuscules + `@MaxLength(63)` + le motif de slug | `slugSchema` — les mêmes normalisations, le même motif, la même borne | identique |
 * | `email` | `@IsEmail()` + `@MaxLength(320)` | `emailSchema` — `.trim().toLowerCase()`, `.max(254)`, `.email()` | identique **en refus** : validator.js porte déjà les 254 octets de la RFC 5321 en dur, et la borne de 320 (la largeur de la colonne) n'était donc jamais atteinte. La canonisation, elle, passe du service à la frontière — `normalizeEmail` y était déjà appliquée avant toute lecture |
 * | `password` (connexion) | `@MaxLength(200)` | `submittedPasswordSchema` — `.min(1).max(128)` | resserré, dans le sens autorisé : aucun mot de passe légitime ne dépasse 72 octets, puisque c'est là que bcrypt s'arrête |
 * | `password` (inscription) | `@MinLength(12)` + `@MaxLength(72)` | `passwordSchema` — `.min(12).max(128)` | **le seul écart de fond**, et il va dans le sens interdit : 128 relâcherait la borne de 72. Voir le `.extend()` ci-dessous |
 * | `firstName`, `lastName` | `@MinLength(1)` + `@MaxLength(80)` | `nameSchema` — `.trim().min(1).max(80)` | identique, plus l'élagage : sans lui, `"   "` passait pour un prénom |
 * | `phone` (inscription) | `@IsString()` + `@MaxLength(32)` | `phoneSchema` — motif de numéro **et** plancher de chiffres (#66) | resserré, et c'est le sens que l'en-tête d'`e164PhoneSchema` réclamait : le formulaire d'`apps/web` valide déjà avec ce schéma-là, si bien que le refus s'affiche sur le champ avant la soumission plutôt qu'en bloc après |
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : un `tenantId` ou
 * un `role` glissé dans un de ces corps est **refusé**, pas silencieusement
 * ignoré — c'est le deuxième invariant que l'en-tête de
 * `packages/shared/src/schemas/identity.ts` énonce (tenant-isolation §2).
 *
 * TODO(#536) : `AcceptInvitationDto` reste sous `class-validator`, faute de
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
 * TODO(#536) : la borne appartient au contrat, où elle vaudrait pour tout
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
      'Facultatif. Format libre borné — le rappel SMS le normalise —, mais il doit ' +
      'porter assez de chiffres pour être composable : un « + » seul n’est un ' +
      'numéro dans aucune convention (#66).',
  })
  public phone?: string;
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
 * Cette classe **valide encore** : voir le `TODO(#536)` de l'en-tête — le
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

  @ApiProperty({ nullable: true, type: String })
  public phone!: string | null;
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

type _AuthTokensDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof AuthTokensDto, keyof AuthSessionResponseWire>
  | Exclude<keyof AuthSessionResponseWire, keyof AuthTokensDto>
>;

type _AuthTokensDtoIsReadableByTheContract = AssertTrue<
  AuthTokensDto extends AuthSessionResponseWire ? true : false
>;
