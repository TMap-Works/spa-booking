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
import { appointmentListQuerySchema, createAppointmentRequestSchema } from '../schemas/appointment';
import { availabilityQuerySchema } from '../schemas/availability';
import { createServiceRequestSchema, serviceSchema } from '../schemas/catalog';
import { registerRequestSchema, userSchema } from '../schemas/identity';
import { notificationSchema } from '../schemas/notification';
import { recordCounterPaymentRequestSchema, refundPaymentRequestSchema } from '../schemas/payment';
import { publicTenantSchema, updateTenantRequestSchema } from '../schemas/tenant';

const UUID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const OTHER_UUID = '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d';

describe('identity', () => {
  it('refuse un tenantId ou un role à l’inscription', () => {
    const base = {
      email: 'alice@example.test',
      password: 'correct horse battery',
      firstName: 'Alice',
      lastName: 'Martin',
    };

    expect(registerRequestSchema.safeParse(base).success).toBe(true);
    expect(registerRequestSchema.safeParse({ ...base, tenantId: UUID }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...base, role: 'admin' }).success).toBe(false);
  });

  it('canonise l’e-mail — c’est ce qui rend l’unicité (tenant, email) fiable', () => {
    const parsed = registerRequestSchema.parse({
      email: '  Alice@Example.TEST ',
      password: 'correct horse battery',
      firstName: 'Alice',
      lastName: 'Martin',
    });

    expect(parsed.email).toBe('alice@example.test');
  });

  it('ne rogne pas le mot de passe et impose le plancher de longueur', () => {
    const withSpaces = {
      email: 'alice@example.test',
      password: ' correct horse battery ',
      firstName: 'Alice',
      lastName: 'Martin',
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
    });

    expect(parsed.timezone).toBe('Europe/Paris');
    expect(parsed.defaultCurrency).toBe('EUR');
  });

  it('refuse un slug qui n’est pas un label DNS valide', () => {
    const base = {
      id: UUID,
      name: 'Salon Lumière',
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
    };

    expect(publicTenantSchema.safeParse({ ...base, slug: '-salon' }).success).toBe(false);
    expect(publicTenantSchema.safeParse({ ...base, slug: 'salon-' }).success).toBe(false);
    expect(publicTenantSchema.safeParse({ ...base, slug: 'salon lumiere' }).success).toBe(false);
  });

  it('refuse un champ hors contrat dans la mise à jour', () => {
    expect(updateTenantRequestSchema.safeParse({ name: 'Nouveau nom' }).success).toBe(true);
    expect(updateTenantRequestSchema.safeParse({ isActive: false }).success).toBe(false);
  });
});

describe('catalog', () => {
  it('porte le prix comme un couple montant/devise indissociable', () => {
    const parsed = serviceSchema.parse({
      id: UUID,
      slug: 'massage-suedois',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 7500, currency: 'EUR' },
      isActive: true,
    });

    expect(parsed.price).toEqual({ amountMinor: 7500, currency: 'EUR' });
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
