import { ApiProperty } from '@nestjs/swagger';

import type { PublicServiceView, StaffMemberSummaryView } from '../catalog.types';
import { ServiceCategorySummaryDto } from './service-category.dto';
import { MoneyDto } from './service.dto';

/**
 * DTO du catalogue **public** — ce qu'un visiteur sans compte reçoit avant de
 * réserver.
 *
 * Aucun DTO d'entrée ici : la seule route de cet espace est une lecture, et
 * l'établissement vient du contexte résolu par `TenantScopeMiddleware`, jamais
 * d'un champ. Ce qui rend ces routes sûres n'est pas une garde mais ce qu'elles
 * rendent — ces classes et leur liste blanche de champs.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/catalog.ts` (`publicServiceSchema`) ; elles
 * devront en être importées.
 */

/**
 * Le praticien tel que la page de réservation le montre : un nom à choisir.
 *
 * Rien de plus — ni `isActive`, qui vaudrait toujours `true` puisque la lecture
 * publique ne rend que les praticiens actifs, ni la `bio`, qui appartient à une
 * fiche praticien que ce ticket n'ouvre pas.
 */
export class PublicStaffMemberDto implements StaffMemberSummaryView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Camille Rousseau' })
  public displayName!: string;
}

/**
 * La prestation telle qu'elle sort du catalogue public.
 *
 * Trois champs de `ServiceDto` en sont délibérément absents :
 *
 * - `bufferBeforeMinutes` et `bufferAfterMinutes` — des temps de cabine, donc de
 *   l'exploitation. Les publier révélerait la cadence interne d'un salon à qui
 *   lit son catalogue, sans rien apporter au visiteur, qui ne voit et ne paie
 *   que la durée du soin ;
 * - `occupiedMinutes`, qui n'est que leur somme avec la durée et les redonnerait
 *   donc par soustraction ;
 * - `isActive`, qui vaudrait toujours `true`. Un champ constant invite à écrire
 *   un filtre côté client et à croire qu'il peut valoir `false`.
 */
export class PublicServiceDto implements PublicServiceView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public slug!: string;

  @ApiProperty()
  public name!: string;

  @ApiProperty({ nullable: true, type: String })
  public description!: string | null;

  @ApiProperty({ nullable: true, type: ServiceCategorySummaryDto })
  public category!: ServiceCategorySummaryDto | null;

  @ApiProperty({ description: 'Durée facturée du soin, en minutes — ce que le client paie.' })
  public durationMinutes!: number;

  @ApiProperty({ type: MoneyDto })
  public price!: MoneyDto;

  /**
   * `readonly` sur le tableau, et pas seulement pour la forme : `PublicServiceView`
   * le déclare ainsi, et un `PublicStaffMemberDto[]` mutable rendrait la vue
   * inassignable à ce DTO — un `ReadonlyArray` ne se convertit pas en `Array`.
   */
  @ApiProperty({
    type: [PublicStaffMemberDto],
    description:
      'Les praticiens actifs qui pratiquent la prestation, par nom. Vide tant ' +
      'qu’aucun n’y est affecté — la prestation reste alors réservable sans choix ' +
      'de praticien.',
  })
  public staff!: readonly PublicStaffMemberDto[];
}
