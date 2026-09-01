import type { PrismaClient } from '@prisma/client';

import { ConflictError, InvalidStateTransitionError } from '../src/common/errors';
import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import type { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import {
  CONCURRENT_ATTEMPTS,
  ONE_HOUR,
  cancellation,
  createExclusionHarness,
  draft,
  inTenant,
  move,
  type ExclusionHarness,
  type Fixture,
} from './appointments-exclusion.harness';

/**
 * Les **courses** du moteur de réservation, contre un vrai PostgreSQL — la
 * seule suite de la cible `npm run test:concurrency` (#31, #326).
 *
 * ## Pourquoi ces cas ont une cible à eux
 *
 * Le risque n°1 du projet (CDC §6) est une course, et une course ne se simule
 * pas contre un double en mémoire : ce qui est en cause est l'atomicité du
 * moteur, pas la logique du repository. Un test qui remplacerait Prisma par un
 * faux prouverait que le code traduit bien une erreur qu'il aurait lui-même
 * fabriquée — c'est-à-dire rien du tout.
 *
 * Ces cas vivaient jusqu'à #326 dans `appointments-exclusion.integration-spec.ts`
 * et n'étaient donc joués que par `test:integration:api`. La cible
 * `test:concurrency`, elle, était un fan-out `--if-present` que plus aucun
 * workspace ne servait : l'étape « Tests de concurrence » du job `test`
 * verdissait sans avoir rien exercé, et serait restée verte le jour où ces cas
 * auraient disparu. Le suffixe `*.concurrency-spec.ts` fait porter la promesse
 * par le nom du fichier, et rend la cible capable d'échouer.
 *
 * Ce qui est prouvé ici, et qui n'est prouvable nulle part ailleurs :
 *
 * 1. **N écritures parallèles sur le même créneau produisent exactement un
 *    succès** et N−1 conflits — le test non négociable de booking-engine §6 ;
 * 2. des chevauchements **partiels décalés** sont sérialisés de la même façon :
 *    aucune contrainte d'unicité ne les rattraperait, seule l'exclusion sur
 *    l'intervalle le fait ;
 * 3. le **repli** de l'option « premier disponible » (#36) ne peut pas produire
 *    de double réservation ;
 * 4. plusieurs **reports** concurrents du même rendez-vous n'en laissent aboutir
 *    qu'un (#39) ;
 * 5. plusieurs **annulations** concurrentes du même rendez-vous n'en laissent
 *    aboutir qu'une (#40).
 *
 * Le décor — base jetable, dépôt scopé, établissement complet — est celui de
 * `appointments-exclusion.harness.ts`, partagé avec la suite d'intégration
 * voisine : une course jouée sur un autre décor que les cas nominaux ne
 * prouverait pas la même chose qu'eux.
 */
describe('Courses sur la contrainte d’exclusion — contre un vrai PostgreSQL', () => {
  let harness: ExclusionHarness | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  let repository: AppointmentsRepository;
  let salon: Fixture;

  beforeAll(async () => {
    harness = await createExclusionHarness();
    ({ prismaUnscoped, repository } = harness);
    salon = await harness.seed('salon');
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('N écritures parallèles sur le même créneau', () => {
    it(`produit exactement un succès et ${CONCURRENT_ATTEMPTS - 1} conflits`, async () => {
      // Le test non négociable de booking-engine §6. Il ne prouve pas que le
      // code est prudent : il prouve que la prudence du code est **inutile**,
      // parce que la base tranche à sa place.
      const start = new Date('2026-09-10T09:00:00.000Z');
      const end = new Date('2026-09-10T10:00:00.000Z');

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => repository.create(draft(salon, start, end))),
        ),
      );

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(CONCURRENT_ATTEMPTS - 1);
      // Toutes les perdantes en 409 : une seule qui remonterait brute suffirait à
      // rendre un 500 au client, et c'est précisément ce que #31 supprime.
      for (const outcome of rejected) {
        expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
      }

      // Et la base ne porte bien qu'une ligne — la preuve directe, sans passer
      // par ce que les promesses ont bien voulu dire.
      const stored = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, staffId: salon.staffId, startsAt: start },
      });
      expect(stored).toBe(1);
    });

    it('sérialise aussi des chevauchements partiels décalés', async () => {
      // Des bornes toutes différentes : aucune contrainte d'unicité ne les
      // rattraperait, seule l'exclusion sur l'intervalle le fait.
      const base = Date.UTC(2026, 8, 11, 9, 0, 0);
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.create(
              draft(
                salon,
                new Date(base + index * 60_000),
                new Date(base + index * 60_000 + ONE_HOUR),
              ),
            ),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
        }
      }
    });

    /**
     * Le repli de l'option « premier disponible », sous concurrence réelle (#36,
     * quatrième critère).
     *
     * La boucle est rejouée ici plutôt qu'appelée : `AppointmentsService` exige
     * le catalogue, le moteur de disponibilité et un contexte HTTP, et sa
     * **décision** — qui tenter, dans quel ordre, quand s'arrêter — est déjà
     * exercée par `appointments.service.spec.ts`. Ce que seule une vraie base
     * peut prouver est autre chose, et c'est le seul objet de ce test : que
     * *tenter un autre praticien après un refus* ne peut pas produire une double
     * réservation, parce que chaque tentative reste jugée par
     * `appointments_no_overlap`.
     *
     * Huit clientes sans préférence se disputent le même créneau chez deux
     * praticiens. Il doit en sortir **exactement deux** rendez-vous — un par
     * praticien — et six 409. Un seul succès de trop, et le salon aurait deux
     * clientes dans la même cabine.
     */
    it('affecte au plus un rendez-vous par praticien quand huit demandes sans préférence se répondent', async () => {
      const start = new Date('2026-09-12T09:00:00.000Z');
      const end = new Date('2026-09-12T10:00:00.000Z');
      const candidates = [salon.staffId, salon.secondStaffId];

      /** La boucle de `book` : le premier praticien que la base accepte. */
      const firstFree = async (): Promise<string> => {
        for (const staffId of candidates) {
          try {
            await repository.create(draft(salon, start, end, staffId));
            return staffId;
          } catch (error: unknown) {
            if (!(error instanceof SlotNoLongerAvailableError)) {
              throw error;
            }
          }
        }
        throw new SlotNoLongerAvailableError(null, start);
      };

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => firstFree()),
        ),
      );

      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(candidates.length);
      // Deux succès **chez deux praticiens différents** : deux succès chez le
      // même seraient la double réservation que tout ce module existe pour
      // rendre impossible.
      expect(new Set(fulfilled.map((outcome) => outcome.value)).size).toBe(candidates.length);
      expect(rejected).toHaveLength(CONCURRENT_ATTEMPTS - candidates.length);
      for (const outcome of rejected) {
        expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
        // Le refus final d'une demande sans préférence ne nomme personne.
        expect(outcome.reason).toMatchObject({ details: { staffId: null } });
      }

      // La preuve directe, sans passer par ce que les promesses ont bien voulu
      // dire : deux lignes, une par praticien.
      const stored = await prismaUnscoped.appointment.groupBy({
        by: ['staffId'],
        where: { tenantId: salon.tenantId, startsAt: start },
        _count: { _all: true },
      });
      expect(stored).toHaveLength(candidates.length);
      for (const row of stored) {
        expect(row._count._all).toBe(1);
      }
    });
  });

  describe('le report sous concurrence', () => {
    it('ne laisse aboutir qu’un seul de plusieurs reports concurrents du même rendez-vous', async () => {
      // Chacun vise un praticien et un créneau libres : rien ne les départage
      // sinon l'écriture conditionnelle sur le statut de la ligne de départ.
      // Deux succès donneraient deux rendez-vous à une cliente qui n'en a
      // demandé qu'un, et deux successeurs à un seul prédécesseur.
      const start = new Date('2026-12-04T09:00:00.000Z');
      const previous = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      const base = Date.UTC(2026, 11, 4, 14, 0, 0);
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.reschedule(
              move(
                previous.id,
                new Date(base + index * ONE_HOUR),
                new Date(base + index * ONE_HOUR + ONE_HOUR),
                index % 2 === 0 ? salon.staffId : salon.secondStaffId,
              ),
            ),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const successors = await prismaUnscoped.appointment.count({
        where: { tenantId: salon.tenantId, rescheduledFromId: previous.id },
      });
      expect(successors).toBe(1);
    });
  });

  describe('l’annulation sous concurrence', () => {
    it('ne laisse aboutir qu’une seule de plusieurs annulations concurrentes', async () => {
      // Deux succès inscriraient deux auteurs et deux motifs sur la même ligne,
      // dont un seul survivrait — sans que personne sache lequel.
      const start = new Date('2027-01-07T09:00:00.000Z');
      const created = await inTenant(salon.tenantId, () =>
        repository.create(draft(salon, start, new Date(start.getTime() + ONE_HOUR))),
      );

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, (_unused, index) =>
          inTenant(salon.tenantId, () =>
            repository.cancel(cancellation(created.id, { reason: `essai ${index}` })),
          ),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // 409 ou 422 selon que la perdante a relu la ligne avant ou après la
          // validation de la gagnante — jamais un 500, et jamais un succès.
          expect(
            outcome.reason instanceof ConflictError ||
              outcome.reason instanceof InvalidStateTransitionError,
          ).toBe(true);
        }
      }

      // Un seul motif inscrit, celui de la gagnante.
      const row = await prismaUnscoped.appointment.findUnique({
        where: { id: created.id },
        select: { status: true, cancellationReason: true },
      });
      expect(row?.status).toBe('CANCELLED');
      expect(row?.cancellationReason).toMatch(/^essai \d$/);
    });
  });
});
