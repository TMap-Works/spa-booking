import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
}
