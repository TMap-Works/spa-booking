import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { getTenantId } from '../../../common/tenant';
import type { AvailabilityCacheService } from '../availability-cache';
import type { StaffTimeOffRepository } from '../staff-time-off.repository';
import type {
  StaffBusyRange,
  StaffTimeOffPatch,
  StaffTimeOffView,
  TimeOffWindow,
} from '../staff-time-off.types';

/**
 * Doubles des plages bloquées et congés (#33).
 *
 * Le dépôt en mémoire reproduit **cinq propriétés précises** du vrai, et chacune
 * porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent. C'est ce que l'extension Prisma
 *    fait en vrai. Un double qui ignorerait le tenant ferait passer les
 *    assertions d'isolation pour de mauvaises raisons, ce qui est pire que de ne
 *    pas les écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération ;
 * 3. la **clé étrangère composite `(tenant_id, staff_id)`** — poser une absence
 *    sur le praticien d'un autre établissement lève `NotFoundError`, exactement
 *    comme la traduction du code Prisma `P2003` par le vrai repository. C'est la
 *    propriété la plus importante des cinq : c'est elle qui rend le 404 gratuit
 *    plutôt qu'un 403 qui confirmerait l'existence du praticien voisin ;
 * 4. la **valeur de retour d'un `updateMany` / `deleteMany` scopé** — `null` ou
 *    `false` pour un identifiant inconnu *ou* d'un autre établissement,
 *    indistinctement. C'est cette valeur-là qui devient le 404 ;
 * 5. le **recoupement de fenêtre** — `startsAt < to AND endsAt > from`, et non
 *    l'inclusion. Un congé commencé avant la fenêtre et courant toujours doit en
 *    faire partie ; le double le reproduit pour que le test le constate.
 *
 * Ce qu'il ne reproduit **pas**, délibérément : le `CHECK` de bornes. C'est le
 * service qui doit refuser un intervalle vide, et un double complaisant sur ce
 * point ferait échouer le test qui le vérifie — pour la bonne raison.
 */

interface StoredTimeOff {
  tenantId: string;
  id: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

/** Le tenant de la portée courante, ou l'échec qu'oppose l'extension Prisma. */
function requireScope(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error('aucune portée de tenant : l’extension Prisma refuserait l’opération');
  }

  return tenantId;
}

function toView(row: StoredTimeOff): StaffTimeOffView {
  return {
    id: row.id,
    staffId: row.staffId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
  };
}

export class FakeStaffTimeOffRepository {
  private readonly rows: StoredTimeOff[] = [];

  /** Praticiens existants, par tenant — ce que la clé composite vérifie en base. */
  private readonly staff = new Map<string, Set<string>>();

  /** Inscrit un praticien dans un établissement, et rend son identifiant. */
  public registerStaff(tenantId: string, staffId: string = randomUUID()): string {
    const known = this.staff.get(tenantId) ?? new Set<string>();
    known.add(staffId);
    this.staff.set(tenantId, known);

    return staffId;
  }

  /** Toutes les lignes, tous tenants confondus — pour asserter qu'aucune n'a bougé. */
  public snapshot(): readonly StoredTimeOff[] {
    return this.rows.map((row) => ({ ...row }));
  }

  public asRepository(): StaffTimeOffRepository {
    return this as unknown as StaffTimeOffRepository;
  }

  public list(window: TimeOffWindow, staffId?: string): Promise<StaffTimeOffView[]> {
    const tenantId = requireScope();

    return Promise.resolve(
      this.rows
        .filter((row) => row.tenantId === tenantId)
        .filter((row) => staffId === undefined || row.staffId === staffId)
        .filter((row) => row.startsAt < window.to && row.endsAt > window.from)
        .sort(
          (left, right) =>
            left.startsAt.getTime() - right.startsAt.getTime() || left.id.localeCompare(right.id),
        )
        .map((row) => toView(row)),
    );
  }

  public findById(id: string): Promise<StaffTimeOffView | null> {
    const tenantId = requireScope();
    const found = this.rows.find((row) => row.tenantId === tenantId && row.id === id);

    return Promise.resolve(found === undefined ? null : toView(found));
  }

  public create(input: {
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
  }): Promise<StaffTimeOffView> {
    const tenantId = requireScope();

    // La clé étrangère composite `(tenant_id, staff_id)` : le praticien d'un
    // autre établissement est aussi introuvable qu'un praticien inexistant.
    if (this.staff.get(tenantId)?.has(input.staffId) !== true) {
      return Promise.reject(new NotFoundError('Praticien introuvable.'));
    }

    const row: StoredTimeOff = {
      tenantId,
      id: randomUUID(),
      staffId: input.staffId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
    };

    this.rows.push(row);

    return Promise.resolve(toView(row));
  }

  public update(id: string, patch: StaffTimeOffPatch): Promise<StaffTimeOffView | null> {
    const tenantId = requireScope();
    const found = this.rows.find((row) => row.tenantId === tenantId && row.id === id);

    if (found === undefined) {
      return Promise.resolve(null);
    }

    if (patch.startsAt !== undefined) {
      found.startsAt = patch.startsAt;
    }
    if (patch.endsAt !== undefined) {
      found.endsAt = patch.endsAt;
    }
    if (patch.reason !== undefined) {
      found.reason = patch.reason;
    }

    return Promise.resolve(toView(found));
  }

  public deleteById(id: string): Promise<boolean> {
    const tenantId = requireScope();
    const index = this.rows.findIndex((row) => row.tenantId === tenantId && row.id === id);

    if (index === -1) {
      return Promise.resolve(false);
    }

    this.rows.splice(index, 1);

    return Promise.resolve(true);
  }

  public listBusyRanges(
    staffIds: readonly string[],
    window: TimeOffWindow,
  ): Promise<StaffBusyRange[]> {
    const tenantId = requireScope();

    if (staffIds.length === 0) {
      return Promise.resolve([]);
    }

    return Promise.resolve(
      this.rows
        .filter((row) => row.tenantId === tenantId)
        .filter((row) => staffIds.includes(row.staffId))
        .filter((row) => row.startsAt < window.to && row.endsAt > window.from)
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
        // Le `select` du vrai ne charge **pas** `reason` : le double ne doit pas
        // le rendre non plus, sinon le test qui vérifie son absence passerait
        // sans rien garantir.
        .map((row) => ({ staffId: row.staffId, startsAt: row.startsAt, endsAt: row.endsAt })),
    );
  }
}

/**
 * Compteur d'invalidations du cache de disponibilité.
 *
 * Ce que les tests en attendent n'est pas « le cache est vide » — il n'y a pas
 * encore de cache — mais « le chemin d'écriture a bien appelé l'invalidation ».
 * C'est la propriété qui s'oublie, et la seule que ce ticket puisse garantir.
 */
export class SpyAvailabilityCache {
  public calls = 0;

  public asService(): AvailabilityCacheService {
    return this as unknown as AvailabilityCacheService;
  }

  public invalidateCurrentTenant(): Promise<void> {
    this.calls += 1;

    return Promise.resolve();
  }
}
