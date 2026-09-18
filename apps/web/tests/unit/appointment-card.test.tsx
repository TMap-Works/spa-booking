import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppointmentCard } from '@/app/(account)/[tenantSlug]/compte/components/appointment-card';

/**
 * La carte compacte d'un rendez-vous — les rendez-vous à venir qui suivent le
 * prochain, et les lignes de l'historique.
 *
 * Ce que la suite protège — et rien d'autre, les statuts et les gestes de la
 * carte ayant déjà leurs suites (`appointment-status.test.ts`) :
 *
 * - **#680** — la mention du fuseau ne sort pas du rendu serveur, qui n'a aucun
 *   moyen de savoir où se trouve la visiteuse ;
 * - **#1053** — ce que la carte nomme (`BM-RDV-02`), et la ligne sous la
 *   pastille qui remplace les paragraphes d'explication de section.
 */

const cancelOwnAppointmentAction = vi.fn();
const refresh = vi.fn();

/**
 * Le fuseau du visiteur est piloté par le test, comme dans
 * `reschedule-form.test.tsx` et `slot-step.test.tsx`.
 *
 * `timeZoneMention` lit celui du navigateur : une assertion sur la mention
 * dépendrait sinon de la machine où la suite tourne — verte à Paris, rouge sur
 * un agent en UTC. Seule cette fonction est remplacée ; les mises en forme
 * d'heure et de montant restent les vraies.
 */
const MENTION = 'heure de Europe/Paris';

vi.mock('@/lib/format', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/format')>();

  return { ...actual, timeZoneMention: () => MENTION };
});

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  cancelOwnAppointmentAction: (...args: unknown[]) => cancelOwnAppointmentAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d',
    staffId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2e',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

/**
 * La carte est un `<li>` : la monter sous son `<ul>` reproduit ce que
 * `AppointmentList` en fait, et vaut mieux qu'un `<li>` orphelin dans un `<div>`.
 */
function card(overrides: Partial<BookedAppointment> = {}) {
  return (
    <ul className="spa-appointment-list">
      <AppointmentCard
        tenantSlug="salon-des-lilas"
        brief={{
          appointment: appointment(overrides),
          serviceName: 'Massage suédois',
          practitioner: 'Hery',
          durationMinutes: 60,
        }}
        timeZone="Europe/Paris"
        scope="upcoming"
      />
    </ul>
  );
}

afterEach(() => {
  cleanup();
  cancelOwnAppointmentAction.mockReset();
  refresh.mockReset();
});

/**
 * #680 — la mention du fuseau attend l'hydratation.
 *
 * `timeZoneMention` lit `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 * c'est-à-dire le fuseau du **navigateur**. Au rendu serveur il n'y a pas de
 * navigateur : `Intl` y rend celui du conteneur. La liste qui monte cette carte
 * étant un Server Component, chaque ligne partait donc du serveur avec une
 * mention qu'une visiteuse déjà dans le fuseau du salon ne devait pas lire —
 * puis disparaissait à l'hydratation, avec l'avertissement React de divergence.
 *
 * La divergence elle-même n'est pas reproductible ici : sous jsdom, le rendu
 * serveur et le rendu client tournent dans le même processus, donc avec le même
 * `Intl`. Ce qui se prouve est sa **cause** — que le rendu serveur ne calcule
 * pas la mention du tout — et c'est exactement ce que le drapeau `mounted`
 * garantit.
 */
describe('historique — la mention du fuseau attend l’hydratation (#680)', () => {
  it('ne sort pas la mention du rendu serveur', () => {
    const markup = renderToStaticMarkup(card());

    // La ligne, elle, est bien rendue par le serveur : sans cette assertion,
    // celle du dessous serait verte même si la carte ne rendait rien.
    expect(markup).toContain('Massage suédois');
    expect(markup).toContain('spa-appointment__meta');
    expect(markup).not.toContain(MENTION);
    expect(markup).not.toContain('spa-appointment__timezone');
  });

  it('la complète une fois la carte montée', () => {
    const { container } = render(card());

    // La plage horaire, elle, ne dépend d'aucun montage : elle est mise en forme
    // dans le fuseau du salon des deux côtés, et c'est bien la mention seule qui
    // arrive après coup.
    const meta = container.querySelector('.spa-appointment__meta');

    expect(meta?.textContent).toContain('11:00 – 12:00');
    expect(meta?.textContent).toContain(`(${MENTION})`);
  });
});

/**
 * Ce que la carte compacte dit d'un rendez-vous — `BM-RDV-02`, #1053.
 *
 * Le motif veut « quoi, avec qui, quand, où, combien, et son statut » sur chaque
 * carte, et reproche nommément à Planity de taire le praticien réservé. Le
 * « où » appartient à la carte héros et à la colonne latérale : il est le même
 * pour tous les rendez-vous d'un salon, et le répéter sur chaque ligne d'une
 * liste n'apprendrait rien.
 */
describe('carte compacte — ce qu’elle nomme (BM-RDV-02)', () => {
  it('nomme la prestation, le praticien, la durée, le prix et le statut', () => {
    const { container } = render(card());

    expect(screen.getByText('Massage suédois')).toBeDefined();
    expect(container.querySelector('.spa-appointment__meta')?.textContent).toContain('Hery');
    expect(container.querySelector('.spa-appointment__meta')?.textContent).toContain('1 h');
    expect(screen.getByText('35,00 €')).toBeDefined();
    expect(screen.getByText('Confirmé')).toBeDefined();
  });

  it('dit sous la pastille ce que « À confirmer par le salon » laisse ouvert', () => {
    // C'est la ligne qui remplace les quatre lignes d'explication posées sous le
    // titre de la section avant #1053.
    render(card({ status: 'pending' }));

    expect(screen.getByText('À confirmer par le salon')).toBeDefined();
    expect(screen.getByText(/rien à faire de votre côté/i)).toBeDefined();
  });

  it('ne commente pas une pastille qui se suffit', () => {
    render(card());

    expect(document.querySelector('.spa-appointment__status-note')).toBeNull();
  });
});
