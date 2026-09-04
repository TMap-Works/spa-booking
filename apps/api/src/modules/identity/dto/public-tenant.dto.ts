import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
 * Reprend `postalAddressSchema` de `packages/shared` — même TODO(#26) que
 * `PublicTenantDto` ci-dessous.
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
 * front consomme.
 *
 * TODO(#26) : `@spa/shared` porte déjà cette forme (`publicTenantSchema`,
 * `PublicTenant`), mais `apps/api` ne dépend pas encore du paquet — c'est ce que
 * #26 câble. La classe subsistera de toute façon : `@nestjs/swagger` documente
 * une réponse par une classe décorée, pas par un schéma Zod. Ce qu'apportera le
 * câblage, c'est de pouvoir la contraindre au contrat
 * (`PublicTenantDto implements PublicTenant`) au lieu de la maintenir identique
 * à la main.
 *
 * D'ici là, le champ à champ ci-dessous suit `publicTenantSchema` **exactement**,
 * optionalité comprise.
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
