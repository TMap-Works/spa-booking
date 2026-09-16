import type { AvailabilityResponse, BookedAppointment } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AccountAnnouncementProvider,
  AccountAnnouncementRegion,
} from '@/app/(account)/[tenantSlug]/compte/components/account-announcement';
import { AppointmentCard } from '@/app/(account)/[tenantSlug]/compte/components/appointment-card';
import { RescheduleForm } from '@/app/(account)/[tenantSlug]/compte/components/reschedule-form';

/**
 * L'annonce d'un geste mené à son terme dans l'espace client — #746.
 *
 * Le défaut relevé par l'audit `d20260916-1` : « Déplacer au … » et « Confirmer
 * l'annulation » ramenaient l'un et l'autre à la liste **sans rien annoncer**. La
 * carte quittait « Rendez-vous à venir » et réapparaissait sous « Historique »,
 * souvent hors de vue à 360 px.
 *
 * Ce que cette suite protège — et c'est plus étroit que « un message s'affiche » :
 *
 * - la région `aria-live` **existe avant** le message. Une région insérée avec
 *   son message n'est annoncée par aucun lecteur d'écran de façon fiable, et
 *   WCAG 2.2 AA 4.1.3 exige un message d'état *programmatiquement déterminable*.
 *   L'assertion n'est donc pas « la région contient le texte » mais **« c'est le
 *   même nœud du DOM qu'avant le geste »** — un `toBe` d'identité, la seule forme
 *   qu'une réécriture ne peut pas satisfaire par accident ;
 * - les **deux** chemins l'alimentent, l'annulation depuis la carte et le report
 *   depuis l'écran de choix de créneau ;
 * - le report n'annonce rien sur l'écran qu'il quitte, et son annonce survit à la
 *   navigation vers la liste ;
 * - une annonce lue puis quittée ne se rallume pas au retour.
 */

const cancelOwnAppointmentAction = vi.fn();
const rescheduleOwnAppointmentAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

const COMPTE = '/salon-des-lilas/compte';
const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const REPORT = `${COMPTE}/rendez-vous/${APPOINTMENT_ID}/report`;
const COORDONNEES = `${COMPTE}/coordonnees`;

/**
 * Le chemin courant, piloté par le test.
 *
 * C'est lui qui joue la navigation : `router.replace` est un double, et ce qui
 * est éprouvé n'est pas le routeur mais ce que la région fait **quand le chemin
 * change sans que le layout soit démonté** — exactement ce que l'App Router fait
 * d'un écran à l'autre du segment `compte`. Un nouveau `render()` remonterait la
 * région et prouverait le contraire de ce qu'on cherche.
 */
let pathname = COMPTE;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  usePathname: () => pathname,
}));

/**
 * Le fuseau du visiteur est piloté comme dans `appointment-card.test.tsx` :
 * `timeZoneMention` lit celui du navigateur, et une assertion qui en dépendrait
 * serait verte à Paris et rouge sur un agent en UTC. Les mises en forme d'heure
 * restent les vraies — l'annonce doit nommer la même heure que le bouton cliqué.
 */
vi.mock('@/lib/format', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/format')>();

  return { ...actual, timeZoneMention: () => 'heure de Europe/Paris' };
});

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  cancelOwnAppointmentAction: (...args: unknown[]) => cancelOwnAppointmentAction(...args),
  rescheduleOwnAppointmentAction: (...args: unknown[]) => rescheduleOwnAppointmentAction(...args),
}));

afterEach(() => {
  cleanup();
  pathname = COMPTE;
  cancelOwnAppointmentAction.mockReset();
  rescheduleOwnAppointmentAction.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: APPOINTMENT_ID,
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d',
    staffId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2e',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-21T08:00:00.000Z',
    endsAt: '2026-09-21T09:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

/**
 * L'espace client tel que le layout le monte : le fournisseur au-dessus, la
 * région en tête du contenu, l'écran dessous.
 */
function espaceClient(children: ReactNode): ReactNode {
  return (
    <AccountAnnouncementProvider>
      <AccountAnnouncementRegion />
      {children}
    </AccountAnnouncementProvider>
  );
}

/** La carte est un `<li>` : elle se monte sous son `<ul>`, comme `AppointmentList` le fait. */
function liste(): ReactNode {
  return espaceClient(
    <ul className="spa-appointment-list">
      <AppointmentCard
        tenantSlug="salon-des-lilas"
        appointment={appointment()}
        timeZone="Europe/Paris"
        serviceName="Massage suédois"
        scope="upcoming"
      />
    </ul>,
  );
}

/** Une journée d'un seul créneau — le choix se fait en un clic. */
const AVAILABILITY: AvailabilityResponse = {
  serviceId: 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59',
  timezone: 'UTC',
  days: [
    {
      date: '2026-09-01',
      slots: [
        {
          startsAt: '2026-09-01T14:15:00.000Z',
          endsAt: '2026-09-01T15:15:00.000Z',
          staffId: '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
        },
      ],
    },
  ],
};

function ecranDeReport(): ReactNode {
  return espaceClient(
    <RescheduleForm
      tenantSlug="salon-des-lilas"
      appointmentId={APPOINTMENT_ID}
      currentStartsAt="2026-09-01T14:00:00.000Z"
      serviceName="Massage suédois"
      availability={AVAILABILITY}
      timeZone="UTC"
      month="2026-09"
      bounds={{ first: '2026-09-01', last: '2026-10-01' }}
      monthHref={`${REPORT}?mois=`}
    />,
  );
}

/**
 * La région, désignée par ce qui la rend annonçable et par rien d'autre.
 *
 * Pas par un rôle ni par un texte : le bandeau qu'elle finit par contenir porte
 * lui aussi `role="status"`, et la région est vide la plupart du temps. C'est
 * l'attribut `aria-live` qui est l'objet du ticket.
 */
function region(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[aria-live="polite"]');

  if (found === null) {
    throw new Error('aucune région aria-live dans l’espace client');
  }

  return found;
}

describe('espace client — la région d’annonce est posée d’avance (#746)', () => {
  it('sort du rendu serveur, vide, avant tout geste', () => {
    const markup = renderToStaticMarkup(liste());

    // La ligne est bien rendue : sans cette assertion, celles du dessous
    // seraient vertes même si l'espace client ne rendait rien.
    expect(markup).toContain('Massage suédois');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    // Vide, et hors du flux : une région qui consommerait une gouttière de
    // `.spa-account__main` poserait 32 px de blanc au-dessus du menu du compte
    // sur tous les écrans, pour ne rien dire.
    expect(markup).toContain('spa-visually-hidden');
    expect(markup).not.toContain('spa-notification');
  });
});

describe('espace client — l’annulation menée à son terme s’annonce', () => {
  it('écrit dans la région qui existait déjà, sans la remplacer', async () => {
    cancelOwnAppointmentAction.mockResolvedValue({ ok: true, data: appointment() });
    const { container } = render(liste());
    const user = userEvent.setup();

    const avant = region(container);
    expect(avant.textContent).toBe('');

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));

    const apres = region(container);

    // Le cœur du ticket : **le même nœud**. Une région insérée avec son message
    // passerait l'assertion de texte et raterait celle-ci — et ne serait annoncée
    // par aucun lecteur d'écran (WCAG 2.2 AA 4.1.3).
    expect(apres).toBe(avant);
    expect(apres.textContent).toContain('Votre rendez-vous est annulé');
    // La phrase nomme l'heure du rendez-vous concerné et la moitié où la ligne
    // est partie : c'est ce que l'audit reprochait à l'écran de taire.
    expect(apres.textContent).toContain('21 septembre 2026');
    expect(apres.textContent).toContain('Historique');
  });

  it('n’annonce rien quand l’annulation échoue', async () => {
    cancelOwnAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Ce rendez-vous n’est plus annulable.',
    });
    const { container } = render(liste());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));

    expect(screen.getByText('Ce rendez-vous n’est plus annulable.')).toBeDefined();
    expect(region(container).textContent).toBe('');
  });

  it('s’efface au premier détour, plutôt que de se rallumer au retour', async () => {
    cancelOwnAppointmentAction.mockResolvedValue({ ok: true, data: appointment() });
    const { container, rerender } = render(liste());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(region(container).textContent).toContain('Votre rendez-vous est annulé');

    // « Modifier mes coordonnées », puis retour par le pied de page. Le layout
    // n'est pas démonté : sans l'oubli, le bandeau se rallumerait longtemps après
    // le geste.
    pathname = COORDONNEES;
    rerender(liste());
    expect(region(container).textContent).toBe('');

    pathname = COMPTE;
    rerender(liste());
    expect(region(container).textContent).toBe('');
  });
});

describe('espace client — le report mené à son terme s’annonce sur la liste', () => {
  it('attend la liste, puis écrit dans la région qui a traversé la navigation', async () => {
    rescheduleOwnAppointmentAction.mockResolvedValue({ ok: true, data: appointment() });
    pathname = REPORT;
    const { container, rerender } = render(ecranDeReport());
    const user = userEvent.setup();

    const avant = region(container);
    expect(avant.textContent).toBe('');

    await user.click(screen.getByRole('button', { name: '14 h 15' }));

    const confirmer = screen.getByRole('button', { name: /Déplacer au/ });
    /** L'heure telle que le bouton la nomme — l'annonce devra nommer la même. */
    const quand = (confirmer.textContent ?? '').replace('Déplacer au ', '');

    await user.click(confirmer);

    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(COMPTE);
    // Rien sur l'écran qu'on quitte : un bandeau de succès au-dessus de
    // « Reporter mon rendez-vous » se lirait comme un second déplacement.
    expect(region(container).textContent).toBe('');

    // La navigation : le chemin change, le layout reste — donc la région aussi.
    pathname = COMPTE;
    rerender(espaceClient(<ul className="spa-appointment-list" />));

    const apres = region(container);

    expect(apres).toBe(avant);
    expect(apres.textContent).toContain('Votre rendez-vous est déplacé');
    // La nouvelle heure, mot pour mot celle que portait le bouton cliqué : une
    // annonce qui nommerait une autre heure serait pire que pas d'annonce.
    expect(quand).toContain('septembre 2026');
    expect(apres.textContent).toContain(quand);
  });

  it('n’annonce rien quand le créneau vient d’être pris', async () => {
    rescheduleOwnAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Créneau indisponible.',
    });
    pathname = REPORT;
    const { container, rerender } = render(ecranDeReport());
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '14 h 15' }));
    await user.click(screen.getByRole('button', { name: /Déplacer au/ }));

    expect(screen.getByText('Ce créneau vient d’être pris')).toBeDefined();

    // Même en revenant à la liste de son propre chef, il n'y a rien à annoncer :
    // le rendez-vous n'a pas bougé.
    pathname = COMPTE;
    rerender(espaceClient(<ul className="spa-appointment-list" />));

    expect(region(container).textContent).toBe('');
  });
});
