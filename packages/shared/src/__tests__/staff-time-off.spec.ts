import {
  MAX_TIME_OFF_RANGE_DAYS,
  createStaffTimeOffRequestSchema,
  staffBusyIntervalSchema,
  staffTimeOffQuerySchema,
  staffTimeOffSchema,
  updateStaffTimeOffRequestSchema,
} from '../index';

/**
 * Contrat des plages bloquées et congés (#33).
 *
 * Deux propriétés se vérifient ici, et elles ne se recouvrent pas :
 *
 * 1. **les bornes entrent avec un offset explicite et sortent en UTC.** Une
 *    date-heure nue n'a de sens que rapportée à un fuseau, et le contrat refuse
 *    de le deviner ;
 * 2. **le motif ne franchit pas la frontière du back-office.** La forme que
 *    consomme le calcul de créneaux ne le déclare pas, et `strict()` la fait
 *    refuser un objet qui le porterait.
 */

const CONGE = {
  staffId: '3f1c4d5e-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  startsAt: '2026-08-03T00:00:00+02:00',
  endsAt: '2026-08-06T00:00:00+02:00',
};

describe('createStaffTimeOffRequestSchema', () => {
  it('normalise en UTC des bornes à offset explicite', () => {
    const parsed = createStaffTimeOffRequestSchema.parse(CONGE);

    expect(parsed.startsAt).toBe('2026-08-02T22:00:00.000Z');
    expect(parsed.endsAt).toBe('2026-08-05T22:00:00.000Z');
  });

  it('refuse une date-heure nue — le serveur ne devine aucun fuseau', () => {
    const refused = createStaffTimeOffRequestSchema.safeParse({
      ...CONGE,
      startsAt: '2026-08-03T00:00:00',
    });

    expect(refused.success).toBe(false);
  });

  it('accepte une absence sans motif', () => {
    expect(createStaffTimeOffRequestSchema.parse(CONGE).reason).toBeUndefined();
  });

  it('refuse un intervalle vide', () => {
    const refused = createStaffTimeOffRequestSchema.safeParse({
      ...CONGE,
      endsAt: CONGE.startsAt,
    });

    expect(refused.success).toBe(false);
  });

  it('refuse un intervalle inversé', () => {
    const refused = createStaffTimeOffRequestSchema.safeParse({
      ...CONGE,
      startsAt: CONGE.endsAt,
      endsAt: CONGE.startsAt,
    });

    expect(refused.success).toBe(false);
  });

  it(`refuse une absence de plus de ${String(MAX_TIME_OFF_RANGE_DAYS)} jours`, () => {
    const refused = createStaffTimeOffRequestSchema.safeParse({
      ...CONGE,
      endsAt: '2226-08-06T00:00:00+02:00',
    });

    expect(refused.success).toBe(false);
  });

  it('refuse un `tenantId` glissé dans le corps', () => {
    // `strict()` est le pendant contractuel de `forbidNonWhitelisted` : le
    // tenant vient du jeton vérifié, jamais d'une charge utile.
    const refused = createStaffTimeOffRequestSchema.safeParse({
      ...CONGE,
      tenantId: '00000000-0000-4000-8000-000000000000',
    });

    expect(refused.success).toBe(false);
  });
});

describe('updateStaffTimeOffRequestSchema', () => {
  it('accepte un patch qui ne déplace qu’une borne', () => {
    // L'autre borne se lit en base : la règle complète est jugée côté serveur,
    // le contrat ne peut vérifier que ce qu'il voit.
    expect(updateStaffTimeOffRequestSchema.parse({ endsAt: CONGE.endsAt }).endsAt).toBe(
      '2026-08-05T22:00:00.000Z',
    );
  });

  it('refuse deux bornes incohérentes fournies ensemble', () => {
    const refused = updateStaffTimeOffRequestSchema.safeParse({
      startsAt: CONGE.endsAt,
      endsAt: CONGE.startsAt,
    });

    expect(refused.success).toBe(false);
  });

  it('accepte `null` sur le motif — il vaut « efface »', () => {
    expect(updateStaffTimeOffRequestSchema.parse({ reason: null }).reason).toBeNull();
  });

  it('refuse de changer de praticien — ce n’est pas une modification', () => {
    const refused = updateStaffTimeOffRequestSchema.safeParse({ staffId: CONGE.staffId });

    expect(refused.success).toBe(false);
  });
});

describe('staffTimeOffQuerySchema', () => {
  it('exige une fenêtre bornée', () => {
    expect(staffTimeOffQuerySchema.safeParse({ from: CONGE.startsAt }).success).toBe(false);
  });

  it('refuse une fenêtre de plus d’un an', () => {
    const refused = staffTimeOffQuerySchema.safeParse({
      from: '2026-01-01T00:00:00Z',
      to: '2126-01-01T00:00:00Z',
    });

    expect(refused.success).toBe(false);
  });

  it('accepte une fenêtre sans praticien — le planning de l’établissement', () => {
    const parsed = staffTimeOffQuerySchema.parse({
      from: '2026-08-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
    });

    expect(parsed.staffId).toBeUndefined();
  });
});

describe('staffTimeOffSchema', () => {
  it('rend le motif nullable, jamais absent', () => {
    const parsed = staffTimeOffSchema.parse({
      id: CONGE.staffId,
      staffId: CONGE.staffId,
      startsAt: '2026-08-02T22:00:00.000Z',
      endsAt: '2026-08-05T22:00:00.000Z',
      reason: null,
    });

    expect(parsed.reason).toBeNull();
  });

  it('refuse une sortie décalée — un seul référentiel en réponse', () => {
    const refused = staffTimeOffSchema.safeParse({
      id: CONGE.staffId,
      staffId: CONGE.staffId,
      startsAt: '2026-08-03T00:00:00+02:00',
      endsAt: '2026-08-05T22:00:00.000Z',
      reason: null,
    });

    expect(refused.success).toBe(false);
  });
});

describe('staffBusyIntervalSchema', () => {
  it('n’accepte pas de motif — il ne quitte pas le back-office', () => {
    const refused = staffBusyIntervalSchema.safeParse({
      staffId: CONGE.staffId,
      startsAt: '2026-08-02T22:00:00.000Z',
      endsAt: '2026-08-05T22:00:00.000Z',
      reason: 'Arrêt maladie',
    });

    expect(refused.success).toBe(false);
  });

  it('décrit un intervalle et son praticien, et rien d’autre', () => {
    const parsed = staffBusyIntervalSchema.parse({
      staffId: CONGE.staffId,
      startsAt: '2026-08-02T22:00:00.000Z',
      endsAt: '2026-08-05T22:00:00.000Z',
    });

    expect(Object.keys(parsed).sort()).toEqual(['endsAt', 'staffId', 'startsAt']);
  });
});
