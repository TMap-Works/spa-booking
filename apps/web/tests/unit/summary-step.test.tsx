import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SummaryStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/summary-step';

import { contact, service, tenant } from './fixtures';

const bookAppointmentAction = vi.fn();

// Le composant poste sa réservation sur une adresse de l'espace client depuis
// #1207 — seule à recevoir les cookies de session. On remplace ce module-là
// entièrement : ce qu'on éprouve ici est le comportement du bouton, pas le
// transport. Le nom de la doublure ne change pas, parce que le geste, lui, n'a
// pas changé.
vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-request', () => ({
  requestBooking: (...args: unknown[]) => bookAppointmentAction(...args),
}));

afterEach(() => {
  cleanup();
  bookAppointmentAction.mockReset();
});

function renderSummary() {
  const onBack = vi.fn();
  const onEditSlot = vi.fn();
  const onEditService = vi.fn();
  const onBooked = vi.fn();
  const onSlotLost = vi.fn();
  const onSignInRequired = vi.fn();

  render(
    <SummaryStep
      tenant={tenant}
      service={service}
      staffId={null}
      startsAt="2026-09-01T06:00:00.000Z"
      contact={contact}
      onBack={onBack}
      onEditSlot={onEditSlot}
      onEditService={onEditService}
      onBooked={onBooked}
      onSlotLost={onSlotLost}
      onSignInRequired={onSignInRequired}
    />,
  );

  return { onBack, onEditSlot, onEditService, onBooked, onSlotLost, onSignInRequired };
}

describe('récapitulatif', () => {
  it('affiche la plage horaire dans le fuseau du salon et le prix de la prestation', () => {
    renderSummary();

    // 06:00 UTC lu à Antananarivo (UTC+3) : 09:00, et la prestation dure une
    // heure — la carte donne les deux bornes, là où la liste ne donnait que le
    // début (#1051).
    expect(screen.getByText(/09:00 – 10:00/)).toBeDefined();
    expect(screen.getByText(/35,00/)).toBeDefined();
    expect(screen.getByText('camille@example.test')).toBeDefined();
  });

  it('nomme « Premier disponible » quand aucun praticien n’a été choisi', () => {
    renderSummary();

    expect(screen.getByText('Premier disponible')).toBeDefined();
  });

  /*
   * Ce que l'audit de conception `d20260916-1` a relevé sur cet écran : trois
   * des quatre faits qui permettent de décider — durée, conditions
   * d'annulation, moment du paiement — n'y figuraient pas, jusqu'au bouton de
   * confirmation inclus (#735, critère `ds:confiance`).
   *
   * Depuis #1051 la durée n'est plus une rangée « Durée / 1 h » : elle qualifie
   * la plage horaire, en retrait typographique (`BM-VISUEL-03`).
   */
  it('porte la durée de la prestation, et pas seulement son nom', () => {
    renderSummary();

    expect(screen.getByText('· 1 h')).toBeDefined();
  });

  it('dit où l’on règle avant de proposer de confirmer', () => {
    renderSummary();

    const encart = screen.getByRole('heading', { name: 'Avant de confirmer' }).parentElement;

    expect(encart?.textContent).toContain('Règlement sur place');
    // Le montant n'y est pas redit : il est dans la carte, plus haut, et le prix
    // ne doit être lisible qu'à un seul endroit.
    expect(screen.getAllByText(/35,00/)).toHaveLength(1);
  });

  it('dit à quelles conditions on peut encore annuler', () => {
    renderSummary();

    const encart = screen.getByRole('heading', { name: 'Avant de confirmer' }).parentElement;

    expect(encart?.textContent).toContain('Annulation sans frais');
    // Ni frais ni préavis côté API : seul le cycle de vie refuse le passage une
    // fois le rendez-vous honoré. La phrase ne promet donc rien de plus.
    expect(encart?.textContent).toContain('tant que le rendez-vous n’a pas eu lieu');
  });

  /*
   * `BM-TUNNEL-01` — « en tête, l'établissement, la date, l'heure, la durée, la
   * prestation, le praticien et le prix, chaque élément avec "Modifier" », et la
   * correction se fait « sans repartir de zéro ». L'audit `d20260918-1` relève
   * que l'écran n'offrait qu'un retour aux coordonnées (#1051).
   */
  describe('chaque bloc se corrige sans perdre les autres', () => {
    it('nomme l’établissement, qu’aucune autre ligne de l’étape ne portait', () => {
      renderSummary();

      expect(screen.getByText('Maison Lotus')).toBeDefined();
    });

    it('renvoie le créneau à son étape', async () => {
      const user = userEvent.setup();
      const { onEditSlot } = renderSummary();

      await user.click(screen.getByRole('button', { name: 'Modifier la date et l’heure' }));

      expect(onEditSlot).toHaveBeenCalledTimes(1);
    });

    it('renvoie la prestation et le praticien à leur étape', async () => {
      const user = userEvent.setup();
      const { onEditService } = renderSummary();

      await user.click(
        screen.getByRole('button', { name: 'Modifier la prestation et le praticien' }),
      );

      expect(onEditService).toHaveBeenCalledTimes(1);
    });

    it('renvoie les coordonnées à leur étape', async () => {
      const user = userEvent.setup();
      const { onBack } = renderSummary();

      await user.click(screen.getByRole('button', { name: 'Modifier mes coordonnées' }));

      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('ne laisse qu’un seul bouton plein sur l’écran (BM-VISUEL-02)', () => {
      renderSummary();

      // Les corrections sont des liens d'action, pas des boutons en contour :
      // l'accent appartient à « Confirmer la réservation », et à lui seul.
      const pleins = screen
        .getAllByRole('button')
        .filter((bouton) => bouton.className.includes('spa-button--accent'));

      expect(pleins).toHaveLength(1);
      expect(pleins[0]?.textContent).toContain('Confirmer la réservation');
    });
  });
});

describe('le bouton de soumission se désactive dès le premier clic', () => {
  it('ne produit qu’une réservation sur un double clic', async () => {
    // L'action ne se résout jamais : c'est exactement la fenêtre pendant
    // laquelle un visiteur impatient clique une seconde fois.
    bookAppointmentAction.mockReturnValue(new Promise(() => undefined));

    const user = userEvent.setup();
    renderSummary();

    const submit = screen.getByRole('button', { name: /Confirmer la réservation/ });

    await user.click(submit);
    await user.click(submit);

    expect(bookAppointmentAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Réservation en cours/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('remonte le créneau perdu à l’orchestrateur plutôt que d’afficher une panne', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Slot lock 7f3a is already held by another transaction.',
    });

    const user = userEvent.setup();
    const { onSlotLost } = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(onSlotLost).toHaveBeenCalledTimes(1);
    // Sans argument : le message du serveur ne franchit pas cette frontière,
    // c'est le tunnel qui écrit l'explication (#46).
    expect(onSlotLost).toHaveBeenCalledWith();
    // Et rien n'est affiché ici — l'écran de panne dirait le contraire de ce
    // qui se passe : la réservation est reprenable au créneau suivant.
    expect(screen.queryByText('La réservation n’a pas abouti')).toBeNull();
  });

  it('remonte l’absence de compte à l’orchestrateur, sans afficher de panne', async () => {
    // Réserver exige un compte (2026-09-22) : l'action refuse quand le cookie
    // de présence a disparu depuis le rendu de la page. La correction est la
    // connexion, que seul le tunnel sait rouvrir.
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Connectez-vous pour réserver.',
    });

    const user = userEvent.setup();
    const { onSignInRequired, onSlotLost } = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(onSignInRequired).toHaveBeenCalledTimes(1);
    expect(onSignInRequired).toHaveBeenCalledWith();
    expect(onSlotLost).not.toHaveBeenCalled();
    expect(screen.queryByText('La réservation n’a pas abouti')).toBeNull();
  });

  it('traite un 409 sans message, que l’API a le droit de ne pas remplir', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: '',
    });

    const user = userEvent.setup();
    const { onSlotLost } = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(onSlotLost).toHaveBeenCalledTimes(1);
  });

  it('réarme le bouton après une erreur passagère', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service injoignable.',
    });

    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(screen.getByRole('alert').textContent).toContain('Service injoignable.');
    expect(
      screen.getByRole('button', { name: /Confirmer la réservation/ }),
    ).toHaveProperty('disabled', false);
  });

  it('transmet la réservation sans staffId quand c’est « premier disponible »', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: { id: 'x' } });

    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const [slug, request] = bookAppointmentAction.mock.calls[0] as [string, Record<string, unknown>];

    expect(slug).toBe('maison-lotus');
    expect(request).not.toHaveProperty('staffId');
    expect(request['client']).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '+261341234567',
    });
  });
});

/**
 * Le second 409 du parcours (#452).
 *
 * `CLIENT_EMAIL_NOT_BOOKABLE` partage son statut avec `SLOT_NO_LONGER_AVAILABLE`
 * et rien d'autre : le créneau perdu se rattrape à l'horaire suivant, celui-ci ne
 * se rattrape qu'en changeant d'adresse. Ce qui se garde ici est donc la
 * **distinction** — et le fait que le message n'apprenne rien de l'annuaire du
 * personnel, la route qui le rend étant publique et non authentifiée.
 */
describe('adresse refusée par la réservation en ligne', () => {
  const refusal = {
    ok: false,
    code: 'CLIENT_EMAIL_NOT_BOOKABLE',
    // Le message du serveur : il ne doit **pas** se retrouver à l'écran, seul le
    // `code` engage l'API (skill web-frontend §2).
    message: 'Cette adresse e-mail ne peut pas être utilisée pour une réservation en ligne.',
  };

  async function refuse() {
    bookAppointmentAction.mockResolvedValue(refusal);

    const user = userEvent.setup();
    const handles = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    return handles;
  }

  it('ne renvoie pas au calendrier — aucun créneau ne lève ce refus', async () => {
    const { onSlotLost, onBooked } = await refuse();

    expect(onSlotLost).not.toHaveBeenCalled();
    expect(onBooked).not.toHaveBeenCalled();
    // L'étape reste montée : la correction est ici, pas cinq écrans plus loin.
    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toBeDefined();
  });

  it('invite à saisir une autre adresse, sans proposer un autre horaire', async () => {
    await refuse();

    const alert = screen.getByRole('alert').textContent ?? '';

    expect(alert).toMatch(/adresse/i);
    // Ce qui débloque : reprendre ses coordonnées, et le bouton qui y mène est là.
    expect(alert).toMatch(/coordonnées/i);
    expect(screen.getByRole('button', { name: /Corriger mes coordonnées/ })).toHaveProperty(
      'disabled',
      false,
    );
    // Ce qui ne débloque rien, et que le message ne doit donc pas suggérer.
    expect(alert).not.toMatch(/autre (créneau|horaire)/i);
    expect(alert).not.toMatch(/choisir un (créneau|horaire)/i);
  });

  it('n’est pas un oracle sur l’annuaire du personnel', async () => {
    await refuse();

    const alert = screen.getByRole('alert').textContent ?? '';

    // Le refus ne dit jamais *pourquoi* : le nommer ferait de ce formulaire
    // public un moyen de tester, adresse par adresse, qui travaille au salon.
    for (const oracle of [
      /personnel/i,
      /équipe/i,
      /salarié/i,
      /collaborat/i,
      /praticien/i,
      /compte/i,
      /membre/i,
      /déjà (utilisée|prise|enregistrée)/i,
    ]) {
      expect(alert).not.toMatch(oracle);
    }

    // Et il ne recopie pas non plus l'adresse saisie, ni le message du serveur.
    expect(alert).not.toContain('camille@example.test');
    expect(alert).not.toContain(refusal.message);
  });

  it('réarme le bouton, faute de quoi rien ne serait cliquable', async () => {
    await refuse();

    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
