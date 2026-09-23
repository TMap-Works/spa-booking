/**
 * Schémas d'entités et de DTO.
 *
 * Ce qui est testé en priorité n'est pas ce que les schémas acceptent, mais ce
 * qu'ils **refusent** : un `tenantId` en entrée, un `role` choisi à
 * l'inscription, un `passwordHash` en sortie, une donnée de carte dans un
 * paiement. Ce sont les quatre fuites que le contrat est censé rendre
 * impossibles, et un `.strict()` retiré par mégarde les rouvrirait toutes sans
 * casser une seule ligne applicative.
 */

import { MAX_AVAILABILITY_RANGE_DAYS, PASSWORD_MIN_LENGTH } from '../constants/limits';
import {
  appointmentListQuerySchema,
  appointmentSchema,
  createAppointmentRequestSchema,
  MY_APPOINTMENTS_MAX_LIMIT,
  myAppointmentsQuerySchema,
  rescheduleAppointmentRequestSchema,
} from '../schemas/appointment';
import { availabilityQuerySchema } from '../schemas/availability';
import {
  assignServiceStaffRequestSchema,
  createServiceRequestSchema,
  publicServiceSchema,
  serviceCategorySchema,
  serviceSchema,
  serviceStaffMemberSchema,
  updateServiceCategoryRequestSchema,
  updateServiceRequestSchema,
} from '../schemas/catalog';
import {
  authSessionResponseSchema,
  registerRequestSchema,
  sessionUserSchema,
  staffAccountStateSchema,
  tenantScopedLoginRequestSchema,
  updateProfileRequestSchema,
  userSchema,
} from '../schemas/identity';
import { notificationSchema } from '../schemas/notification';
import {
  paymentSchema,
  recordCounterPaymentRequestSchema,
  refundPaymentRequestSchema,
  saleSettlementSchema,
  settleSaleRequestSchema,
} from '../schemas/payment';
import { receiptSettlementSchema } from '../schemas/receipt';
import {
  openingHoursOverlap,
  openingHoursSchema,
  postalAddressSchema,
  publicTenantSchema,
  sortOpeningHours,
  tenantSchema,
  updateTenantRequestSchema,
} from '../schemas/tenant';

const UUID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const OTHER_UUID = '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d';

describe('identity', () => {
  it('refuse un tenantId ou un role à l’inscription', () => {
    const base = {
      email: 'alice@example.test',
      password: 'correct horse battery',
      firstName: 'Alice',
      lastName: 'Martin',
      dataConsent: true,
    };

    expect(registerRequestSchema.safeParse(base).success).toBe(true);
    expect(registerRequestSchema.safeParse({ ...base, tenantId: UUID }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, role: 'admin' }).success).toBe(false);
    // Le même `.strict()` refuse la **date** du consentement : elle est posée
    // par le serveur, jamais reçue de l'appelant (#880, RGPD art. 7.1).
    expect(
      registerRequestSchema.safeParse({ ...base, dataConsentAt: '2026-09-17T10:00:00Z' }).success,
    ).toBe(false);
  });

  it('refuse une inscription sans consentement, ou avec un consentement refusé', () => {
    const base = {
      email: 'alice@example.test',
      password: 'correct horse battery',
      firstName: 'Alice',
      lastName: 'Martin',
    };

    // Absent : la case n'a pas été posée, et l'API n'a pas à deviner laquelle
    // des deux choses cela veut dire.
    expect(registerRequestSchema.safeParse(base).success).toBe(false);

    const refus = registerRequestSchema.safeParse({ ...base, dataConsent: false });
    expect(refus.success).toBe(false);
    // Le message est celui de l'écran d'inscription, pas celui du tunnel : il
    // se lit sur la case, par la cliente.
    expect(refus.error?.issues[0]?.message).toBe(
      'le traitement des données doit être accepté pour créer un compte',
    );
  });

  it('canonise l’e-mail — c’est ce qui rend l’unicité (tenant, email) fiable', () => {
    const parsed = registerRequestSchema.parse({
      email: '  Alice@Example.TEST ',
      password: 'correct horse battery',
      firstName: 'Alice',
      lastName: 'Martin',
      dataConsent: true,
    });

    expect(parsed.email).toBe('alice@example.test');
  });

  it('ne rogne pas le mot de passe et impose le plancher de longueur', () => {
    const withSpaces = {
      email: 'alice@example.test',
      password: ' correct horse battery ',
      firstName: 'Alice',
      lastName: 'Martin',
      dataConsent: true,
    };

    expect(registerRequestSchema.parse(withSpaces).password).toBe(' correct horse battery ');
    expect(
      registerRequestSchema.safeParse({ ...withSpaces, password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) })
        .success,
    ).toBe(false);
  });

  it('ne laisse sortir ni passwordHash ni tenantId sur un compte', () => {
    const parsed = userSchema.parse({
      id: UUID,
      email: 'alice@example.test',
      role: 'client',
      firstName: 'Alice',
      lastName: 'Martin',
      isActive: true,
      createdAt: '2026-03-03T10:00:00Z',
      passwordHash: '$argon2id$v=19$…',
      tenantId: OTHER_UUID,
    });

    expect(parsed).not.toHaveProperty('passwordHash');
    expect(parsed).not.toHaveProperty('tenantId');
  });
});

describe('tenant', () => {
  it('expose le fuseau de l’établissement sur la vitrine publique', () => {
    const parsed = publicTenantSchema.parse({
      id: UUID,
      slug: 'salon-lumiere',
      name: 'Salon Lumière',
      timezone: 'Europe/Paris',
      defaultCurrency: 'eur',
      defaultLocale: 'en',
    });

    expect(parsed.timezone).toBe('Europe/Paris');
    expect(parsed.defaultCurrency).toBe('EUR');
    // Toujours présente depuis #844 : la colonne est `NOT NULL` avec un défaut.
    expect(parsed.defaultLocale).toBe('en');
  });

  it('refuse un slug qui n’est pas un label DNS valide', () => {
    const base = {
      id: UUID,
      name: 'Salon Lumière',
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
      defaultLocale: 'en',
    };

    expect(publicTenantSchema.safeParse({ ...base, slug: '-salon' }).success).toBe(false);
    expect(publicTenantSchema.safeParse({ ...base, slug: 'salon-' }).success).toBe(false);
    expect(publicTenantSchema.safeParse({ ...base, slug: 'salon lumiere' }).success).toBe(false);
  });

  it('refuse un champ hors contrat dans la mise à jour', () => {
    expect(updateTenantRequestSchema.safeParse({ name: 'Nouveau nom' }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ isActive: false }).success).toBe(false);
  });

  // --- Adresse et horaires d'ouverture — #343 -------------------------------

  const VITRINE = {
    id: UUID,
    slug: 'salon-lumiere',
    name: 'Salon Lumière',
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
    defaultLocale: 'en',
  };

  it('sert une vitrine sans adresse ni horaires', () => {
    // Le critère de #343 : les deux sont facultatifs, et un salon fraîchement
    // inscrit n'a rien saisi. Sa vitrine doit rester valide — sans quoi la page
    // publique rendrait une erreur de contrat pour un salon parfaitement normal.
    const parsed = publicTenantSchema.parse(VITRINE);

    expect(parsed.address).toBeUndefined();
    expect(parsed.openingHours).toBeUndefined();
  });

  it('normalise le code pays en majuscules et refuse ce qui n’est pas un code', () => {
    const parsed = postalAddressSchema.parse({
      line1: '12 rue des Lilas',
      city: 'Paris',
      country: 'fr',
    });

    expect(parsed.country).toBe('FR');
    expect(parsed.postalCode).toBeUndefined();
    expect(postalAddressSchema.safeParse({ line1: 'a', city: 'b', country: 'France' }).success).toBe(
      false,
    );
  });

  it('exige le triplet minimal de l’adresse', () => {
    // Une adresse sans ville n'oriente personne et produirait un `PostalAddress`
    // incomplet : elle se publie en entier, ou pas du tout.
    expect(postalAddressSchema.safeParse({ line1: '12 rue des Lilas', country: 'FR' }).success).toBe(
      false,
    );
    expect(postalAddressSchema.safeParse({ city: 'Paris', country: 'FR' }).success).toBe(false);
    expect(postalAddressSchema.safeParse({ line1: '12 rue', city: 'Paris' }).success).toBe(false);
  });

  it('accepte une fermeture à minuit et refuse une plage inversée', () => {
    // `24:00` est la seule façon exacte de dire « ferme à minuit » : la borne
    // haute est exclue, et `23:59` perdrait une minute.
    expect(
      openingHoursSchema.safeParse([{ weekday: 6, opensAt: '18:00', closesAt: '24:00' }]).success,
    ).toBe(true);
    expect(
      openingHoursSchema.safeParse([{ weekday: 2, opensAt: '19:00', closesAt: '09:00' }]).success,
    ).toBe(false);
  });

  it('refuse deux plages du même jour qui se recouvrent, mais accepte l’adjacence', () => {
    const recouvrement = [
      { weekday: 2, opensAt: '09:00', closesAt: '13:00' },
      { weekday: 2, opensAt: '12:00', closesAt: '19:00' },
    ];
    const adjacentes = [
      { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 2, opensAt: '12:00', closesAt: '19:00' },
    ];

    expect(openingHoursSchema.safeParse(recouvrement).success).toBe(false);
    expect(openingHoursSchema.safeParse(adjacentes).success).toBe(true);
    // Les mêmes heures sur deux jours différents ne se recouvrent pas.
    expect(
      openingHoursOverlap([
        { weekday: 2, opensAt: '09:00', closesAt: '19:00' },
        { weekday: 3, opensAt: '09:00', closesAt: '19:00' },
      ]),
    ).toBe(false);
  });

  it('refuse le 0-dimanche de `Date.getDay`', () => {
    // `0` est *falsy* : un jour de semaine qui vaut zéro disparaît au premier
    // `weekday ?? défaut`. La numérotation est celle d'ISO 8601, 1 à 7.
    expect(
      openingHoursSchema.safeParse([{ weekday: 0, opensAt: '09:00', closesAt: '19:00' }]).success,
    ).toBe(false);
    expect(
      openingHoursSchema.safeParse([{ weekday: 7, opensAt: '09:00', closesAt: '19:00' }]).success,
    ).toBe(true);
  });

  it('trie la semaine par jour puis par heure d’ouverture, sans muter l’entrée', () => {
    // `as const` fige les jours en littéraux : depuis #554 `IsoWeekday` est
    // l'union `1 | … | 7`, et un `number` élargi ne s'y assigne plus.
    const desordre = [
      { weekday: 3, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
      { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
    ] as const;
    const trie = sortOpeningHours(desordre);

    expect(trie.map((entry) => `${String(entry.weekday)}-${entry.opensAt}`)).toEqual([
      '2-09:00',
      '2-14:00',
      '3-09:00',
    ]);
    // Une réponse d'API ne se réordonne pas sous les pieds de son appelant.
    expect(desordre[0]?.weekday).toBe(3);
  });

  it('efface l’adresse par `null` et la semaine par un tableau vide', () => {
    expect(updateTenantRequestSchema.safeParse({ address: null }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ openingHours: [] }).success).toBe(true);
    // Absent ≠ `null` : un formulaire partiel ne doit pas effacer ce qu'il
    // n'affiche pas. Les deux formes sont donc distinctes dans le type.
    expect(Object.keys(updateTenantRequestSchema.parse({ name: 'Salon' }))).toEqual(['name']);
  });

  // --- Identité légale et taux de taxe — #913 -------------------------------

  /** Le SIRET du jeu d'essai — clé de Luhn juste. */
  const SIRET = '73282932000074';

  it('porte l’identité légale sur la vue back-office, et **pas** sur la vitrine', () => {
    // La propriété qui compte : `publicTenantSchema` est servi sans
    // authentification à qui connaît le slug du salon. Un SIRET, un numéro de
    // TVA et un taux de taxe s'impriment sur une pièce comptable remise à la
    // cliente qui a payé — ils ne se publient pas.
    const clefsPubliques = Object.keys(publicTenantSchema.shape);

    for (const champ of ['legalName', 'legalIdType', 'legalId', 'vatNumber', 'taxRateBps']) {
      expect(clefsPubliques).not.toContain(champ);
      expect(Object.keys(tenantSchema.shape)).toContain(champ);
    }
  });

  it('rend le préfixe et le taux **toujours**, l’identité légale seulement si saisie', () => {
    const base = {
      id: UUID,
      slug: 'salon-lumiere',
      name: 'Salon Lumière',
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
      // Même régime, et même raison, que les deux champs ci-dessous (#844).
      defaultLocale: 'en',
      isActive: true,
    };

    // Leurs colonnes sont `NOT NULL` avec un défaut : il n'existe pas
    // d'établissement qui n'en ait pas, et les omettre obligerait chaque écran à
    // réinventer le défaut de son côté.
    expect(tenantSchema.safeParse(base).success).toBe(false);
    expect(tenantSchema.safeParse({ ...base, receiptPrefix: 'SPL', taxRateBps: 2000 }).success).toBe(
      true,
    );
  });

  it('juge l’identifiant d’entreprise selon sa nature', () => {
    expect(
      updateTenantRequestSchema.safeParse({ legalIdType: 'SIRET', legalId: SIRET }).success,
    ).toBe(true);
    // Un SIRET dont la clé de Luhn est fausse n'est rapprochable par aucune
    // comptabilité, et l'erreur ne se découvrirait qu'au contrôle.
    expect(
      updateTenantRequestSchema.safeParse({ legalIdType: 'SIRET', legalId: '73282932000075' })
        .success,
    ).toBe(false);
    // Un NIF malgache ne se vérifie pas : le prétendre refuserait des
    // établissements réels sur une règle inventée.
    expect(
      updateTenantRequestSchema.safeParse({ legalIdType: 'NIF', legalId: '3000123456' }).success,
    ).toBe(true);
  });

  it('refuse une moitié de paire posée ou effacée seule, quand les deux sont dans la charge utile', () => {
    expect(
      updateTenantRequestSchema.safeParse({ legalIdType: 'SIRET', legalId: null }).success,
    ).toBe(false);
    expect(updateTenantRequestSchema.safeParse({ legalIdType: null, legalId: SIRET }).success).toBe(
      false,
    );
    expect(updateTenantRequestSchema.safeParse({ legalIdType: null, legalId: null }).success).toBe(
      true,
    );
    // Une moitié **seule** reste licite : l'autre est en base, et ce schéma ne
    // la connaît pas. C'est l'API qui compose la paire résultante.
    expect(updateTenantRequestSchema.safeParse({ legalId: SIRET }).success).toBe(true);
  });

  it('vérifie la clé du numéro de TVA français, et borne les autres en forme', () => {
    expect(updateTenantRequestSchema.safeParse({ vatNumber: 'FR40303265045' }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ vatNumber: 'FR41303265045' }).success).toBe(false);
    expect(updateTenantRequestSchema.safeParse({ vatNumber: 'BE0403170701' }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ vatNumber: '40303265045' }).success).toBe(false);
  });

  it('normalise le préfixe de ticket et refuse ce que la base refuse', () => {
    expect(updateTenantRequestSchema.parse({ receiptPrefix: ' spl ' })).toEqual({
      receiptPrefix: 'SPL',
    });
    for (const receiptPrefix of ['A', 'TROPLONGPREFIXE', 'TI-C', 'TI C']) {
      expect(updateTenantRequestSchema.safeParse({ receiptPrefix }).success).toBe(false);
    }
    // `null` n'est pas accepté : la colonne est `NOT NULL`, et un préfixe nul
    // aurait fait de `null-2026-000123` un numéro.
    expect(updateTenantRequestSchema.safeParse({ receiptPrefix: null }).success).toBe(false);
  });

  it('borne le taux de taxe à des points de base entiers', () => {
    expect(updateTenantRequestSchema.safeParse({ taxRateBps: 0 }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ taxRateBps: 10_000 }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ taxRateBps: 10_001 }).success).toBe(false);
    expect(updateTenantRequestSchema.safeParse({ taxRateBps: -1 }).success).toBe(false);
    // Jamais de flottant sur le chemin de l'argent (CLAUDE.md).
    expect(updateTenantRequestSchema.safeParse({ taxRateBps: 19.6 }).success).toBe(false);
  });
});

describe('catalog', () => {
  const service = {
    id: UUID,
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 15,
    occupiedMinutes: 85,
    price: { amountMinor: 7500, currency: 'EUR' },
    isActive: true,
    assignedStaffCount: 2,
    activeAssignedStaffCount: 2,
  };

  it('porte le prix comme un couple montant/devise indissociable', () => {
    expect(serviceSchema.parse(service).price).toEqual({ amountMinor: 7500, currency: 'EUR' });
  });

  it('porte les deux tampons et la durée réellement occupée', () => {
    // Le créneau bloqué sur l'agenda vaut avant + durée + après. Le serveur le
    // calcule : la règle réécrite côté client finirait par diverger.
    const parsed = serviceSchema.parse(service);

    expect(parsed.bufferBeforeMinutes + parsed.durationMinutes + parsed.bufferAfterMinutes).toBe(
      parsed.occupiedMinutes,
    );
  });

  it('refuse un tampon négatif — il rendrait la cabine avant la fin du soin', () => {
    expect(serviceSchema.safeParse({ ...service, bufferAfterMinutes: -5 }).success).toBe(false);
    // Zéro reste permis, contrairement à une durée de soin : un soin sans temps
    // de préparation est le cas courant.
    expect(
      serviceSchema.safeParse({
        ...service,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        occupiedMinutes: 60,
      }).success,
    ).toBe(true);
  });

  /**
   * Le compte de praticiens que la liste du back-office affiche (#885).
   *
   * Il est **obligatoire** : le rendre facultatif aurait laissé l'écran hésiter
   * entre « personne ne la pratique » et « on ne sait pas », deux états qui ne se
   * traitent pas de la même façon. Zéro est la seule façon de dire le premier, et
   * c'est précisément la valeur qui déclenche le badge.
   */
  it('porte un compte de praticiens entier et jamais négatif', () => {
    expect(serviceSchema.parse({ ...service, assignedStaffCount: 0 }).assignedStaffCount).toBe(0);
    expect(serviceSchema.safeParse({ ...service, assignedStaffCount: -1 }).success).toBe(false);
    expect(serviceSchema.safeParse({ ...service, assignedStaffCount: 1.5 }).success).toBe(false);
    // Absent n'est pas zéro : une réponse qui l'omettrait serait un contrat rompu,
    // pas une prestation sans praticien.
    expect(serviceSchema.safeParse({ ...service, assignedStaffCount: undefined }).success).toBe(
      false,
    );
  });

  /**
   * Le second compte, celui des praticiens **actifs** (#895).
   *
   * Obligatoire pour la même raison que son aîné, et distinct de lui pour une
   * raison que le seul type ne dit pas : c'est le seul des deux qui réponde à
   * « peut-on en réserver un créneau ». Une prestation dont l'unique praticien
   * affecté a été désactivé vaut `1` et `0` — l'état exact où la liste du
   * back-office et l'aperçu public se contredisaient.
   */
  it('porte un second compte, celui des praticiens actifs', () => {
    const desactive = { ...service, assignedStaffCount: 1, activeAssignedStaffCount: 0 };

    expect(serviceSchema.parse(desactive).activeAssignedStaffCount).toBe(0);
    expect(serviceSchema.parse(desactive).assignedStaffCount).toBe(1);
    expect(
      serviceSchema.safeParse({ ...service, activeAssignedStaffCount: -1 }).success,
    ).toBe(false);
    expect(
      serviceSchema.safeParse({ ...service, activeAssignedStaffCount: 1.5 }).success,
    ).toBe(false);
    // Absent n'est pas zéro, ici non plus.
    expect(
      serviceSchema.safeParse({ ...service, activeAssignedStaffCount: undefined }).success,
    ).toBe(false);
  });

  /**
   * Le catalogue public, lui, n'en porte aucun — et c'est délibéré : il expose
   * `staff`, les praticiens **actifs** qu'on peut réserver, dont il donne les noms
   * plutôt qu'un cardinal. Publier `assignedStaffCount` laisserait en plus une page
   * publique annoncer un effectif que personne ne peut réserver.
   */
  it('ne publie aucun de ces comptes sur le catalogue public', () => {
    expect(Object.keys(publicServiceSchema.shape)).not.toContain('assignedStaffCount');
    expect(Object.keys(publicServiceSchema.shape)).not.toContain('activeAssignedStaffCount');
  });

  it('rattache la prestation à une rubrique par identifiant, jamais par son nom', () => {
    const base = { name: 'Massage suédois', durationMinutes: 60, price: { amountMinor: 7500, currency: 'EUR' } };

    expect(createServiceRequestSchema.safeParse({ ...base, categoryId: OTHER_UUID }).success).toBe(
      true,
    );
    // La chaîne libre d'avant #24 : elle ne désigne plus rien.
    expect(createServiceRequestSchema.safeParse({ ...base, category: 'Massages' }).success).toBe(
      false,
    );
  });

  it('refuse un prix négatif et un prix plat sans devise', () => {
    const base = {
      name: 'Massage suédois',
      durationMinutes: 60,
    };

    expect(
      createServiceRequestSchema.safeParse({
        ...base,
        price: { amountMinor: -1, currency: 'EUR' },
      }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({ ...base, priceAmountMinor: 7500 }).success,
    ).toBe(false);
  });

  it('n’efface une rubrique ou une description que par un `null` explicite', () => {
    // L'absence du champ et son effacement sont deux gestes distincts : un
    // formulaire vidé doit pouvoir dire le second.
    expect(updateServiceRequestSchema.safeParse({}).success).toBe(true);
    expect(
      updateServiceRequestSchema.safeParse({ categoryId: null, description: null }).success,
    ).toBe(true);
    // Un prix ou une durée, en revanche, ne s'efface pas : il se remplace.
    expect(updateServiceRequestSchema.safeParse({ price: null }).success).toBe(false);
    expect(updateServiceRequestSchema.safeParse({ durationMinutes: null }).success).toBe(false);
  });

  it('sort une rubrique du catalogue par `isActive`, jamais par suppression', () => {
    const category = {
      id: UUID,
      slug: 'soins-du-visage',
      name: 'Soins du visage',
      description: null,
      isActive: true,
    };

    expect(serviceCategorySchema.safeParse(category).success).toBe(true);
    expect(updateServiceCategoryRequestSchema.safeParse({ isActive: false }).success).toBe(true);
    // Le slug d'une rubrique est une URL publique : même exigence que celui d'un
    // établissement, ni tiret en tête ni tiret en fin.
    expect(serviceCategorySchema.safeParse({ ...category, slug: '-soins' }).success).toBe(false);
    // Un champ hors contrat est refusé — pas d'`isDeleted` qui s'inviterait.
    expect(
      updateServiceCategoryRequestSchema.safeParse({ isDeleted: true }).success,
    ).toBe(false);
  });

  it('n’accepte que le praticien dans une demande d’affectation', () => {
    expect(assignServiceStaffRequestSchema.safeParse({ staffId: UUID }).success).toBe(true);
    // Le `.strict()` est ce qui ferme la porte la plus directe : un `tenantId`
    // glissé dans le corps ferait choisir son établissement au client.
    expect(
      assignServiceStaffRequestSchema.safeParse({ staffId: UUID, tenantId: OTHER_UUID }).success,
    ).toBe(false);
    // Ni la prestation : elle vient du chemin, et l'accepter ici ouvrirait deux
    // sources pour la même désignation.
    expect(
      assignServiceStaffRequestSchema.safeParse({ staffId: UUID, serviceId: OTHER_UUID }).success,
    ).toBe(false);
    expect(assignServiceStaffRequestSchema.safeParse({ staffId: 'camille' }).success).toBe(false);
  });

  it('montre au back-office le praticien désactivé, et rien de son compte', () => {
    const member = { id: UUID, displayName: 'Camille Rousseau', isActive: false };

    expect(serviceStaffMemberSchema.safeParse(member).success).toBe(true);

    // Un schéma de **sortie** n'est pas `.strict()` — il décrit ce que l'API
    // rend, et refuser une réponse enrichie casserait le client au premier champ
    // ajouté par le serveur. Sa garantie est ailleurs, et elle est plus forte :
    // il **élague**. Ce que l'assertion vérifie n'est donc pas un refus mais une
    // absence — `userId` révélerait le compte derrière la fiche, `bio` ferait
    // transiter deux mille caractères par ligne dans une liste d'affectations,
    // et ni l'un ni l'autre ne survit à la validation.
    const parsed = serviceStaffMemberSchema.parse({
      ...member,
      userId: OTHER_UUID,
      bio: 'Dix ans de pratique.',
    });

    expect(parsed).toEqual(member);
  });

  it('publie les praticiens d’une prestation sans publier la cadence du salon', () => {
    const published = {
      id: UUID,
      slug: 'massage-60-min',
      name: 'Massage 60 min',
      description: null,
      category: { id: OTHER_UUID, slug: 'massages', name: 'Massages' },
      durationMinutes: 60,
      price: { amountMinor: 7000, currency: 'EUR' },
      staff: [{ id: OTHER_UUID, displayName: 'Camille Rousseau' }],
    };

    expect(publicServiceSchema.safeParse(published).success).toBe(true);
    // Une prestation que personne ne pratique encore reste publiable — elle se
    // réserve simplement sans choix de praticien.
    expect(publicServiceSchema.safeParse({ ...published, staff: [] }).success).toBe(true);

    // Les tampons sont des temps de cabine — de l'exploitation, pas du catalogue —
    // et `occupiedMinutes` les redonnerait par soustraction ; `isActive` vaudrait
    // toujours `true`. Les quatre sont **élagués** : quand bien même le serveur
    // les mettrait dans le corps, ils ne franchiraient pas la validation du
    // client, et un écran ne pourrait pas se mettre à les afficher.
    const parsed = publicServiceSchema.parse({
      ...published,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
      occupiedMinutes: 85,
      isActive: true,
      tenantId: OTHER_UUID,
      staff: [{ id: OTHER_UUID, displayName: 'Camille Rousseau', isActive: true }],
    });

    expect(parsed).toEqual(published);
  });
});

describe('appointments', () => {
  it('ne laisse pas le client poser la fin du rendez-vous', () => {
    const base = {
      serviceId: UUID,
      staffId: OTHER_UUID,
      startsAt: '2026-03-03T10:00:00Z',
    };

    expect(createAppointmentRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createAppointmentRequestSchema.safeParse({ ...base, endsAt: '2026-03-03T12:00:00Z' }).success,
    ).toBe(false);
  });

  it('accepte une réservation sans praticien — l’option « premier disponible »', () => {
    // Son absence n'est pas une donnée manquante : c'est le choix « pas de
    // préférence » du CDC §1.4 (#36), et le serveur affecte le praticien.
    expect(
      createAppointmentRequestSchema.safeParse({
        serviceId: UUID,
        startsAt: '2026-03-03T10:00:00Z',
      }).success,
    ).toBe(true);
    // Facultatif ne veut pas dire permissif : une valeur présente reste jugée.
    expect(
      createAppointmentRequestSchema.safeParse({
        serviceId: UUID,
        staffId: 'pas-un-uuid',
        startsAt: '2026-03-03T10:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('refuse un prix imposé par le client à la réservation', () => {
    expect(
      createAppointmentRequestSchema.safeParse({
        serviceId: UUID,
        staffId: OTHER_UUID,
        startsAt: '2026-03-03T10:00:00Z',
        price: { amountMinor: 0, currency: 'EUR' },
      }).success,
    ).toBe(false);
  });

  /**
   * L'adoption d'`offsetDateTimeSchema` en entrée (#297).
   *
   * Ce qui se vérifie ici n'est pas qu'une regex accepte une chaîne de plus :
   * c'est qu'un instant exprimé dans le fuseau du salon désigne **le même point
   * sur la ligne du temps** que le `Z` correspondant, et que la normalisation a
   * lieu au passage du schéma — pas trois couches plus bas.
   */
  it('accepte un début exprimé avec l’offset du salon et le normalise en UTC', () => {
    const parsed = createAppointmentRequestSchema.parse({
      serviceId: UUID,
      staffId: OTHER_UUID,
      // 11:30 à Paris le 3 mars, heure d'hiver : +01:00.
      startsAt: '2026-03-03T11:30:00+01:00',
    });

    expect(parsed.startsAt).toBe('2026-03-03T10:30:00.000Z');
    // Le report ouvre exactement la même frontière : les créneaux qu'un
    // calendrier propose pour déplacer un rendez-vous sont ceux-là mêmes qu'il
    // propose pour en prendre un.
    expect(
      rescheduleAppointmentRequestSchema.parse({ startsAt: '2026-03-03T11:30:00+01:00' }).startsAt,
    ).toBe('2026-03-03T10:30:00.000Z');
  });

  it('lit au bon instant les deux nuits de changement d’heure', () => {
    // Passage à l'heure d'été : l'horloge de Paris saute de 02:00 à 03:00, si
    // bien que 03:30+02:00 est le tout premier instant de la nouvelle heure —
    // 01:30Z. Une conversion faite avec l'offset d'hiver le placerait à 02:30Z,
    // une heure trop tard : la cliente arriverait après son rendez-vous.
    expect(
      createAppointmentRequestSchema.parse({
        serviceId: UUID,
        startsAt: '2026-03-29T03:30:00+02:00',
      }).startsAt,
    ).toBe('2026-03-29T01:30:00.000Z');

    // Passage à l'heure d'hiver : 02:30 sonne deux fois à Paris. C'est l'offset
    // porté par la chaîne — et lui seul — qui dit laquelle des deux, ce qu'aucun
    // fuseau ne saurait trancher à sa place. D'où l'exigence de l'offset
    // explicite plutôt qu'une date-heure nue rapportée à `tenants.timezone`.
    expect(
      createAppointmentRequestSchema.parse({
        serviceId: UUID,
        startsAt: '2026-10-25T02:30:00+02:00',
      }).startsAt,
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(
      createAppointmentRequestSchema.parse({
        serviceId: UUID,
        startsAt: '2026-10-25T02:30:00+01:00',
      }).startsAt,
    ).toBe('2026-10-25T01:30:00.000Z');
  });

  it('refuse toujours une date-heure nue, à la réservation comme au report', () => {
    // Élargir l'entrée n'était pas la relâcher : c'est l'instant **nu** qui
    // reste proscrit, parce que son fuseau ne peut être que deviné.
    //
    // La liste reprend **mot pour mot** celle qu'exerce le pendant côté API,
    // `appointments/__tests__/date-time.validation.spec.ts` : c'est ce qui rend
    // le double écriture de cette frontière vérifiable. Une liste plus courte
    // d'un côté laisserait la copie d'en face bouger seule sans qu'aucune des
    // deux suites ne rougisse — en particulier sur le 31 février, que le motif
    // seul accepte et que `Date.parse` ramènerait au 3 mars sans un mot.
    for (const startsAt of [
      '2026-03-29T03:30:00',
      '2026-03-29',
      '2026-03-29T24:00:00Z',
      '2026-02-31T10:00:00Z',
      '1774743000',
      '2026-03-29T03:30:00+0200',
      '',
    ]) {
      expect(createAppointmentRequestSchema.safeParse({ serviceId: UUID, startsAt }).success).toBe(
        false,
      );
      expect(rescheduleAppointmentRequestSchema.safeParse({ startsAt }).success).toBe(false);
    }
  });

  it('n’émet en sortie que des instants UTC, jamais un offset de salon', () => {
    // L'autre moitié de l'asymétrie : un agenda de back-office trie ses lignes
    // par simple ordre lexicographique, ce qui n'a de sens que dans un
    // référentiel unique.
    const instantFields = ['startsAt', 'endsAt', 'cancelledAt', 'createdAt'] as const;

    for (const field of instantFields) {
      expect(appointmentSchema.shape[field].safeParse('2026-03-29T03:30:00+02:00').success).toBe(
        false,
      );
      expect(appointmentSchema.shape[field].safeParse('2026-03-29T01:30:00Z').success).toBe(true);
    }
  });

  it('filtre l’agenda sur des dates civiles et une liste de statuts non vide', () => {
    expect(
      appointmentListQuerySchema.safeParse({
        from: '2026-03-03',
        to: '2026-03-09',
        statuses: ['pending', 'confirmed'],
      }).success,
    ).toBe(true);
    expect(appointmentListQuerySchema.safeParse({ statuses: [] }).success).toBe(false);
    expect(appointmentListQuerySchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
  });

  it('borne la plage de l’agenda à MAX_APPOINTMENT_RANGE_DAYS, bornes comprises', () => {
    // 1er mars + 30 jours = 31 mars : exactement trente et une journées (#444).
    expect(
      appointmentListQuerySchema.safeParse({ from: '2026-03-01', to: '2026-03-31' }).success,
    ).toBe(true);
    expect(
      appointmentListQuerySchema.safeParse({ from: '2026-03-01', to: '2026-04-01' }).success,
    ).toBe(false);
  });

  it('refuse une plage d’agenda inversée', () => {
    expect(
      appointmentListQuerySchema.safeParse({ from: '2026-03-09', to: '2026-03-03' }).success,
    ).toBe(false);
  });

  it('laisse passer une borne d’agenda seule — c’est le serveur qui complète', () => {
    // « Aujourd'hui » n'a de sens que dans le fuseau de l'établissement, que le
    // contrat ne connaît pas : la garde ne porte donc que sur le couple
    // effectivement fourni.
    expect(appointmentListQuerySchema.safeParse({ from: '2026-03-03' }).success).toBe(true);
    expect(appointmentListQuerySchema.safeParse({ to: '2026-03-03' }).success).toBe(true);
    expect(appointmentListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('lit la ligne d’agenda quelle que soit la casse du statut émis', () => {
    // L'API émet `PENDING`, la casse de l'énumération PostgreSQL ; le contrat
    // nomme le même statut `pending` (#444). La normalisation se fait ici, une
    // fois, exactement comme pour `bookedAppointmentSchema` — sans quoi tout un
    // agenda cesserait de se lire sur la casse d'une chaîne.
    const parsed = appointmentSchema.shape.status.safeParse('PENDING');

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe('pending');
    // Le vocabulaire du contrat reste accepté tel quel : les deux formes
    // convergent sur la même valeur.
    expect(appointmentSchema.shape.status.safeParse('pending').success).toBe(true);
    // Ce qui n'est pas un statut reste refusé, casse ou pas.
    expect(appointmentSchema.shape.status.safeParse('ARCHIVED').success).toBe(false);
  });

  /**
   * L'auteur de l'annulation au contrat de l'agenda — #917.
   *
   * Il y est entré pour ce que son **absence** signifie : un report annule la
   * ligne d'origine sans y inscrire personne, et c'est la seule marque qui
   * sépare, dans l'agenda du salon, un créneau perdu d'un créneau déplacé.
   */
  it('lit l’auteur d’une annulation, l’omet quand il n’y en a pas, et refuse un `null`', () => {
    const champ = appointmentSchema.shape.cancelledBy;

    // Même normalisation de casse que le statut : l'API émet `CLIENT`.
    expect(champ.safeParse('CLIENT').success && champ.parse('CLIENT')).toBe('client');
    expect(champ.safeParse('staff').success).toBe(true);
    // Absent, jamais `null` : la ligne d'agenda **omet** ses champs facultatifs,
    // là où la sortie publique les pose à `null` (`bookedAppointmentSchema`).
    expect(champ.safeParse(undefined).success).toBe(true);
    expect(champ.safeParse(null).success).toBe(false);
    // Et ce n'est pas un rôle : un `MANAGER` qui annule est du côté du salon.
    expect(champ.safeParse('MANAGER').success).toBe(false);
  });
});

describe('availability', () => {
  const base = { serviceId: UUID, from: '2026-03-01', to: '2026-03-07' };

  it('accepte une fenêtre raisonnable', () => {
    expect(availabilityQuerySchema.safeParse(base).success).toBe(true);
  });

  it('refuse une plage inversée', () => {
    expect(
      availabilityQuerySchema.safeParse({ ...base, from: '2026-03-07', to: '2026-03-01' }).success,
    ).toBe(false);
  });

  it('borne la fenêtre à MAX_AVAILABILITY_RANGE_DAYS', () => {
    // 1er mars + 30 jours = 31 mars : exactement 31 journées, bornes comprises.
    expect(
      availabilityQuerySchema.safeParse({ ...base, from: '2026-03-01', to: '2026-03-31' }).success,
    ).toBe(true);
    expect(
      availabilityQuerySchema.safeParse({ ...base, from: '2026-03-01', to: '2026-04-01' }).success,
    ).toBe(false);
    expect(MAX_AVAILABILITY_RANGE_DAYS).toBe(31);
  });

  describe('excludeAppointmentId (#442)', () => {
    it('est facultatif — la réservation ne le renseigne jamais', () => {
      // Le seul appelant qui l'envoie est l'écran de report. Le rendre
      // obligatoire aurait fait porter au tunnel un champ qui n'a de sens que
      // lorsqu'un rendez-vous existe déjà.
      expect(availabilityQuerySchema.safeParse(base).success).toBe(true);
    });

    it('accepte un identifiant de rendez-vous', () => {
      expect(
        availabilityQuerySchema.safeParse({ ...base, excludeAppointmentId: UUID }).success,
      ).toBe(true);
    });

    it('refuse ce qui n’est pas un identifiant', () => {
      // Un champ libre ici descendrait jusqu'au `where` d'une lecture d'agenda.
      // Le refus est de forme, et il a lieu au contrat.
      expect(
        availabilityQuerySchema.safeParse({ ...base, excludeAppointmentId: 'le-mien' }).success,
      ).toBe(false);
      expect(
        availabilityQuerySchema.safeParse({ ...base, excludeAppointmentId: '' }).success,
      ).toBe(false);
    });
  });
});

describe('payments', () => {
  it('refuse toute donnée de carte dans un encaissement au comptoir', () => {
    const base = {
      amount: { amountMinor: 7500, currency: 'EUR' },
      method: 'card' as const,
    };

    expect(recordCounterPaymentRequestSchema.safeParse(base).success).toBe(true);
    expect(
      recordCounterPaymentRequestSchema.safeParse({ ...base, cardNumber: '4242424242424242' })
        .success,
    ).toBe(false);
    expect(recordCounterPaymentRequestSchema.safeParse({ ...base, cvc: '123' }).success).toBe(false);
  });

  it('refuse un encaissement de zéro ou négatif', () => {
    expect(
      recordCounterPaymentRequestSchema.safeParse({
        amount: { amountMinor: 0, currency: 'EUR' },
        method: 'cash',
      }).success,
    ).toBe(false);
    expect(
      recordCounterPaymentRequestSchema.safeParse({
        amount: { amountMinor: -100, currency: 'EUR' },
        method: 'cash',
      }).success,
    ).toBe(false);
  });

  it('accepte un remboursement sans montant — « tout le restant »', () => {
    expect(refundPaymentRequestSchema.safeParse({}).success).toBe(true);
    expect(
      refundPaymentRequestSchema.safeParse({ amount: { amountMinor: 1000, currency: 'EUR' } })
        .success,
    ).toBe(true);
  });
});

/**
 * Le règlement d'un ticket au comptoir — #1026, suivi de #834.
 *
 * ## Pourquoi une réponse recopiée et non fabriquée
 *
 * Parce que le défaut que ces tests ferment n'était pas une faute de logique mais
 * un **désaccord avec ce que la route sert** : `saleSettlementSchema` était
 * `.strict()` sans `replayed`, si bien qu'un `.parse()` de la réponse réelle
 * levait `unrecognized_keys`, et `settleSaleRequestSchema` ne savait construire
 * qu'une requête carte que l'API refuse en 400. Aucun schéma fabriqué à partir du
 * schéma lui-même ne peut constater cela : il passerait par construction.
 *
 * La fixture ci-dessous est donc la réponse **relevée en recette** sur la PR
 * #1023 — le solde d'un ticket de 78,01 € réglé 50,00 € en espèces puis
 * 28,01 € au TPE avec référence, puis la même clé d'idempotence rejouée. Les
 * identifiants sont remplacés par des UUID de test ; les **clés**, leur casse et
 * leurs formes sont celles du fil, et c'est tout ce que ce test regarde.
 */
describe('règlement d’un ticket au comptoir', () => {
  /**
   * `POST /v1/sales/{saleId}/payments` — 201, tel que `toSaleSettlementDto` le
   * compose. `method` et `status` y sont dans la casse de l'énumération
   * PostgreSQL, `cardChannel` porte le tuyau, et les deux références de
   * prestataire sont nulles : aucun appel n'a eu lieu pour en produire une.
   */
  const SERVED_SETTLEMENT = {
    payment: {
      id: UUID,
      appointmentId: null,
      saleId: OTHER_UUID,
      amount: { amountMinor: 2801, currency: 'EUR' },
      refunded: { amountMinor: 0, currency: 'EUR' },
      method: 'CARD',
      cardChannel: 'TERMINAL',
      terminalReference: 'A0000123',
      status: 'SUCCEEDED',
      providerPaymentIntentId: null,
      providerChargeId: null,
      capturedAt: '2026-09-16T14:32:07.000Z',
      createdAt: '2026-09-16T14:32:07.000Z',
    },
    saleId: OTHER_UUID,
    total: { amountMinor: 7801, currency: 'EUR' },
    settled: { amountMinor: 7801, currency: 'EUR' },
    remaining: { amountMinor: 0, currency: 'EUR' },
    change: { amountMinor: 0, currency: 'EUR' },
    settledAt: '2026-09-16T14:32:07.000Z',
    replayed: false,
  };

  it('lit la réponse réellement servie par POST /v1/sales/{saleId}/payments', () => {
    const parsed = saleSettlementSchema.parse(SERVED_SETTLEMENT);

    expect(parsed.replayed).toBe(false);
    expect(parsed.payment.cardChannel).toBe('TERMINAL');
    expect(parsed.payment.terminalReference).toBe('A0000123');
    // Le moyen et le statut sont ramenés au vocabulaire du contrat, en
    // minuscules : c'est la normalisation de réception, et elle a lieu ici et
    // pas dans chaque écran.
    expect(parsed.payment.method).toBe('card');
    expect(parsed.payment.status).toBe('succeeded');
    // Les deux références de prestataire ne sont pas déclarées : un objet Zod non
    // strict les **retire**, et le comptoir ne les verra donc jamais.
    expect(parsed.payment).not.toHaveProperty('providerChargeId');
  });

  it('lit la réponse d’une clé d’idempotence rejouée', () => {
    const replayed = saleSettlementSchema.parse({
      ...SERVED_SETTLEMENT,
      change: { amountMinor: 1000, currency: 'EUR' },
      replayed: true,
    });

    expect(replayed.replayed).toBe(true);
    // La monnaie rendue est celle de la première soumission — elle n'a pas été
    // encaissée deux fois, elle est relue.
    expect(replayed.change.amountMinor).toBe(1000);
  });

  it('ne rejette pas la réponse entière pour un champ qu’elle ne connaît pas', () => {
    // La régression même de #1026, prise à l'envers : un champ ajouté à la
    // réponse est retiré, jamais un motif de refus. C'est ce qui permet à l'API
    // d'ajouter un fait sans fermer l'écran de caisse.
    const parsed = saleSettlementSchema.parse({ ...SERVED_SETTLEMENT, tipShare: 'à venir' });

    expect(parsed).not.toHaveProperty('tipShare');
  });

  it('accepte le moyen du fil et refuse celui de la base', () => {
    expect(settleSaleRequestSchema.safeParse({ method: 'CASH' }).success).toBe(true);
    expect(
      settleSaleRequestSchema.safeParse({ method: 'CARD_TERMINAL', terminalReference: 'A0000123' })
        .success,
    ).toBe(true);
    // `CARD` est le vocabulaire de la colonne, pas celui de la route : l'API le
    // refuse en 400 depuis #834, et le contrat ne doit donc pas savoir le
    // construire.
    expect(settleSaleRequestSchema.safeParse({ method: 'CARD' }).success).toBe(false);
    // Le comptoir n'ouvre plus d'intention Stripe (ADR 0015) — il n'y a pas de
    // valeur à refuser, il n'y en a pas à taper.
    expect(settleSaleRequestSchema.safeParse({ method: 'CARD_ONLINE' }).success).toBe(false);
  });

  it('borne la référence du terminal comme l’API la borne', () => {
    const settle = (terminalReference: string): boolean =>
      settleSaleRequestSchema.safeParse({ method: 'CARD_TERMINAL', terminalReference }).success;

    expect(settle('A0000123')).toBe(true);
    expect(settle('a'.repeat(32))).toBe(true);
    expect(settle('a'.repeat(33))).toBe(false);
    // Une référence vide doit être **absente** : présente et vide, « pas saisie »
    // et « saisie vide » deviendraient deux états d'une même colonne.
    expect(settle('')).toBe(false);
    // Les séparateurs sont précisément ce qui rend un numéro de carte
    // méconnaissable au contrôle de Luhn de l'API.
    expect(settle('4242 4242 4242 4242')).toBe(false);
    expect(settle('A0000123-2')).toBe(false);
  });

  it('refuse toute donnée de carte dans un règlement de ticket', () => {
    const base = { method: 'CARD_TERMINAL' as const, terminalReference: 'A0000123' };

    expect(
      settleSaleRequestSchema.safeParse({ ...base, cardNumber: '4242424242424242' }).success,
    ).toBe(false);
    expect(settleSaleRequestSchema.safeParse({ ...base, cvc: '123' }).success).toBe(false);
    // Ni le ticket ni l'établissement ne se désignent dans le corps : l'un est
    // dans l'URL, l'autre dans le jeton (tenant-isolation §2).
    expect(settleSaleRequestSchema.safeParse({ ...base, saleId: UUID }).success).toBe(false);
    expect(settleSaleRequestSchema.safeParse({ ...base, tenantId: UUID }).success).toBe(false);
  });

  it('lit un encaissement de TPE dans le journal des transactions', () => {
    // `GET /v1/payments` sert les deux champs depuis #834 ; `paymentSchema` les
    // ignorait, et le rapprochement du terminal était donc illisible par le
    // contrat.
    const parsed = paymentSchema.parse(SERVED_SETTLEMENT.payment);

    expect(parsed.cardChannel).toBe('TERMINAL');
    expect(parsed.terminalReference).toBe('A0000123');

    // Un règlement en espèces sert `null` aux deux, et non l'absence.
    const cash = paymentSchema.parse({
      ...SERVED_SETTLEMENT.payment,
      method: 'CASH',
      cardChannel: null,
      terminalReference: null,
    });

    expect(cash.cardChannel).toBeNull();
    expect(cash.terminalReference).toBeNull();
  });

  it('lit une référence hors format plutôt que de refuser la réponse entière', () => {
    // La borne de forme est celle de l'**aller** : elle empêche une référence
    // douteuse d'entrer. L'appliquer au retour ferait tomber le journal des
    // transactions au complet sur une valeur déjà en base — une reprise de
    // données, un import, ou la chaîne blanche que `receipt-pdf.format.ts` sait
    // déjà absorber. Un champ douteux s'affiche ; une liste qui ne se lit plus,
    // non.
    expect(
      paymentSchema.parse({ ...SERVED_SETTLEMENT.payment, terminalReference: '   ' })
        .terminalReference,
    ).toBe('   ');
    expect(
      settleSaleRequestSchema.safeParse({ method: 'CARD_TERMINAL', terminalReference: '   ' })
        .success,
    ).toBe(false);
  });

  it('lit la ligne de règlement du reçu, référence du TPE comprise', () => {
    // `GET /v1/sales/{id}/receipt` **omet** la clé quand la colonne est nulle,
    // au lieu d'émettre `null` : les deux formes sont celles de la route.
    const terminal = receiptSettlementSchema.parse({
      method: 'CARD',
      cardChannel: 'TERMINAL',
      amount: { amountMinor: 2801, currency: 'EUR' },
      terminalReference: 'A0000123',
      capturedAt: '2026-09-16T14:32:07.000Z',
    });

    expect(terminal.terminalReference).toBe('A0000123');

    const cash = receiptSettlementSchema.parse({
      method: 'CASH',
      cardChannel: null,
      amount: { amountMinor: 5000, currency: 'EUR' },
      tendered: { amountMinor: 6000, currency: 'EUR' },
      change: { amountMinor: 1000, currency: 'EUR' },
      capturedAt: '2026-09-16T14:28:44.000Z',
    });

    expect(cash.terminalReference).toBeUndefined();
  });

  /**
   * **#1027, premier point.** Le libellé de la pièce se décide sur le canal, et
   * le canal doit donc traverser le contrat : une carte en ligne et un passage
   * au terminal ne se distinguaient que par une `terminalReference` facultative,
   * si bien qu'un règlement Stripe s'imprimait comme un passage au TPE.
   */
  it('porte le canal de la carte, sans lequel les deux cartes se confondent', () => {
    const online = receiptSettlementSchema.parse({
      method: 'CARD',
      cardChannel: 'STRIPE',
      amount: { amountMinor: 4500, currency: 'EUR' },
      capturedAt: '2026-09-16T14:32:07.000Z',
    });

    expect(online.cardChannel).toBe('STRIPE');
    expect(online.terminalReference).toBeUndefined();

    // Une carte antérieure à #834 n'a pas de canal en base : elle ne peut être
    // qu'une intention Stripe, et le contrat la laisse se lire telle quelle
    // plutôt que de refuser la pièce entière.
    expect(
      receiptSettlementSchema.parse({
        method: 'CARD',
        cardChannel: null,
        amount: { amountMinor: 4500, currency: 'EUR' },
        capturedAt: null,
      }).cardChannel,
    ).toBeNull();

    // Le canal est un fait de la colonne, pas un champ libre.
    expect(
      receiptSettlementSchema.safeParse({
        method: 'CARD',
        cardChannel: 'TPE',
        amount: { amountMinor: 4500, currency: 'EUR' },
        capturedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe('notifications', () => {
  it('ne porte aucune coordonnée de destination', () => {
    const parsed = notificationSchema.parse({
      id: UUID,
      type: 'reminder_24h',
      channel: 'sms',
      status: 'pending',
      attemptCount: 0,
      createdAt: '2026-03-03T10:00:00Z',
      recipientPhone: '+33600000000',
      recipientEmail: 'alice@example.test',
    });

    expect(parsed).not.toHaveProperty('recipientPhone');
    expect(parsed).not.toHaveProperty('recipientEmail');
  });

  it('refuse un canal hors périmètre MVP', () => {
    expect(
      notificationSchema.safeParse({
        id: UUID,
        type: 'reminder_24h',
        channel: 'push',
        status: 'pending',
        attemptCount: 0,
        createdAt: '2026-03-03T10:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('espace client — #47', () => {
  it('la réponse de session ne porte jamais le jeton de rafraîchissement', () => {
    // Il part en cookie `httpOnly` : l'annoncer dans ce schéma inviterait un
    // client à le ranger quelque part, et ce quelque part est `localStorage`.
    const parsed = authSessionResponseSchema.parse({
      accessToken: 'jeton-opaque',
      expiresIn: 900,
      user: {
        id: UUID,
        email: 'alice@example.test',
        role: 'client',
        firstName: 'Alice',
        lastName: 'Martin',
        phone: null,
        locale: null,
      },
      refreshToken: 'ne-doit-pas-ressortir',
    });

    expect(parsed).not.toHaveProperty('refreshToken');
  });

  it('le compte de session ne porte ni empreinte, ni établissement, ni activation', () => {
    const parsed = sessionUserSchema.parse({
      id: UUID,
      email: 'alice@example.test',
      role: 'client',
      firstName: 'Alice',
      lastName: 'Martin',
      phone: '+261 34 12 345 67',
      locale: null,
      passwordHash: 'argon2id$…',
      tenantId: OTHER_UUID,
      isActive: false,
    });

    expect(parsed).not.toHaveProperty('passwordHash');
    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('isActive');
  });

  it('le compte du personnel porte son état d’activation, et l’exige', () => {
    // #695 : sans ce champ, la liste du back-office affichait « Désactiver » sur
    // un compte déjà fermé. L'exiger plutôt que de le rendre facultatif est ce
    // qui interdit de le retirer côté API sans que la frontière le dise.
    const parsed = staffAccountStateSchema.parse({
      id: UUID,
      email: 'lea@salon-des-lilas.test',
      role: 'STAFF',
      firstName: 'Léa',
      lastName: 'Rakoto',
      phone: null,
      locale: null,
      isActive: false,
    });

    expect(parsed).toMatchObject({ role: 'staff', isActive: false });
    expect(
      staffAccountStateSchema.safeParse({
        id: UUID,
        email: 'lea@salon-des-lilas.test',
        role: 'staff',
        firstName: 'Léa',
        lastName: 'Rakoto',
        phone: null,
        locale: null,
      }).success,
    ).toBe(false);
  });

  it('ramène au vocabulaire du contrat le rôle que l’API émet en majuscules', () => {
    // L'API rend `CLIENT` — la casse de l'énumération PostgreSQL — là où le
    // contrat nomme `client`. Sans cette normalisation, **toute** réponse de
    // session échouerait à la frontière et l'espace client serait inaccessible.
    const parsed = sessionUserSchema.parse({
      id: UUID,
      email: 'alice@example.test',
      role: 'CLIENT',
      firstName: 'Alice',
      lastName: 'Martin',
      phone: null,
      locale: null,
    });

    expect(parsed.role).toBe('client');
    expect(
      sessionUserSchema.safeParse({
        id: UUID,
        email: 'alice@example.test',
        role: 'SUPERADMIN',
        firstName: 'Alice',
        lastName: 'Martin',
        phone: null,
        locale: null,
      }).success,
    ).toBe(false);
  });

  it('le téléphone du compte de session est `null` et non absent quand il manque', () => {
    // L'API émet toujours le champ, à `null` quand il n'est pas renseigné : un
    // front qui aurait à distinguer « absent » de « vide » finirait par afficher
    // `undefined`.
    expect(
      sessionUserSchema.safeParse({
        id: UUID,
        email: 'alice@example.test',
        role: 'client',
        firstName: 'Alice',
        lastName: 'Martin',
      }).success,
    ).toBe(false);
  });

  it('la connexion exige le slug de l’établissement, et refuse un tenantId', () => {
    const base = { tenantSlug: 'salon-des-lilas', email: 'alice@example.test', password: 'x' };

    expect(tenantScopedLoginRequestSchema.safeParse(base).success).toBe(true);
    // Le slug **désigne** un établissement ; l'identifiant interne, lui, reste
    // hors de portée d'une entrée (tenant-isolation §2).
    expect(tenantScopedLoginRequestSchema.safeParse({ ...base, tenantId: UUID }).success).toBe(
      false,
    );
    expect(
      tenantScopedLoginRequestSchema.safeParse({ email: base.email, password: base.password })
        .success,
    ).toBe(false);
  });

  it('la modification de profil refuse `email` et `role`, et accepte un téléphone effacé', () => {
    expect(updateProfileRequestSchema.safeParse({ phone: null }).success).toBe(true);
    expect(updateProfileRequestSchema.safeParse({ firstName: 'Camille' }).success).toBe(true);
    expect(updateProfileRequestSchema.safeParse({ email: 'autre@example.test' }).success).toBe(
      false,
    );
    expect(updateProfileRequestSchema.safeParse({ role: 'admin' }).success).toBe(false);
  });

  it('l’historique ne se filtre ni par cliente ni par période', () => {
    // La cliente vient du jeton. Un `clientId` accepté ici ferait de cette
    // requête un moyen de lire l'historique de quelqu'un d'autre.
    expect(myAppointmentsQuerySchema.safeParse({ scope: 'past', limit: 10 }).success).toBe(true);
    expect(myAppointmentsQuerySchema.safeParse({ clientId: UUID }).success).toBe(false);
    expect(myAppointmentsQuerySchema.safeParse({ from: '2026-03-01' }).success).toBe(false);
    expect(myAppointmentsQuerySchema.safeParse({ scope: 'hier' }).success).toBe(false);
  });

  it('borne le nombre de rendez-vous rendus, et convertit la chaîne de requête', () => {
    // `?limit=5` arrive en chaîne : sans conversion, une borne parfaitement
    // valide passerait pour une erreur de saisie.
    expect(myAppointmentsQuerySchema.parse({ limit: '5' }).limit).toBe(5);
    expect(myAppointmentsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(
      myAppointmentsQuerySchema.safeParse({ limit: MY_APPOINTMENTS_MAX_LIMIT + 1 }).success,
    ).toBe(false);
  });
});
