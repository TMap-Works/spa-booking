import type { PrismaClient } from '@prisma/client';

import { ConflictError, InvalidStateTransitionError } from '../src/common/errors';
import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import type { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import {
  CONCURRENT_ATTEMPTS,
  ONE_HOUR,
  cancellation,
  createExclusionHarness,
  deskDraft,
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
 *    qu'un (#39), et deux reports de rendez-vous **distincts** vers des créneaux
 *    chevauchants non plus (#316) — l'exclusion du rendez-vous déplacé du calcul
 *    de disponibilité n'ouvre aucun chemin autour de la contrainte ;
 * 5. plusieurs **annulations** concurrentes du même rendez-vous n'en laissent
 *    aboutir qu'une (#40) ;
 * 6. une réservation **attend** une promotion de la fiche en cours au lieu d'en
 *    lire l'ancien rôle (#465, #468) — c'est le seul cas qui établisse que le
 *    `FOR SHARE` d'`assertClientBookableWithin` verrouille vraiment, la suite
 *    unitaire ne vérifiant que ce que la requête *demande*.
 *
 * Il y en avait un septième jusqu'à #1222 : deux réservations d'invité
 * concurrentes sur la même adresse inconnue, qui se disputaient
 * `@@unique([tenant_id, email])` (#313). Réserver n'écrit plus dans `users` —
 * la cliente a un compte —, et cette course n'existe plus.
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

    /**
     * La même course, mais **au comptoir** — sixième critère de #461.
     *
     * Elle n'est pas la répétition de la précédente, et c'est ce qui la rend
     * nécessaire : le brouillon du comptoir n'inscrit aucun consentement, et il
     * part d'une autre surface. Le seul arbitre est `appointments_no_overlap` —
     * aucune réservation n'écrit plus dans `users` depuis #1222, donc aucune
     * course n'y est rejouable. Si la boucle de réessai avait pris l'habitude de
     * rattraper les perdantes par un autre chemin, ce test le montrerait : huit
     * écritures qui **ne peuvent pas** être rejouées doivent produire un succès
     * et sept refus définitifs, pas huit rendez-vous.
     *
     * C'est aussi le seul endroit où la garantie du comptoir se prouve : le
     * double en mémoire des suites d'intégration ne simule pas une course, et
     * un tiroir qui laisse deux postes du salon cliquer sur le même créneau à la
     * même seconde est exactement le scénario que le CDC §6 classe risque n°1.
     */
    it(`produit un succès et ${CONCURRENT_ATTEMPTS - 1} conflits sur une fiche cliente désignée`, async () => {
      const start = new Date('2026-09-15T09:00:00.000Z');
      const end = new Date('2026-09-15T10:00:00.000Z');

      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          inTenant(salon.tenantId, () => repository.create(deskDraft(salon, start, end))),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // Toutes les perdantes en 409 : une seule qui remonterait brute
          // rendrait un 500 au comptoir, et le tiroir l'afficherait comme une
          // panne au lieu du créneau perdu qu'il traite déjà.
          expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
        }
      }

      // La preuve directe, sans passer par ce que les promesses ont bien voulu
      // dire — et sans fiche cliente créée en chemin, puisqu'il n'y en avait
      // aucune à résoudre.
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

  /**
   * La course sur le **rôle** de la fiche, refermée par #465 et #468.
   *
   * Le contrôle de rôle a été écrit sans verrou. Sous `READ COMMITTED` chaque
   * instruction prend son propre instantané : la lecture voyait `CLIENT`, une
   * transaction concurrente promouvait la fiche au personnel et validait, et
   * l'insertion passait — les deux clés étrangères de `appointments.client_id`
   * prouvent l'existence de la ligne et son établissement, jamais son rôle.
   * C'était la « vérification applicative suivie d'un `INSERT` » que
   * booking-engine §1 interdit.
   *
   * Ce cas est le seul du dépôt à établir que le `FOR SHARE` **verrouille
   * vraiment**, et non seulement que la requête le demande : la suite unitaire
   * lit une chaîne dans un double, ce qui ne dit rien du moteur. Le protocole est
   * donc celui d'une vraie course, ordonnée par un verrou de ligne réel :
   *
   * 1. une seconde connexion ouvre une transaction et promeut la fiche, sans
   *    valider — la ligne est alors verrouillée en exclusif ;
   * 2. la réservation démarre et **attend** sur ce verrou. Sans `FOR SHARE` elle
   *    ne l'attendrait pas : elle lirait l'ancienne version, encore `CLIENT`, et
   *    poserait le rendez-vous ;
   * 3. la promotion valide, la réservation suit la chaîne de mise à jour, relit
   *    `STAFF`, et refuse.
   *
   * Le refus est un **404** depuis #1222 : la fiche se désigne par son
   * identifiant, et c'est `assertClientBookableWithin` qui juge — inconnu, du
   * salon voisin ou promu au personnel se disent du même 404
   * (tenant-isolation §4). Il était un 409 tant que la résolution partait d'une
   * adresse, parce qu'alors le refus devait se distinguer d'une création.
   */
  describe('la promotion concurrente de la fiche (#465, #468)', () => {
    it('attend la promotion en cours au lieu de lire l’ancien rôle', async () => {
      const start = new Date('2026-10-06T09:00:00.000Z');
      const end = new Date(start.getTime() + ONE_HOUR);
      const email = `promotion-${start.getTime()}@example.test`;

      const fiche = await prismaUnscoped.user.create({
        data: {
          tenantId: salon.tenantId,
          email,
          role: 'CLIENT',
          firstName: 'Alice',
          lastName: 'Martin',
        },
      });

      // Le verrou est relâché **par le test**, pas par une horloge : une
      // temporisation dans la transaction qui promeut rendrait le cas dépendant
      // de la charge de la machine.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Et il est **pris** avant que la réservation ne démarre. Sans ce second
      // signal, les deux transactions partent ensemble et c'est l'ordonnanceur
      // qui décide laquelle atteint la ligne en premier : la réservation gagne
      // dès que le pool de connexions est chaud, lit `CLIENT` sans que rien ne
      // la bloque, et le cas passe pour la mauvaise raison — vert isolé, rouge
      // en suite. Ce que ce test doit prouver, c'est l'attente sur un verrou
      // déjà posé ; il faut donc qu'il le soit.
      let promoted!: () => void;
      const locked = new Promise<void>((resolve) => {
        promoted = resolve;
      });

      const promotion = prismaUnscoped.$transaction(
        async (tx) => {
          await tx.user.update({ where: { id: fiche.id }, data: { role: 'STAFF' } });
          promoted();
          await held;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );

      await locked;

      const booking = inTenant(salon.tenantId, () =>
        repository
          .create(draft(salon, start, end, salon.staffId, fiche.id))
          .catch((error: unknown) => error),
      );

      // De quoi laisser la réservation atteindre la lecture verrouillée et s'y
      // bloquer. Si elle ne s'y bloquait pas — `FOR SHARE` retiré — elle aurait
      // déjà lu `CLIENT` et posé le rendez-vous avant ce relâchement.
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      await promotion;

      expect(await booking).toMatchObject({ code: 'NOT_FOUND', status: 404 });
      // Et rien n'a été posé : le refus tombe dans la transaction d'insertion.
      expect(
        await prismaUnscoped.appointment.count({
          where: { tenantId: salon.tenantId, startsAt: start },
        }),
      ).toBe(0);
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

    /**
     * Deux reports **distincts** vers des créneaux qui se chevauchent (#316).
     *
     * C'est la course que le paramètre d'exclusion aurait pu ouvrir, et la
     * raison pour laquelle ce ticket a un test de concurrence. Chaque report
     * écarte *son* rendez-vous du calcul de disponibilité : les deux voient donc
     * l'arrivée libre, et les deux la demandent. Rien, côté lecture, ne les
     * départage.
     *
     * Ce qui les départage est ce qui les départageait déjà :
     * `appointments_no_overlap`, jugée à l'insertion, dans la transaction qui
     * annule la ligne de départ. Un second succès voudrait dire que l'exclusion
     * a ouvert un chemin autour d'elle — deux clientes dans la même cabine.
     *
     * Le test porte sur le **dépôt**, comme ses voisins : c'est là que la
     * transaction et la contrainte se jouent. La décision d'exclure, elle, est
     * exercée par `appointments.service.spec.ts`, et le calcul par
     * `availability.service.spec.ts`.
     */
    it('n’en laisse aboutir qu’un quand deux rendez-vous distincts visent des créneaux chevauchants', async () => {
      const morning = new Date('2027-02-01T09:00:00.000Z');
      const noon = new Date('2027-02-01T12:00:00.000Z');

      const [first, second] = await Promise.all([
        inTenant(salon.tenantId, () =>
          repository.create(draft(salon, morning, new Date(morning.getTime() + ONE_HOUR))),
        ),
        inTenant(salon.tenantId, () =>
          repository.create(draft(salon, noon, new Date(noon.getTime() + ONE_HOUR))),
        ),
      ]);

      // Deux arrivées décalées d'un quart d'heure : elles se chevauchent sans
      // partager une seule borne, ce qu'aucune contrainte d'unicité ne
      // rattraperait.
      const arrival = Date.UTC(2027, 1, 1, 15, 0, 0);
      const outcomes = await Promise.allSettled([
        inTenant(salon.tenantId, () =>
          repository.reschedule(
            move(first.id, new Date(arrival), new Date(arrival + ONE_HOUR), salon.staffId),
          ),
        ),
        inTenant(salon.tenantId, () =>
          repository.reschedule(
            move(
              second.id,
              new Date(arrival + 900_000),
              new Date(arrival + 900_000 + ONE_HOUR),
              salon.staffId,
            ),
          ),
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(SlotNoLongerAvailableError);
        }
      }

      // La preuve directe : une seule ligne occupe l'après-midi, et le report
      // perdant a laissé le sien intact — le `ROLLBACK` a emporté l'annulation.
      const afternoon = await prismaUnscoped.appointment.count({
        where: {
          tenantId: salon.tenantId,
          staffId: salon.staffId,
          status: { in: ['PENDING', 'CONFIRMED'] },
          startsAt: { gte: new Date(arrival), lt: new Date(arrival + 2 * ONE_HOUR) },
        },
      });
      expect(afternoon).toBe(1);

      const survivors = await prismaUnscoped.appointment.count({
        where: {
          tenantId: salon.tenantId,
          id: { in: [first.id, second.id] },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
      });
      expect(survivors).toBe(1);
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
