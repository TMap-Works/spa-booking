import type { PublicService, PublicTenant } from '@spa/shared';

import type { ContactDraft } from '@/lib/booking/draft';

/**
 * Un établissement dans un fuseau **qui n'est pas UTC** et qui ne pratique pas
 * l'heure d'été : c'est ce qui fait échouer un affichage qui aurait oublié le
 * fuseau du salon, sans faire dépendre le test de la date à laquelle il tourne.
 */
export const tenant: PublicTenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'maison-lotus',
  name: 'Maison Lotus',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'EUR',
};

export const service: PublicService = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'massage-suedois',
  name: 'Massage suédois',
  description: null,
  category: {
    id: '33333333-3333-4333-8333-333333333333',
    slug: 'massages',
    name: 'Massages',
  },
  durationMinutes: 60,
  price: { amountMinor: 3500, currency: 'EUR' },
  staff: [{ id: '44444444-4444-4444-8444-444444444444', displayName: 'Hery' }],
};

export const contact: ContactDraft = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261341234567',
  clientNote: '',
};
