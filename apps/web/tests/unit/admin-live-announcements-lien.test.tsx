import type { AppointmentFeedEvent, TimeZone, UtcInstant } from '@spa/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminAnnouncementProvider,
  AdminAnnouncementRegion,
} from '@/app/(admin)/[tenantSlug]/admin/components/admin-announcement';
import { AdminLiveAnnouncements } from '@/app/(admin)/[tenantSlug]/admin/components/admin-live-announcements';
import type { AppointmentFeedNotice } from '@/components/live/appointment-feed';

/**
 * Où mène l'avis du planning temps réel — #1435.
 *
 * ## Ce qui n'allait pas
 *
 * Depuis #1410, « Mon planning » masque les annulés par défaut. Le lien de
 * l'annonce était composé par `adminMyPlanningPath(tenantSlug, { date })` pour
 * les **deux** natures d'annonce : suivre un avis « rendez-vous annulé »
 * ouvrait donc une journée où le rendez-vous qu'il venait de nommer
 * n'apparaissait pas.
 *
 * ## Ce que cette suite éprouve, et pourquoi ainsi
 *
 * L'adresse du lien **rendu**, et non le retour d'une fonction : le défaut était
 * dans le choix du composeur, pas dans le composeur — `withCancelledShown` est
 * éprouvé pour lui-même par les suites de `lib/admin/my-planning.ts`. C'est
 * l'ancre de la région d'annonce qui dit où la praticienne arrive.
 *
 * Les trois cas sont indissociables, et c'est pour cela qu'ils sont ici
 * ensemble : demander les annulés sur l'annulation ne vaut que si l'annonce
 * d'une **réservation** ne les demande pas (elle nomme un rendez-vous actif), et
 * si le lien du planning **salon** reste intact (il n'a pas encore
 * l'interrupteur — c'est #982 qui le livrera).
 *
 * Les adresses attendues sont écrites en toutes lettres plutôt que recomposées
 * par `adminMyPlanningPath` : une attente bâtie avec le code sous test serait
 * verte quel que soit ce code.
 */

const TENANT = 'salon-des-lilas';
const MON_PLANNING = `/${TENANT}/admin/mon-planning`;
const CALENDRIER = `/${TENANT}/admin/calendrier`;
const TIME_ZONE = 'Europe/Paris' as TimeZone;
/** Vendredi 2 octobre 2026, 14:00 à Paris — la date civile du salon est donc `2026-10-02`. */
const DEBUT = '2026-10-02T12:00:00.000Z' as UtcInstant;
const JOUR = '2026-10-02';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => CALENDRIER,
}));

/**
 * L'écouteur que le composant abonne au flux, capturé plutôt que nourri par une
 * vraie connexion : `EventSource` n'existe pas sous jsdom. Le vrai fournisseur
 * est éprouvé par `appointment-feed-live.test.ts`.
 */
let ecouteur: ((notice: AppointmentFeedNotice) => void) | null = null;

vi.mock('@/components/live/appointment-feed', () => ({
  useAppointmentFeed: (listener: (notice: AppointmentFeedNotice) => void) => {
    ecouteur = listener;
  },
}));

afterEach(() => {
  cleanup();
  ecouteur = null;
});

function evenement(change: AppointmentFeedEvent['change']): AppointmentFeedEvent {
  return {
    change,
    appointmentId: 'a0f1c2d3-3333-4c53-8f0e-1b2c3d4e5f60',
    startsAt: DEBUT,
    occurredAt: '2026-10-01T09:00:00.000Z' as UtcInstant,
    ...(change === 'cancelled' ? { cancelledBy: 'client' as const } : {}),
  };
}

/** L'adresse du lien de l'annonce, après qu'un changement est arrivé du flux. */
function lienAnnonce(
  change: AppointmentFeedEvent['change'],
  readsEstablishmentAgenda: boolean,
): string {
  const { container } = render(
    <AdminAnnouncementProvider>
      <AdminAnnouncementRegion />
      <AdminLiveAnnouncements
        countryCode="FR"
        readsEstablishmentAgenda={readsEstablishmentAgenda}
        tenantSlug={TENANT}
        timeZone={TIME_ZONE}
      />
    </AdminAnnouncementProvider>,
  );

  if (ecouteur === null) {
    throw new Error('le composant ne s’est pas abonné au flux');
  }

  const recevoir = ecouteur;

  act(() => {
    recevoir({ kind: 'change', event: evenement(change) });
  });

  const lien = container.querySelector<HTMLAnchorElement>('[aria-live="polite"] a[href]');

  if (lien === null) {
    throw new Error('aucun lien dans la région d’annonce');
  }

  return lien.getAttribute('href') ?? '';
}

describe('back-office — l’avis du temps réel mène à la ligne qu’il nomme (#1435)', () => {
  it('demande l’affichage des annulés sur l’avis d’annulation', () => {
    expect(lienAnnonce('cancelled', false)).toBe(`${MON_PLANNING}?date=${JOUR}&annules=1`);
  });

  it('ne les demande pas sur l’avis de réservation, qui nomme un rendez-vous actif', () => {
    const href = lienAnnonce('created', false);

    expect(href).toBe(`${MON_PLANNING}?date=${JOUR}`);
    expect(href).not.toContain('annules');
  });

  it('laisse intact le lien du planning du salon, qui n’a pas encore l’interrupteur (#982)', () => {
    const href = lienAnnonce('cancelled', true);

    expect(href).toBe(`${CALENDRIER}?date=${JOUR}`);
    expect(href).not.toContain('annules');
  });
});
