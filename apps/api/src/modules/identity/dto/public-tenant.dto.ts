import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { openingHoursEntrySchema, postalAddressSchema, publicTenantSchema } from '@spa/shared';
import type { z } from 'zod';

/**
 * Adresse postale de l'établissement — #343.
 *
 * ## Un objet, et non cinq champs à plat
 *
 * L'adresse se lit d'un bloc : la page publique l'affiche en un paragraphe, le
 * JSON-LD la rend en `PostalAddress`, le formulaire de réglages la pose ou
 * l'efface en entier. À plat, chacun aurait eu à recomposer le même objet et à
 * décider seul de ce qu'est une adresse suffisante.
 *
 * ## Le triplet minimal
 *
 * `line1`, `city` et `country` sont requis **dans l'objet**, alors que l'objet
 * lui-même est facultatif partout où il apparaît. Un salon a le droit de ne pas
 * publier d'adresse ; une adresse sans ville n'oriente personne et produirait un
 * `PostalAddress` incomplet — publier faux coûte plus cher que ne pas publier.
 * La base tient la même règle (`tenants_address_completeness_check`).
 *
 * Reprend `postalAddressSchema` de `packages/shared`, et le fait désormais **de
 * façon vérifiable** : les assertions de compilation en fin de fichier tiennent
 * le jeu de clés et l'assignabilité champ par champ (#510).
 */
export class PostalAddressDto {
  @ApiProperty({ maxLength: 160, example: '12 rue des Lilas' })
  public line1!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 160,
    example: 'Bâtiment B, 2ᵉ étage',
    description: 'Complément d’adresse. Omis quand il n’y en a pas.',
  })
  public line2?: string | undefined;

  @ApiPropertyOptional({
    type: String,
    maxLength: 16,
    example: '75011',
    description:
      'Code postal. Facultatif : tous les pays n’en ont pas, et l’exiger ' +
      'refuserait l’adresse réelle d’un salon.',
  })
  public postalCode?: string | undefined;

  @ApiProperty({ maxLength: 120, example: 'Paris' })
  public city!: string;

  @ApiProperty({
    example: 'FR',
    description:
      'Pays en ISO 3166-1 alpha-2, majuscules. Un code et non un nom : ' +
      '`schema.org/addressCountry` l’accepte tel quel.',
  })
  public country!: string;
}

/**
 * Une plage d'ouverture hebdomadaire de l'établissement — #343.
 *
 * ## Ce que ce n'est pas
 *
 * Ni un horaire de praticien, ni une contrainte de disponibilité. Le moteur de
 * créneaux ne lit pas ces plages. Elles disent ce que le salon **annonce**, et
 * c'est tout ce qu'elles disent.
 *
 * La forme est en revanche celle de `StaffScheduleEntryDto` : jour ISO 8601,
 * heures murales, borne haute exclue. Deux formes différentes pour la même
 * notion auraient obligé chaque écran à savoir laquelle il tient.
 */
export class OpeningHoursEntryDto {
  @ApiProperty({
    minimum: 1,
    maximum: 7,
    example: 2,
    description:
      'Jour de la semaine en numérotation ISO 8601 : 1 lundi … 7 dimanche. ' +
      'Le 0-dimanche de `Date.getDay` n’est pas employé — il est *falsy*.',
  })
  public weekday!: number;

  @ApiProperty({
    example: '09:00',
    description:
      'Heure murale d’ouverture, dans le fuseau de l’établissement. Jamais un ' +
      'instant : « 09:00 » vaut 08:00Z en hiver et 07:00Z en été à Paris.',
  })
  public opensAt!: string;

  @ApiProperty({
    example: '19:00',
    description:
      'Heure murale de fermeture, **exclue**. « 24:00 » pour minuit — la seule ' +
      'façon exacte de le dire. Strictement postérieure à `opensAt`.',
  })
  public closesAt!: string;
}

/**
 * La vitrine publique d'un établissement, telle qu'elle sort de l'API.
 *
 * Servie **sans authentification** à la page de réservation : tout ce qui est
 * déclaré ici est, par construction, lisible par n'importe qui connaissant le
 * slug du salon. C'est ce qui rend la liste de champs plus importante que le
 * reste du fichier — chaque ajout est une décision de publication.
 *
 * Ce qui n'y figure pas est un choix, pas un oubli :
 *
 * - **`isActive`** — dirait qu'un salon a fermé, et lequel. Un établissement
 *   désactivé se comporte de toute façon comme un établissement inconnu, et le
 *   middleware refuse la requête bien avant ce DTO ;
 * - **les comptes, les rendez-vous, les chiffres** — ils relèvent du back-office
 *   et de ses gardes. Le tenant résolu par le slug n'accorde aucun accès : il
 *   désigne l'établissement dont on lit les données *publiques*, et rien de
 *   plus.
 *
 * La forme reprend `publicTenantSchema` de `packages/shared` — le contrat que le
 * front consomme —, et depuis #510 elle le reprend **de façon vérifiable** : les
 * assertions de compilation en fin de fichier tiennent le jeu de clés et
 * l'assignabilité champ par champ, optionalité comprise. Un contact passé de
 * `.optional()` à `.nullable()` d'un seul côté échoue désormais au `tsc`, là où
 * il aurait cassé la lecture de la vitrine de tout salon sans coordonnées.
 *
 * La classe, elle, subsiste : `@nestjs/swagger` documente une réponse par une
 * classe décorée, pas par un schéma Zod (ADR 0008).
 */
export class PublicTenantDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Identifiant de l’établissement. Le seul objet de l’API où il est exposé — ' +
      'cet objet *est* l’établissement.',
  })
  public id!: string;

  @ApiProperty({ example: 'salon-des-lilas', description: 'Slug public, celui de l’URL.' })
  public slug!: string;

  @ApiProperty({ example: 'Salon des Lilas' })
  public name!: string;

  @ApiProperty({
    example: 'Europe/Paris',
    description:
      'Fuseau IANA de l’établissement. Le front reçoit des instants UTC et n’a aucun ' +
      'autre moyen de les afficher dans le calendrier du salon.',
  })
  public timezone!: string;

  @ApiProperty({ example: 'EUR', description: 'Devise par défaut, ISO 4217.' })
  public defaultCurrency!: string;

  /**
   * Contacts **omis** plutôt que rendus à `null` quand l'établissement n'en a
   * pas — c'est la forme que `publicTenantSchema` déclare (`.optional()`), et
   * c'est ce contrat qui fait foi, pas cette classe : le front valide les
   * réponses contre lui, et un `null` là où il attend une chaîne ou rien fait
   * échouer la validation de tout salon sans coordonnées, c'est-à-dire du cas le
   * plus courant à l'inscription.
   *
   * `undefined` disparaît à la sérialisation JSON : la clé est simplement
   * absente du corps, ce qui est exactement ce que `.optional()` accepte.
   */
  @ApiPropertyOptional({ type: String, example: 'contact@salon-des-lilas.test' })
  public contactEmail?: string | undefined;

  @ApiPropertyOptional({ type: String, example: '+33100000000' })
  public contactPhone?: string | undefined;

  /**
   * Adresse et horaires (#343), au même régime que les contacts ci-dessus :
   * **omis** quand ils manquent, jamais rendus à `null`.
   *
   * C'est ce qui rend la migration transparente pour les consommateurs : la
   * vitrine d'un salon qui n'a rien saisi a rigoureusement la forme qu'elle
   * avait avant que ces champs n'existent, et un front antérieur continue de la
   * valider. Un salon sans adresse **reste servi** — c'est le critère.
   *
   * Un tableau d'horaires vide est omis lui aussi : « publié mais vide » serait
   * un troisième état qu'aucun écran ne saurait distinguer de « pas encore
   * renseigné », et qui afficherait une section blanche.
   */
  @ApiPropertyOptional({ type: PostalAddressDto })
  public address?: PostalAddressDto | undefined;

  @ApiPropertyOptional({
    type: [OpeningHoursEntryDto],
    description:
      'Plages d’ouverture de la semaine, triées par jour ISO croissant puis par ' +
      'heure d’ouverture. Un même jour peut en porter plusieurs — c’est ainsi ' +
      'que se dit la coupure méridienne.',
  })
  public openingHours?: readonly OpeningHoursEntryDto[] | undefined;
}

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

/**
 * La vitrine ne porte aucun vocabulaire à casse divergente — ni statut, ni
 * rôle —, si bien que le jeu de clés **et** l'assignabilité champ par champ se
 * tiennent tous deux à la compilation, sans rien changer au format du fil.
 *
 * C'est la garde qui compte le plus de ce module : cette classe est ce qu'un
 * visiteur **sans authentification** reçoit, et chaque champ ajouté est une
 * décision de publication. Un `isActive` qui reviendrait par inadvertance dans
 * le `select` du repository échoue ici, et non en production.
 */
type PublicTenantWire = z.input<typeof publicTenantSchema>;
type PostalAddressWire = z.input<typeof postalAddressSchema>;
type OpeningHoursEntryWire = z.input<typeof openingHoursEntrySchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _PublicTenantDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PublicTenantDto, keyof PublicTenantWire>
  | Exclude<keyof PublicTenantWire, keyof PublicTenantDto>
>;

/**
 * L'assignabilité porte sur la forme **sans son tableau d'horaires**, et c'est
 * le seul écart du fichier.
 *
 * `openingHoursSchema` est un `z.array(...)`, dont le type inféré est un tableau
 * **mutable** ; cette classe le déclare `readonly`, et un `ReadonlyArray<T>`
 * n'est pas assignable à un `T[]`. L'écart n'est pas un défaut : la réponse est
 * rendue telle quelle par le service, et la rendre mutable inviterait un
 * appelant à la réordonner en place — alors que l'ordre est précisément ce que
 * `sortOpeningHours` établit une fois pour toutes. L'élément, lui, est tenu par
 * l'assertion d'`OpeningHoursEntryDto` ci-dessous.
 */
type _PublicTenantDtoIsReadableByTheContract = AssertTrue<
  Omit<PublicTenantDto, 'openingHours'> extends Omit<PublicTenantWire, 'openingHours'>
    ? true
    : false
>;

type _PostalAddressDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PostalAddressDto, keyof PostalAddressWire>
  | Exclude<keyof PostalAddressWire, keyof PostalAddressDto>
>;

type _PostalAddressDtoIsReadableByTheContract = AssertTrue<
  PostalAddressDto extends PostalAddressWire ? true : false
>;

type _OpeningHoursEntryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof OpeningHoursEntryDto, keyof OpeningHoursEntryWire>
  | Exclude<keyof OpeningHoursEntryWire, keyof OpeningHoursEntryDto>
>;

type _OpeningHoursEntryDtoIsReadableByTheContract = AssertTrue<
  OpeningHoursEntryDto extends OpeningHoursEntryWire ? true : false
>;
