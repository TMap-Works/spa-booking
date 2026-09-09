import { SlotNoLongerAvailableError } from '../src/modules/appointments/appointments.errors';
import {
  addDays,
  bookingDraft,
  createLoadHarness,
  disjointPerStaff,
  inTenant,
  loadFactor,
  measure,
  overlappingPairs,
  renderMeasureTable,
  type LoadHarness,
  type LoadSlot,
  type Measure,
  type Salon,
} from './load.harness';

/**
 * **Tests de charge du tunnel de réservation** — troisième critère de #83, sur
 * son second volet, et la mesure du risque n°1 du projet (CDC §6, contrainte non
 * négociable n°4 du CLAUDE.md).
 *
 * ## La question à laquelle cette suite répond
 *
 * `appointments-exclusion.concurrency-spec.ts` répond à « huit écritures
 * simultanées peuvent-elles produire deux rendez-vous ? » — non. Celle-ci répond
 * à la question suivante, qui n'est pas la même : **à quel débit, et jusqu'où**.
 * Un samedi matin, ce ne sont pas huit clientes qui rafraîchissent la même page,
 * et le verrou consultatif d'agenda sérialise par praticien : la question de
 * savoir ce que cette sérialisation coûte se pose, et ne se répond pas par
 * raisonnement.
 *
 * ## Les trois scénarios, et le taux de conflit attendu de chacun
 *
 * | Scénario | Forme | Conflits attendus |
 * |---|---|---|
 * | Débit nominal | N créneaux distincts, une tentative chacun | **0 %** — rien ne se dispute |
 * | Contention ordinaire | 24 créneaux, 8 candidates chacun | **87,5 %** — 24 succès sur 192 |
 * | Contention maximale | 1 créneau, 32 candidates | **96,875 %** — 1 succès sur 32 |
 *
 * Ces taux ne sont pas des observations : ce sont des **prédictions**, et la
 * suite les assère à l'unité près. Un taux observé inférieur voudrait dire qu'un
 * créneau a été vendu deux fois ; un taux supérieur, qu'une réservation légitime
 * a été refusée. Les deux sont des défauts, et l'égalité stricte est ce qui les
 * rend visibles.
 *
 * L'invariant final est relu **en base**, par une jointure qui cherche les
 * chevauchements — sans passer par le code qui vient d'écrire.
 *
 * ## Ce que la mesure ne couvre pas
 *
 * La couche HTTP, le quota de débit, le cache Redis et le réseau. Ce qui est
 * chargé ici est la transaction d'insertion et son arbitre,
 * `appointments_no_overlap`. Une campagne de tirs sur l'application servie reste
 * à jouer sur staging — `docs/recette/cahier-de-recette-mvp.md`, §7.
 */
describe('Charge — tunnel de réservation', () => {
  const NOW = new Date('2027-02-01T08:00:00.000Z');
  const FIRST_DAY = '2027-03-01';
  const LAST_DAY = addDays(FIRST_DAY, 6);

  /**
   * Les créneaux que les deux scénarios de **contention** se réservent — vingt-quatre
   * disputés à huit, plus celui de la ruée à trente-deux.
   *
   * Ils sont pris **en fin** de liste, et le scénario de débit nominal ne pioche
   * que dans ce qui reste. Sans cette réserve, `SPA_LOAD_FACTOR=2` suffisait à
   * faire consommer par le premier scénario les créneaux que les deux suivants
   * attendaient libres : leurs tentatives tombaient alors toutes en 409, et une
   * campagne — le seul cas où le facteur est relevé — rougissait sur deux cas
   * qu'elle n'avait pas cassés.
   */
  const RÉSERVÉS = 25;

  let harness: LoadHarness | undefined;
  let salon: Salon;
  /** Les créneaux deux à deux disjoints du salon, tels que le moteur les rend. */
  let libres: LoadSlot[];
  const relevés: Measure[] = [];

  beforeAll(async () => {
    harness = await createLoadHarness();
    // Agenda vierge : ce scénario **remplit** l'agenda, et c'est son propos. Le
    // garnir d'avance retirerait des créneaux à la mesure de débit nominal.
    salon = await harness.seed({ firstDay: FIRST_DAY, days: 7, staffCount: 4, bookedPerStaff: 0 });

    const view = await inTenant(salon.tenantId, () =>
      harness!.engine.slotsFor({ serviceId: salon.serviceId, from: FIRST_DAY, to: LAST_DAY }, NOW),
    );

    // Les créneaux sont pris **du moteur**, jamais recalculés ici : c'est la
    // seule façon de garantir qu'ils sont réellement proposables — et de ne pas
    // réimplémenter le découpage dans une suite qui n'a pas à le connaître.
    libres = disjointPerStaff(view.days.flatMap((day) => day.slots));
  }, 180_000);

  afterAll(async () => {
    if (relevés.length > 0) {
      renderMeasureTable('Charge — tunnel de réservation', relevés);
    }

    await harness?.close();
  });

  const book = (staffId: string, startsAt: string, email?: string) => async () => {
    await inTenant(salon.tenantId, () =>
      harness!.appointments.create(bookingDraft(salon, staffId, new Date(startsAt), email)),
    );
  };

  it('soutient 96 réservations sur des créneaux distincts sans un seul refus', async () => {
    // Jamais dans la réserve des deux scénarios de contention, quel que soit le
    // facteur de charge.
    const nominaux = libres.slice(0, Math.max(libres.length - RÉSERVÉS, 0));
    const attempts = Math.min(96 * loadFactor(), nominaux.length);

    expect(attempts).toBeGreaterThanOrEqual(96);

    const relevé = await measure(
      'Débit nominal (créneaux distincts)',
      nominaux.slice(0, attempts).map((slot) => book(slot.staffId, slot.startsAt)),
    );
    relevés.push(relevé);

    // Aucun refus : chaque tentative visait un créneau libre et disjoint des
    // autres. Un seul refus ici voudrait dire que le moteur a proposé deux fois
    // le même créneau, ou que la contrainte d'exclusion refuse un intervalle
    // qu'elle devrait accepter.
    expect(relevé.errors).toEqual([]);
    expect(relevé.succeeded).toBe(attempts);
    expect(relevé.conflictRate).toBe(0);
    // Plafond d'ordre de grandeur : une insertion de rendez-vous est de l'ordre
    // de la dizaine de millisecondes. Dix secondes ne se franchissent que si le
    // verrou d'agenda s'est mis à sérialiser ce qu'il ne devrait pas.
    expect(relevé.p95Ms).toBeLessThan(10_000);

    expect(await overlappingPairs(harness!.prismaUnscoped, salon.tenantId)).toBe(0);
  }, 300_000);

  it('n’attribue qu’un rendez-vous par créneau quand huit candidates se disputent chacun des 24 restants', async () => {
    const disputés = libres.slice(libres.length - RÉSERVÉS, libres.length - 1);

    expect(disputés).toHaveLength(24);

    const candidates = 8;
    // Une adresse par candidate : sans cela les huit tentatives partageraient la
    // fiche cliente semée, et la course sur `users` — celle de #313 — ne serait
    // pas dans la mesure. Or elle y est en production, à chaque réservation
    // d'invitée.
    const tâches = shuffle(
      disputés.flatMap((slot, index) =>
        Array.from({ length: candidates }, (_unused, essai) =>
          book(slot.staffId, slot.startsAt, `charge-${index}-${essai}@example.test`),
        ),
      ),
    );

    const relevé = await measure('Contention ordinaire (8 candidates × 24 créneaux)', tâches);
    relevés.push(relevé);

    // Exactement un succès par créneau — ni plus, ce serait une double
    // réservation ; ni moins, ce serait une réservation perdue sur un créneau
    // libre.
    expect(relevé.succeeded).toBe(disputés.length);
    expect(relevé.rejected).toBe(disputés.length * (candidates - 1));
    // Le taux prédit, à l'arrondi du relevé près : 168 / 192 = 87,5 %.
    expect(relevé.conflictRate).toBe(87.5);
    // Et **tous** les refus en 409 : un seul qui remonterait brut rendrait un
    // 500 à la cliente là où le tunnel affiche « ce créneau n'est plus
    // disponible » et la ramène à la grille.
    for (const error of relevé.errors) {
      expect(error).toBeInstanceOf(SlotNoLongerAvailableError);
    }

    expect(await overlappingPairs(harness!.prismaUnscoped, salon.tenantId)).toBe(0);
  }, 300_000);

  it('n’en laisse aboutir qu’une seule quand 32 candidates visent le même créneau', async () => {
    const slot = libres[libres.length - 1];

    expect(slot).toBeDefined();

    const candidates = 32;
    const relevé = await measure(
      'Contention maximale (32 candidates × 1 créneau)',
      Array.from({ length: candidates }, (_unused, essai) =>
        book(slot!.staffId, slot!.startsAt, `ruee-${essai}@example.test`),
      ),
    );
    relevés.push(relevé);

    expect(relevé.succeeded).toBe(1);
    expect(relevé.rejected).toBe(candidates - 1);
    // 31 / 32 = 96,875 %, arrondi à deux décimales par le relevé.
    expect(relevé.conflictRate).toBe(96.88);
    for (const error of relevé.errors) {
      expect(error).toBeInstanceOf(SlotNoLongerAvailableError);
    }

    // La preuve directe, sans passer par ce que les promesses ont bien voulu
    // dire : une seule ligne sur ce créneau, chez ce praticien.
    const posés = await harness!.prismaUnscoped.appointment.count({
      where: {
        tenantId: salon.tenantId,
        staffId: slot!.staffId,
        startsAt: new Date(slot!.startsAt),
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });
    expect(posés).toBe(1);

    expect(await overlappingPairs(harness!.prismaUnscoped, salon.tenantId)).toBe(0);
  }, 300_000);
});

/**
 * Mélange **déterministe** — les tentatives d'un même créneau ne doivent pas se
 * suivre, sans quoi la file bornée les jouerait presque en série et la contention
 * mesurée serait plus douce que la vraie.
 *
 * Un générateur congruentiel plutôt que `Math.random` : un scénario de charge
 * dont l'ordre change à chaque exécution ne se compare pas d'un relevé à
 * l'autre, et un échec ne se rejoue pas.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const mixed = [...items];
  let seed = 0x2f6e2b1;

  for (let index = mixed.length - 1; index > 0; index -= 1) {
    // `Math.imul` et non `*` : le produit d'un état 32 bits par 1 103 515 245
    // pèse jusqu'à 2⁶¹, très au-delà de `Number.MAX_SAFE_INTEGER`. Un `*` perd
    // alors dans l'arrondi flottant exactement les bits de poids faible qu'un
    // `%` allait lire, et le générateur cesse d'être celui qu'on croit écrire.
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    // Le tirage se prend dans les bits de poids **fort** : ceux d'un générateur
    // congruentiel de module 2³² sont les seuls dont la période soit pleine.
    const target = Math.floor((seed / 4_294_967_296) * (index + 1));
    [mixed[index], mixed[target]] = [mixed[target]!, mixed[index]!];
  }

  return mixed;
}
