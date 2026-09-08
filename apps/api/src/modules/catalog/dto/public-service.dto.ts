import { ApiProperty } from '@nestjs/swagger';
import { publicServiceSchema, staffMemberSummarySchema } from '@spa/shared';
import type { z } from 'zod';

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
 * Depuis #510, cette liste blanche n'est plus seulement déclarative : les
 * assertions de compilation en fin de fichier la tiennent contre
 * `publicServiceSchema` du contrat, si bien qu'un champ ajouté ici sans l'être
 * là-bas — un tampon de cabine, l'état d'activation — casse le `tsc` au lieu de
 * partir sur le fil.
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

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * Le catalogue public ne porte aucun vocabulaire à casse divergente — ni statut,
 * ni rôle —, si bien que le jeu de clés **et** l'assignabilité champ par champ
 * se tiennent tous deux à la compilation, sans rien changer au format du fil.
 *
 * C'est la garde qui compte le plus de tout le module : cette classe est ce
 * qu'un visiteur **sans compte** reçoit, et chacun des trois champs que
 * l'en-tête écarte est une information d'exploitation. Un `bufferAfterMinutes`
 * ajouté par inadvertance au `select` du repository échoue ici, et non en
 * production.
 */
type PublicServiceWire = z.input<typeof publicServiceSchema>;
type PublicStaffMemberWire = z.input<typeof staffMemberSummarySchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _PublicServiceDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PublicServiceDto, keyof PublicServiceWire>
  | Exclude<keyof PublicServiceWire, keyof PublicServiceDto>
>;

/**
 * L'assignabilité champ par champ porte sur la forme **sans son tableau**, et
 * c'est le seul écart de tout le fichier.
 *
 * `publicServiceSchema` déclare `staff: z.array(...)`, dont le type inféré est
 * un tableau **mutable** ; `PublicServiceView` le déclare `readonly`, et un
 * `ReadonlyArray<T>` n'est pas assignable à un `T[]`. L'écart n'est pas un
 * défaut : la vue est rendue telle quelle par le service, et la rendre mutable
 * inviterait un appelant à la modifier en place. La garde est donc posée sur le
 * reste des champs, et le tableau est tenu par l'assertion de son élément —
 * `PublicStaffMemberDto` ci-dessous.
 */
type _PublicServiceDtoIsReadableByTheContract = AssertTrue<
  Omit<PublicServiceDto, 'staff'> extends Omit<PublicServiceWire, 'staff'> ? true : false
>;

type _PublicStaffMemberDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PublicStaffMemberDto, keyof PublicStaffMemberWire>
  | Exclude<keyof PublicStaffMemberWire, keyof PublicStaffMemberDto>
>;

type _PublicStaffMemberDtoIsReadableByTheContract = AssertTrue<
  PublicStaffMemberDto extends PublicStaffMemberWire ? true : false
>;
