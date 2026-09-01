/**
 * Le conflit de créneau, vu du tunnel entier (#46).
 *
 * Ce cas ne s'éprouve pas étape par étape : ce qu'il faut prouver, c'est qu'un
 * 409 arrivé au récapitulatif ramène au calendrier **avec des créneaux frais**
 * et **sans rien perdre** de ce qui a été saisi trois écrans plus tôt. Il faut
 * donc le tunnel au complet, monté avec son brouillon.
 *
 * Les actions serveur sont remplacées : sous test, ce sont des modules Next qui
 * n'existent pas hors du serveur. Ce qu'on éprouve ici est l'enchaînement des
 * étapes, pas le transport.
 */

import type {
  AvailabilityResponse,
  BookedAppointment,
  CalendarDate,
  UtcInstant,
} from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingTunnel } from '@/app/(booking)/[tenantSlug]/reservation/booking-tunnel';

import { service, tenant } from './fixtures';

const loadAvailabilityAction = vi.fn();
const bookAppointmentAction = vi.fn();
const cancelAppointmentAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
  bookAppointmentAction: (...args: unknown[]) => bookAppointmentAction(...args),
  cancelAppointmentAction: (...args: unknown[]) => cancelAppointmentAction(...args),
}));

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;
const APRES_MIDI = '2026-09-01T11:00:00.000Z' as UtcInstant;
const JOURNEE = '2026-09-01' as CalendarDate;

/**
 * Le message que l'API accompagne au 409.
 *
 * Volontairement technique et anglophone : s'il apparaissait à l'écran, c'est
 * que le tunnel relaie la prose du serveur au lieu d'écrire la sienne.
 */
const MESSAGE_API = 'Slot lock 7f3a is already held by another transaction.';

function availability(slots: readonly UtcInstant[]): AvailabilityResponse {
  return {
    serviceId: service.id,
    timezone: tenant.timezone,
    days: [
      {
        date: JOURNEE,
        slots: slots.map((startsAt) => ({
          startsAt,
          endsAt: startsAt,
          staffId: service.staff[0]?.id ?? '',
        })),
      },
    ],
  };
}

/** Le rendez-vous obtenu à la seconde tentative, celle qui aboutit. */
function rendezVous(): BookedAppointment {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    status: 'confirmed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '',
    clientId: '66666666-6666-4666-8666-666666666666',
    startsAt: APRES_MIDI,
    endsAt: APRES_MIDI,
    price: service.price,
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };
}

beforeEach(() => {
  // Le brouillon vit dans `sessionStorage` : sans ce nettoyage, un test
  // reprendrait le tunnel là où le précédent l'a laissé.
  window.sessionStorage.clear();
  loadAvailabilityAction.mockResolvedValue({ ok: true, data: availability([MATIN, APRES_MIDI]) });
});

afterEach(() => {
  cleanup();
  loadAvailabilityAction.mockReset();
  bookAppointmentAction.mockReset();
  cancelAppointmentAction.mockReset();
});

function renderTunnel() {
  render(<BookingTunnel tenant={tenant} services={[service]} />);

  return userEvent.setup();
}

/** Prestation → créneau → coordonnées → récapitulatif, prêt à confirmer. */
async function allerJusquAuRecapitulatif(
  user: ReturnType<typeof userEvent.setup>,
  creneau: string,
): Promise<void> {
  await user.selectOptions(screen.getByLabelText('Prestation'), service.id);
  await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

  await user.click(await screen.findByRole('button', { name: creneau }));

  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

  await screen.findByRole('button', { name: /Confirmer la réservation/ });
}

describe('un créneau pris pendant la saisie', () => {
  it('explique la situation avec l’horaire perdu, sans reprendre le message de l’API', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09:00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const avis = await screen.findByRole('alert');

    // L'horaire perdu est nommé, dans le fuseau du salon : entre le clic et
    // l'écran, la cliente ne sait plus toujours lequel elle visait.
    expect(avis.textContent).toContain('1 septembre 2026');
    expect(avis.textContent).toContain('09:00');
    expect(avis.textContent).toContain('conservé');
    // Le contrat, c'est le code ; le message du serveur n'atteint pas l'écran.
    expect(avis.textContent).not.toContain(MESSAGE_API);
    expect(avis.textContent).not.toContain('7f3a');
  });

  it('recharge les créneaux plutôt que de réafficher la liste périmée', async () => {
    // Le second chargement ne rend plus 09:00 : c'est le créneau que quelqu'un
    // d'autre vient d'obtenir. S'il restait proposé, la cliente se heurterait au
    // même 409 en boucle.
    loadAvailabilityAction
      .mockResolvedValueOnce({ ok: true, data: availability([MATIN, APRES_MIDI]) })
      .mockResolvedValue({ ok: true, data: availability([APRES_MIDI]) });
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09:00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByRole('button', { name: '14:00' })).toBeDefined();
    expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '09:00' })).toBeNull();
  });

  it('conserve la prestation et les coordonnées déjà saisies', async () => {
    loadAvailabilityAction
      .mockResolvedValueOnce({ ok: true, data: availability([MATIN, APRES_MIDI]) })
      .mockResolvedValue({ ok: true, data: availability([APRES_MIDI]) });
    bookAppointmentAction.mockResolvedValueOnce({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09:00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    // Un seul geste sépare la cliente de sa réservation : reprendre un horaire.
    await user.click(await screen.findByRole('button', { name: '14:00' }));

    expect(screen.getByLabelText(/Prénom/)).toHaveProperty('value', 'Camille');
    expect(screen.getByLabelText(/^Nom/)).toHaveProperty('value', 'Rakoto');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty(
      'value',
      'camille@example.test',
    );

    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));
    // La prestation aussi a survécu : le récapitulatif la nomme sans repasser
    // par la première étape.
    expect(await screen.findByText(service.name)).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(bookAppointmentAction).toHaveBeenCalledTimes(2);
    expect(bookAppointmentAction.mock.calls[1]?.[1]).toMatchObject({
      serviceId: service.id,
      startsAt: APRES_MIDI,
      client: { firstName: 'Camille', lastName: 'Rakoto', email: 'camille@example.test' },
    });
  });

  it('rend le focus à l’explication, que le bouton confirmé vient d’emporter', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09:00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const avis = await screen.findByRole('alert');

    // Sans ce déplacement, le focus retomberait sur `<body>` : la navigation au
    // clavier repartirait du haut du document au pire moment.
    //
    // L'assertion porte sur l'enveloppe elle-même, pas sur un `contains` :
    // `document.body` contient l'avis, et un test écrit ainsi passerait
    // précisément dans le cas qu'il prétend écarter.
    const enveloppe = avis.closest('[tabindex="-1"]');

    expect(enveloppe).not.toBeNull();
    expect(document.activeElement).toBe(enveloppe);
  });
});

describe('le tunnel trie sur le code d’erreur, jamais sur le message', () => {
  it('ne renvoie pas au calendrier une panne dont le message parle de créneau', async () => {
    // Le message est exactement celui d'un conflit ; le code, non. Trier sur la
    // prose ferait traiter une panne comme un créneau perdu — et perdrait le
    // créneau que la cliente tient encore.
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Ce créneau vient d’être réservé.',
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09:00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByText('La réservation n’a pas abouti')).toBeDefined();
    // Toujours au récapitulatif : ni retour au calendrier, ni rechargement.
    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('button', { name: '14:00' })).toBeNull();
    expect(loadAvailabilityAction).toHaveBeenCalledTimes(1);
  });
});
