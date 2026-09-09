import {
  CONCURRENCY,
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
  type Measure,
  type Salon,
} from './load.harness';

/**
 * **Tests de charge du moteur de disponibilité** — troisième critère de #83, sur
 * son premier volet (CDC §6, risque n°1 ; booking-engine §3).
 *
 * ## Ce que cette suite établit, et ce qu'elle ne prouve pas
 *
 * Elle établit que le calcul de créneaux — six lectures, une soustraction
 * d'intervalles et un découpage — **tient sous des requêtes concurrentes** :
 * aucune erreur, un résultat identique d'un appel à l'autre à agenda constant,
 * et des latences relevées plutôt qu'affirmées.
 *
 * Elle ne prouve rien du temps de réponse **servi** : ni le réseau, ni l'ALB, ni
 * la sérialisation HTTP, ni le cache Redis de `AvailabilityQueryService` n'entrent
 * dans la mesure. Ceux-là se mesurent sur un environnement déployé, et sont la
 * part de la recette qui reste à jouer sur staging.
 *
 * ## Les trois scénarios
 *
 * | Scénario | Ce qu'il charge | Ce qu'il doit établir |
 * |---|---|---|
 * | Semaine complète | 7 jours, 4 praticiens, agenda garni | le cas de la page publique — aucune erreur, résultat stable |
 * | Journée seule | 1 jour, 4 praticiens | le cas du calendrier de back-office, plus fréquent et plus étroit |
 * | Lecture sous écriture | lectures et réservations mêlées | qu'une lecture concurrente d'une écriture ne casse ni ne ment |
 *
 * ## Pourquoi les seuils sont larges
 *
 * Les assertions de latence sont des plafonds d'**ordre de grandeur**, pas des
 * objectifs de service. Le poste d'un développeur, un agent de jalon qui partage
 * sa machine avec deux autres et un exécuteur GitHub n'ont pas le même débit :
 * un seuil serré produirait des échecs sans rapport avec le code. Ce qui est
 * assertif ici, ce sont les **invariants** ; les chiffres, eux, sont imprimés.
 */
describe('Charge — moteur de disponibilité', () => {
  /** L'instant de référence : le salon vit en 2027, le préavis n'écarte rien. */
  const NOW = new Date('2027-02-01T08:00:00.000Z');
  const FIRST_DAY = '2027-03-01';
  const LAST_DAY = addDays(FIRST_DAY, 6);

  let harness: LoadHarness | undefined;
  let salon: Salon;
  const relevés: Measure[] = [];

  beforeAll(async () => {
    harness = await createLoadHarness();
    salon = await harness.seed({ firstDay: FIRST_DAY, days: 7, staffCount: 4, bookedPerStaff: 12 });
  }, 180_000);

  afterAll(async () => {
    if (relevés.length > 0) {
      renderMeasureTable('Charge — moteur de disponibilité', relevés);
    }

    await harness?.close();
  });

  /** Le calcul, tel que la page publique le demande — la semaine entière. */
  const week = async (): Promise<number> => {
    const view = await inTenant(salon.tenantId, () =>
      harness!.engine.slotsFor(
        { serviceId: salon.serviceId, from: FIRST_DAY, to: LAST_DAY },
        NOW,
      ),
    );

    return view.days.reduce((total, day) => total + day.slots.length, 0);
  };

  it('sert 200 calculs concurrents sur une semaine sans une seule erreur, et rend le même résultat', async () => {
    const reference = await week();

    // Un agenda garni, sans quoi la mesure porterait sur le cas qui n'arrive
    // jamais : 48 rendez-vous déjà posés, donc une vraie soustraction
    // d'occupations à chaque appel.
    expect(reference).toBeGreaterThan(0);

    const attempts = 200 * loadFactor();
    const counts: number[] = [];

    const relevé = await measure(
      'Semaine complète (7 j × 4 praticiens)',
      Array.from({ length: attempts }, () => async () => {
        counts.push(await week());
      }),
    );
    relevés.push(relevé);

    expect(relevé.rejected).toBe(0);
    expect(relevé.succeeded).toBe(attempts);
    // Le déterminisme est la propriété qui compte ici : à agenda constant, deux
    // cents calculs concurrents doivent rendre deux cents fois la même chose.
    // Une seule réponse divergente voudrait dire que le moteur lit un état
    // partiel — et la page publique proposerait un créneau qui n'existe pas.
    expect(new Set(counts)).toEqual(new Set([reference]));
    // Plafond d'ordre de grandeur : le calcul d'une semaine est de l'ordre de la
    // dizaine de millisecondes sur un poste ordinaire. Cinq secondes ne se
    // franchissent que sur une régression structurelle — une lecture par
    // praticien réintroduite dans `windowsForMany`, un index perdu.
    expect(relevé.p95Ms).toBeLessThan(5_000);
  }, 300_000);

  it('sert 400 calculs concurrents sur une journée seule, au débit du back-office', async () => {
    const day = async (): Promise<void> => {
      await inTenant(salon.tenantId, () =>
        harness!.engine.slotsFor(
          { serviceId: salon.serviceId, from: FIRST_DAY, to: FIRST_DAY },
          NOW,
        ),
      );
    };

    const attempts = 400 * loadFactor();
    const relevé = await measure(
      'Journée seule (1 j × 4 praticiens)',
      Array.from({ length: attempts }, () => day),
    );
    relevés.push(relevé);

    expect(relevé.rejected).toBe(0);
    expect(relevé.succeeded).toBe(attempts);
    expect(relevé.p95Ms).toBeLessThan(5_000);
  }, 300_000);

  it('ne casse ni ne ment quand des réservations s’écrivent pendant les lectures', async () => {
    const before = await week();

    // Des créneaux réellement libres, choisis dans ce que le moteur vient de
    // rendre : c'est la seule façon de les désigner sans réimplémenter le
    // découpage — et de garantir qu'aucun ne chevauche l'agenda déjà semé.
    const view = await inTenant(salon.tenantId, () =>
      harness!.engine.slotsFor({ serviceId: salon.serviceId, from: FIRST_DAY, to: LAST_DAY }, NOW),
    );
    const bookable = disjointPerStaff(view.days.flatMap((day) => day.slots)).slice(0, 24);

    expect(bookable.length).toBe(24);

    const reads = Array.from({ length: 200 * loadFactor() }, () => async () => {
      await week();
    });
    const writes = bookable.map((slot) => async () => {
      await inTenant(salon.tenantId, () =>
        harness!.appointments.create(
          bookingDraft(salon, slot.staffId, new Date(slot.startsAt)),
        ),
      );
    });

    const relevé = await measure('Lecture sous écriture', interleave(reads, writes), {
      concurrency: CONCURRENCY,
    });
    relevés.push(relevé);

    // Aucune erreur — ni de lecture, ni d'écriture : les créneaux visés étaient
    // libres et disjoints, rien ne devait être refusé. Un refus ici voudrait
    // dire que le moteur a proposé deux fois le même créneau.
    expect(relevé.errors).toEqual([]);

    const after = await week();
    // Les réservations ont bien retiré des créneaux — une lecture qui rendrait
    // encore le compte d'avant lirait un instantané périmé.
    expect(after).toBeLessThan(before);
    // Et le calcul est stable une fois les écritures terminées : deux lectures
    // consécutives rendent exactement la même chose.
    expect(await week()).toBe(after);
    // L'invariant, relu en base : aucune paire de rendez-vous actifs ne se
    // chevauche chez un même praticien.
    expect(await overlappingPairs(harness!.prismaUnscoped, salon.tenantId)).toBe(0);
  }, 300_000);
});

/**
 * Entrelace deux listes de tâches, la plus courte répartie dans la plus longue.
 *
 * Les écritures doivent tomber **pendant** les lectures, pas avant ni après :
 * les concaténer bout à bout mesurerait deux scénarios séquentiels, ce que les
 * deux cas précédents font déjà.
 */
function interleave<T>(long: readonly T[], short: readonly T[]): T[] {
  if (short.length === 0) {
    return [...long];
  }

  const every = Math.max(1, Math.floor(long.length / short.length));
  const mixed: T[] = [];
  let next = 0;

  long.forEach((task, index) => {
    mixed.push(task);

    if (index % every === every - 1 && next < short.length) {
      mixed.push(short[next]!);
      next += 1;
    }
  });

  return [...mixed, ...short.slice(next)];
}
