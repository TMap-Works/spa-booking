import {
  createCustomerRequestSchema,
  customerSchema,
  customerSearchQuerySchema,
  customerSummarySchema,
  customerVisitHistorySchema,
  customerVisitSummarySchema,
  CUSTOMER_HISTORY_MAX_VISITS,
  CUSTOMER_SEARCH_MIN_LENGTH,
  setCustomerStatusRequestSchema,
  updateCustomerRequestSchema,
} from '../schemas/crm';

/**
 * Ce que ces cas verrouillent, et pourquoi ils valent d'être écrits.
 *
 * Le contrat CRM porte deux invariants qui ne se voient pas à la lecture d'un
 * type, et qui coûtent cher s'ils cèdent :
 *
 * 1. **la note interne ne franchit jamais une surface de liste** — elle est le
 *    « distinctes des informations visibles du client » du critère, et une liste
 *    qui la porterait la diffuserait à chaque ligne d'écran ;
 * 2. **aucun schéma d'entrée n'accepte `tenantId`, `role` ni `isActive`** — les
 *    trois sont des décisions de l'établissement, et un `.strict()` qui
 *    s'effriterait les laisserait passer en silence.
 */

const VALID_SUMMARY = {
  id: '11111111-1111-4111-8111-111111111111',
  firstName: 'Alice',
  lastName: 'Durand',
  email: 'alice@example.test',
  phone: '+261 34 12 345 67',
  isActive: true,
};

describe('fiche cliente', () => {
  it('n’expose pas la note interne sur la forme réduite', () => {
    const parsed = customerSummarySchema.parse({
      ...VALID_SUMMARY,
      internalNote: 'allergique au monoï',
    });

    // Non `.strict()` comme tous les schémas de sortie : le champ est ignoré,
    // pas refusé. Ce qui compte est qu'il **ne ressorte pas**.
    expect(parsed).not.toHaveProperty('internalNote');
  });

  it('porte la note interne sur la fiche complète, `null` compris', () => {
    const parsed = customerSchema.parse({
      ...VALID_SUMMARY,
      internalNote: null,
      createdAt: '2026-09-01T08:00:00.000Z',
    });

    expect(parsed.internalNote).toBeNull();
  });

  it('canonise l’adresse et rend le téléphone nullable', () => {
    const parsed = customerSchema.parse({
      ...VALID_SUMMARY,
      email: '  Alice@Example.TEST ',
      phone: null,
      internalNote: null,
      createdAt: '2026-09-01T08:00:00.000Z',
    });

    expect({ email: parsed.email, phone: parsed.phone }).toEqual({
      email: 'alice@example.test',
      phone: null,
    });
  });
});

describe('création d’une fiche', () => {
  it('refuse un rôle, une activation ou un tenant glissés dans le corps', () => {
    for (const intrus of [{ role: 'admin' }, { isActive: false }, { tenantId: 'x' }]) {
      const result = createCustomerRequestSchema.safeParse({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        ...intrus,
      });

      expect({ intrus: Object.keys(intrus)[0], accepte: result.success }).toEqual({
        intrus: Object.keys(intrus)[0],
        accepte: false,
      });
    }
  });

  it('accepte une fiche sans téléphone ni note', () => {
    const parsed = createCustomerRequestSchema.parse({
      email: 'alice@example.test',
      firstName: '  Alice ',
      lastName: 'Durand',
    });

    expect(parsed).toEqual({
      email: 'alice@example.test',
      firstName: 'Alice',
      lastName: 'Durand',
    });
  });
});

describe('modification d’une fiche', () => {
  it('accepte `null` pour effacer le numéro et la note', () => {
    expect(updateCustomerRequestSchema.parse({ phone: null, internalNote: null })).toEqual({
      phone: null,
      internalNote: null,
    });
  });

  it('n’accepte ni l’adresse ni l’activation — chacune a sa procédure', () => {
    expect(updateCustomerRequestSchema.safeParse({ email: 'b@example.test' }).success).toBe(false);
    expect(updateCustomerRequestSchema.safeParse({ isActive: false }).success).toBe(false);
  });

  it('accepte un corps vide — une requête qui ne change rien reste licite', () => {
    expect(updateCustomerRequestSchema.parse({})).toEqual({});
  });
});

describe('activation', () => {
  it('exige le booléen plutôt que de basculer', () => {
    expect(setCustomerStatusRequestSchema.safeParse({}).success).toBe(false);
    expect(setCustomerStatusRequestSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
});

describe('recherche', () => {
  it('applique les valeurs par défaut de pagination et masque les fiches inactives', () => {
    expect(customerSearchQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      includeInactive: false,
    });
  });

  it('refuse un terme trop court plutôt que de balayer le fichier entier', () => {
    expect(customerSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(customerSearchQuerySchema.parse({ q: 'du' }).q).toBe('du');
    expect(CUSTOMER_SEARCH_MIN_LENGTH).toBe(2);
  });

  it('coerce les paramètres de query string, qui n’arrivent qu’en chaînes', () => {
    expect(customerSearchQuerySchema.parse({ page: '3', pageSize: '5' })).toEqual({
      page: 3,
      pageSize: 5,
      includeInactive: false,
    });
  });

  it.each([
    ['true', true],
    [true, true],
    ['false', false],
    [false, false],
    // Ni « oui », ni « 1 », ni rien d'autre : seule `true` ouvre la liste. Une
    // coercition à la `Boolean(value)` aurait rendu vrai pour chacune de ces
    // chaînes — `'false'` la première.
    ['oui', false],
    ['0', false],
  ])('lit `includeInactive` = %p comme %p, jamais l’inverse', (recu, attendu) => {
    expect(customerSearchQuerySchema.parse({ includeInactive: recu }).includeInactive).toBe(attendu);
  });
});

describe('historique agrégé', () => {
  const EMPTY = {
    totalVisits: 0,
    honoredVisits: 0,
    cancelledVisits: 0,
    noShowVisits: 0,
    upcomingVisits: 0,
    firstVisitAt: null,
    lastVisitAt: null,
    totalSpent: null,
  };

  it('admet une fiche sans aucune visite, sans inventer un total à zéro', () => {
    expect(customerVisitSummarySchema.parse(EMPTY).totalSpent).toBeNull();
  });

  it('borne la liste des visites sans borner l’agrégat', () => {
    const visite = {
      appointmentId: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
      startsAt: '2026-08-01T09:00:00.000Z',
      endsAt: '2026-08-01T10:00:00.000Z',
      serviceName: 'Massage 60 min',
      staffName: 'Alice',
      price: { amountMinor: 3500, currency: 'EUR' },
    };

    const tropDeVisites = {
      summary: { ...EMPTY, totalVisits: 400, honoredVisits: 400 },
      visits: Array.from({ length: CUSTOMER_HISTORY_MAX_VISITS + 1 }, () => visite),
    };

    expect(customerVisitHistorySchema.safeParse(tropDeVisites).success).toBe(false);

    const borne = {
      summary: { ...EMPTY, totalVisits: 400, honoredVisits: 400 },
      visits: Array.from({ length: CUSTOMER_HISTORY_MAX_VISITS }, () => visite),
    };

    // L'agrégat compte 400 visites là où la liste en montre 50 : c'est
    // exactement la propriété qu'un agrégat calculé sur la page perdrait.
    expect(customerVisitHistorySchema.parse(borne).summary.totalVisits).toBe(400);
  });

  it('accepte une visite dont le praticien a quitté l’établissement', () => {
    const sansPraticien = {
      summary: { ...EMPTY, totalVisits: 1, honoredVisits: 1 },
      visits: [
        {
          appointmentId: '22222222-2222-4222-8222-222222222222',
          status: 'completed',
          startsAt: '2026-08-01T09:00:00.000Z',
          endsAt: '2026-08-01T10:00:00.000Z',
          serviceName: 'Massage 60 min',
          staffName: null,
          price: { amountMinor: 3500, currency: 'EUR' },
        },
      ],
    };

    expect(customerVisitHistorySchema.parse(sansPraticien).visits[0]?.staffName).toBeNull();
  });
});
