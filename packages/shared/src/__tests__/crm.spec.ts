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

/**
 * La fiche complète telle que l'API l'émet, adresse vivante — le socle des cas
 * qui n'éprouvent qu'un champ à la fois.
 *
 * Les deux champs de suppression y sont à `null` et **présents** : c'est ce que
 * rend `GET /customers/:id` pour la quasi-totalité du fichier, et les omettre
 * ici aurait fait passer pour valide une réponse que le contrat refuse (#525).
 */
const VALID_RECORD = {
  ...VALID_SUMMARY,
  internalNote: 'allergique au monoï',
  createdAt: '2026-09-01T08:00:00.000Z',
  anonymizedAt: null,
  emailSuppressedAt: null,
  emailSuppressionReason: null,
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
    const parsed = customerSchema.parse({ ...VALID_RECORD, internalNote: null });

    expect(parsed.internalNote).toBeNull();
  });

  it('canonise l’adresse et rend le téléphone nullable', () => {
    const parsed = customerSchema.parse({
      ...VALID_RECORD,
      email: '  Alice@Example.TEST ',
      phone: null,
      internalNote: null,
    });

    expect({ email: parsed.email, phone: parsed.phone }).toEqual({
      email: 'alice@example.test',
      phone: null,
    });
  });
});

/**
 * L'état de suppression d'adresse sur la fiche — #525, quatrième critère de #73.
 *
 * Trois propriétés valent d'être verrouillées ici, et aucune ne se lit sur un
 * type :
 *
 * 1. **la fiche complète les porte, le résumé non** — une liste de deux cents
 *    lignes n'affiche aucun avis de délivrabilité, et ce qui n'est pas lu n'a
 *    pas à transiter (même partage qu'`internalNote`) ;
 * 2. **le motif est ramené en minuscules** — l'API émet la valeur de
 *    l'énumération PostgreSQL, le contrat nomme les mêmes valeurs comme il nomme
 *    les rôles et les statuts. Une casse qui remonterait jusqu'à l'écran ferait
 *    deux vocabulaires pour une seule notion ;
 * 3. **les deux champs sont obligatoires et nullables** — l'API les émet
 *    toujours, à `null` sur une adresse vivante. Les rendre facultatifs
 *    laisserait un front distinguer « absent » de « vide », c'est-à-dire
 *    afficher `undefined` un jour.
 */
describe('l’adresse supprimée d’une fiche', () => {
  it('n’apparaît pas sur la forme réduite, qui alimente les listes', () => {
    const parsed = customerSummarySchema.parse({
      ...VALID_SUMMARY,
      emailSuppressedAt: '2026-09-05T10:00:00.000Z',
      emailSuppressionReason: 'HARD_BOUNCE',
    });

    expect(parsed).not.toHaveProperty('emailSuppressedAt');
    expect(parsed).not.toHaveProperty('emailSuppressionReason');
  });

  it('ramène le motif émis par l’API au vocabulaire du contrat', () => {
    for (const [emis, attendu] of [
      ['HARD_BOUNCE', 'hard_bounce'],
      ['COMPLAINT', 'complaint'],
    ] as const) {
      const parsed = customerSchema.parse({
        ...VALID_RECORD,
        emailSuppressedAt: '2026-09-05T10:00:00.000Z',
        emailSuppressionReason: emis,
      });

      expect(parsed.emailSuppressionReason).toBe(attendu);
    }
  });

  it('refuse un motif que l’ingestion n’écrit jamais', () => {
    // Un rebond transitoire ne supprime rien : il n'a pas de valeur dans
    // l'énumération, et une chaîne libre qui s'y glisserait ferait afficher au
    // comptoir un motif que le back n'a pas écrit.
    for (const intrus of ['transient', 'SOFT_BOUNCE', '']) {
      const result = customerSchema.safeParse({
        ...VALID_RECORD,
        emailSuppressedAt: '2026-09-05T10:00:00.000Z',
        emailSuppressionReason: intrus,
      });

      expect({ intrus, accepte: result.success }).toEqual({ intrus, accepte: false });
    }
  });

  it('exige les deux champs, `null` compris — jamais absents', () => {
    // « Adresse vivante » est un fait que l'API énonce, pas un champ qu'elle
    // oublie : une réponse muette serait indiscernable d'une réponse tronquée.
    for (const manquant of ['emailSuppressedAt', 'emailSuppressionReason'] as const) {
      const { [manquant]: _omis, ...incomplete } = VALID_RECORD;

      expect({ manquant, accepte: customerSchema.safeParse(incomplete).success }).toEqual({
        manquant,
        accepte: false,
      });
    }

    expect(customerSchema.parse(VALID_RECORD).emailSuppressedAt).toBeNull();
  });
});

/**
 * L'anonymisation, telle que la fiche complète la porte — #529.
 *
 * Le champ existait dans la réponse de l'API depuis #81 (`CustomerDto`), mais
 * pas dans ce contrat : Zod le retirait à la frontière, et le back-office n'avait
 * donc aucun moyen de distinguer une fiche effacée d'une fiche vivante. C'est ce
 * qui laissait l'avis d'adresse supprimée s'afficher sur une adresse en
 * `.invalid`, en conseillant de joindre par téléphone une personne dont le numéro
 * venait d'être vidé.
 */
describe('l’anonymisation d’une fiche', () => {
  it('voyage sur la fiche complète, jamais sur le résumé qui alimente les listes', () => {
    const parsed = customerSchema.parse({
      ...VALID_RECORD,
      anonymizedAt: '2026-09-08T09:00:00.000Z',
    });

    expect(parsed.anonymizedAt).toBe('2026-09-08T09:00:00.000Z');
    expect(
      customerSummarySchema.parse({ ...VALID_SUMMARY, anonymizedAt: '2026-09-08T09:00:00.000Z' }),
    ).not.toHaveProperty('anonymizedAt');
  });

  it('est obligatoire et nullable — « fiche vivante » est un fait, pas un champ oublié', () => {
    const { anonymizedAt: _omis, ...incomplete } = VALID_RECORD;

    expect(customerSchema.safeParse(incomplete).success).toBe(false);
    expect(customerSchema.parse(VALID_RECORD).anonymizedAt).toBeNull();
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

  /**
   * La casse du fil, verrouillée ici et pas seulement du côté du rendez-vous
   * (#610).
   *
   * L'API sert `COMPLETED` — la casse de l'énumération PostgreSQL —, et le
   * client HTTP du back-office valide chaque réponse avant de la rendre. Tant
   * que ce champ portait `z.enum(APPOINTMENT_STATUSES)`, une fiche de quatre
   * visites faisait échouer la lecture quatre fois, et la page tombait en
   * entier. Le cas passant ci-dessous est donc la réponse **réelle** de la
   * route, pas une version aimablement minusculisée.
   */
  const visiteDuFil = (status: string) => ({
    summary: { ...EMPTY, totalVisits: 1, honoredVisits: 1 },
    visits: [
      {
        appointmentId: '22222222-2222-4222-8222-222222222222',
        status,
        startsAt: '2026-08-01T09:00:00.000Z',
        endsAt: '2026-08-01T10:00:00.000Z',
        serviceName: 'Massage 60 min',
        staffName: 'Alice',
        price: { amountMinor: 3500, currency: 'EUR' },
      },
    ],
  });

  it.each(['COMPLETED', 'CANCELLED', 'NO_SHOW', 'PENDING', 'CONFIRMED'])(
    'accepte le statut `%s` tel que l’API l’émet et le rend en minuscules',
    (status) => {
      expect(customerVisitHistorySchema.parse(visiteDuFil(status)).visits[0]?.status).toBe(
        status.toLowerCase(),
      );
    },
  );

  it('refuse toujours un statut hors du vocabulaire, quelle qu’en soit la casse', () => {
    // La normalisation ramène la casse, elle n'élargit pas l'énumération : un
    // statut inventé reste une réponse invalide, et c'est ce qui distingue ce
    // schéma d'un `z.string()` complaisant.
    expect(customerVisitHistorySchema.safeParse(visiteDuFil('ARCHIVED')).success).toBe(false);
  });
});
