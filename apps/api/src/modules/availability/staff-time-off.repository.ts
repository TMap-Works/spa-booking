import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotFoundError } from '../../common/errors';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type {
  StaffBusyRange,
  StaffTimeOffPatch,
  StaffTimeOffView,
  TimeOffWindow,
} from './staff-time-off.types';

/**
 * Seul point du module à connaître le schéma des indisponibilités
 * (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une requête d'ici
 * ait à le répéter — donc sans qu'aucune puisse l'oublier. Aucune dérogation :
 * rien dans les plages bloquées n'est légitimement inter-tenant, et
 * `prismaUnscoped` n'y est donc pas injecté du tout.
 *
 * ## Un fichier à part de `availability.repository.ts`
 *
 * Les horaires récurrents du personnel (#32) et le calcul de créneaux (#34)
 * auront leur propre accès au schéma. Les plages bloquées sont une table
 * autonome, lue par deux chemins qui n'ont rien en commun — le planning de
 * back-office et le moteur de créneaux —, et les réunir dans un repository
 * unique n'apporterait qu'un fichier plus long à relire.
 */

/**
 * Projections explicites, écrites une fois.
 *
 * Ni `tenantId`, ni les horodatages techniques : le `select` explicite est ce
 * qui rend vérifiable à la lecture qu'aucune entité Prisma brute ne sort du
 * module (api-module §4).
 */
const TIME_OFF_SELECT = {
  id: true,
  staffId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
} as const;

/**
 * La projection du moteur de créneaux — **sans `reason`**.
 *
 * C'est ici que le critère « motif visible du back-office uniquement » devient
 * une propriété du code plutôt qu'une consigne : la colonne n'est pas
 * sélectionnée, donc rien en aval ne peut la publier par mégarde.
 */
const BUSY_SELECT = { staffId: true, startsAt: true, endsAt: true } as const;

/** Ligne telle que Prisma la rend sous `TIME_OFF_SELECT`. */
interface StaffTimeOffRow {
  id: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `catalog.repository.ts` : le
 * type généré par Prisma exige `tenantId` — la colonne est `NOT NULL` — alors
 * que le repository ne doit justement pas le fournir. C'est l'extension qui le
 * pose depuis le contexte de requête, et qui **écrase** ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * L'absence, sous la forme que l'API rend.
 *
 * Vit ici, à côté de la projection qu'elle consomme, comme `toCategoryView` dans
 * `catalog.repository.ts` : c'est le même endroit qui décide ce qui sort de la
 * base et ce qui sort de l'API, donc le seul à relire pour vérifier qu'aucune
 * colonne interne ne franchit la frontière.
 */
export function toStaffTimeOffView(row: StaffTimeOffRow): StaffTimeOffView {
  return {
    id: row.id,
    staffId: row.staffId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
  };
}

/** Code Prisma d'une violation de clé étrangère. */
const FOREIGN_KEY_VIOLATION = 'P2003';

/**
 * `true` si l'erreur est le refus d'une des deux clés étrangères vers `staff`.
 *
 * Les deux comptent, et pour deux raisons différentes : la mono-colonne attrape
 * l'identifiant qui n'existe nulle part, la composite `(tenant_id, staff_id)`
 * attrape celui d'un **autre établissement**. C'est cette seconde qui rend le
 * 404 gratuit — sans elle, la ligne serait écrite et un salon poserait des
 * congés sur le praticien d'un concurrent.
 */
function isStaffReferenceViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === FOREIGN_KEY_VIOLATION
  );
}

@Injectable()
export class StaffTimeOffRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Les absences de l'établissement courant qui **recoupent** la fenêtre.
   *
   * Le prédicat est `startsAt < to AND endsAt > from`, et non
   * `startsAt >= from AND endsAt <= to` : un congé commencé le mois dernier et
   * courant toujours doit apparaître au planning de ce mois-ci. Le retenir sur
   * son seul début le ferait disparaître de tous les mois qu'il traverse sauf le
   * premier — et le praticien semblerait disponible pendant ses congés.
   *
   * Les bornes suivent la convention `[from, to[` du module : une absence qui
   * finit exactement à `from` ne recoupe pas la fenêtre.
   *
   * `@@index([tenantId, staffId, startsAt])` sert la lecture filtrée par
   * praticien, `@@index([tenantId, startsAt])` celle du planning complet.
   *
   * L'ordre est stable — début, puis identifiant : sans `orderBy`, PostgreSQL
   * n'en garantit aucun et le planning change d'un appel à l'autre. `id` départage
   * deux absences commencées au même instant, ce qui arrive dès qu'on pose la
   * même journée pour deux praticiens.
   */
  public async list(
    window: TimeOffWindow,
    staffId?: string,
  ): Promise<StaffTimeOffView[]> {
    const rows = await this.prisma.staffTimeOff.findMany({
      where: {
        ...(staffId !== undefined && { staffId }),
        startsAt: { lt: window.to },
        endsAt: { gt: window.from },
      },
      select: TIME_OFF_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => toStaffTimeOffView(row));
  }

  /**
   * Une absence de l'établissement courant, par identifiant.
   *
   * `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
   * `where`, et `findUnique` exige que le `where` désigne *exactement* une clé
   * unique. Rend `null` pour l'identifiant d'un autre établissement, ce qui donne
   * le 404 attendu plutôt qu'un 403 qui confirmerait l'existence de la ligne.
   */
  public async findById(id: string): Promise<StaffTimeOffView | null> {
    const row = await this.prisma.staffTimeOff.findFirst({
      where: { id },
      select: TIME_OFF_SELECT,
    });

    return row === null ? null : toStaffTimeOffView(row);
  }

  /**
   * Pose une absence sur un praticien de l'établissement courant.
   *
   * Aucune vérification préalable de l'existence du praticien : c'est la base
   * qui tranche, comme pour le slug du catalogue et pour le créneau du moteur de
   * réservation (booking-engine §1). Un contrôle applicatif suivi d'un `INSERT`
   * serait faux sous concurrence — le praticien peut disparaître entre les
   * deux — et coûterait une requête de plus au cas passant, qui est la règle.
   *
   * La violation de clé étrangère devient un **404**, jamais un 403 : un
   * praticien inconnu et le praticien d'un autre établissement doivent être
   * indiscernables (tenant-isolation §4).
   */
  public async create(input: {
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
  }): Promise<StaffTimeOffView> {
    try {
      const row = await this.prisma.staffTimeOff.create({
        data: withScopedTenant<Prisma.StaffTimeOffUncheckedCreateInput>({
          staffId: input.staffId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason,
        }),
        select: TIME_OFF_SELECT,
      });

      return toStaffTimeOffView(row);
    } catch (error: unknown) {
      if (isStaffReferenceViolation(error)) {
        throw new NotFoundError('Praticien introuvable.');
      }
      throw error;
    }
  }

  /**
   * Modifie une absence de l'établissement courant. Rend `null` si aucune ligne
   * n'a été touchée — identifiant inconnu, ou d'un autre établissement.
   *
   * `updateMany` et non `update` : sous le scoping, le `where` porte `id` **et**
   * `tenantId`, ce qui n'est pas une clé unique au sens de Prisma. Le compte est
   * surtout la propriété utile — il vaut `0` pour l'identifiant d'un autre
   * établissement, ce qui donne le 404 sans avoir à distinguer les deux cas.
   *
   * La relecture qui suit est une seconde requête, donc un second instant : une
   * modification concurrente rendrait l'état le plus récent plutôt que celui que
   * cet appel vient d'écrire. C'est le comportement voulu sur un planning — la
   * dernière écriture gagne, et rendre un état déjà périmé tromperait l'écran qui
   * l'affiche.
   */
  public async update(id: string, patch: StaffTimeOffPatch): Promise<StaffTimeOffView | null> {
    const data: Prisma.StaffTimeOffUncheckedUpdateInput = {
      ...(patch.startsAt !== undefined && { startsAt: patch.startsAt }),
      ...(patch.endsAt !== undefined && { endsAt: patch.endsAt }),
      ...(patch.reason !== undefined && { reason: patch.reason }),
    };

    const { count } = await this.prisma.staffTimeOff.updateMany({ where: { id }, data });

    return count === 0 ? null : this.findById(id);
  }

  /**
   * Retire une absence de l'établissement courant. `false` si aucune ligne n'a
   * été touchée — identifiant inconnu, ou d'un autre établissement.
   *
   * Une vraie suppression, contrairement au reste du schéma où l'on désactive :
   * une absence annulée n'a **aucune valeur d'historique**. Personne ne compte
   * les congés qui n'ont pas eu lieu, aucune ligne ne la référence, et lui donner
   * un `is_active` obligerait chaque lecture du moteur de créneaux à filtrer
   * dessus — un filtre oublié rendrait un praticien indisponible pour un congé
   * qu'il a annulé.
   */
  public async deleteById(id: string): Promise<boolean> {
    const { count } = await this.prisma.staffTimeOff.deleteMany({ where: { id } });

    return count > 0;
  }

  /**
   * Les intervalles d'occupation des praticiens demandés, sur la fenêtre — la
   * lecture que le calcul de créneaux (#34) consomme.
   *
   * Elle est **distincte de `list`** pour une raison de fond et non de confort :
   * elle ne sélectionne pas `reason`. Le moteur n'a aucun usage du motif, et la
   * page de réservation publique où ses résultats aboutissent n'a rien à en
   * connaître. Une seule méthode servant les deux appelants aurait transporté le
   * motif jusque-là, en comptant sur chaque intermédiaire pour ne pas le publier.
   *
   * `staffIds` vide rend une liste vide sans requête : c'est le cas d'un service
   * qu'aucun praticien ne pratique, et un `IN ()` s'écrirait `false` en SQL sans
   * que ce soit lisible.
   */
  public async listBusyRanges(
    staffIds: readonly string[],
    window: TimeOffWindow,
  ): Promise<StaffBusyRange[]> {
    if (staffIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.staffTimeOff.findMany({
      where: {
        staffId: { in: [...staffIds] },
        startsAt: { lt: window.to },
        endsAt: { gt: window.from },
      },
      select: BUSY_SELECT,
      orderBy: [{ startsAt: 'asc' }],
    });

    return rows.map((row) => ({
      staffId: row.staffId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    }));
  }
}
