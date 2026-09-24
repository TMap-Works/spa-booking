import type { Appointment, AppointmentStatus, SaleSettlement } from '@spa/shared';
import { cleanup, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';
import type { SettlementState } from '@/lib/admin/checkout-summary';
import type { SaleSummary } from '@/lib/admin/payment-contract';

/**
 * Le panneau d'encaissement tel qu'il se manipule (#59, repris par #835).
 *
 * Les actions serveur sont doublées : ce qui est exercé ici est **l'écran** —
 * les moyens offerts, le règlement mixte, la protection du double clic, ce que
 * le reçu affirme —, pas le transport. Le transport a sa recette, l'API la
 * sienne.
 *
 * Il n'y a plus aucune doublure de SDK de paiement, et c'est le résultat qui
 * compte le plus dans ce fichier : la carte se règle sur le **TPE autonome** de
 * la banque du salon, l'application ne parle à personne, et il n'existe donc
 * plus rien à monter — pas même une iframe (ADR 0015).
 */

const openCheckoutTicketAction = vi.fn();
const settleTicketAction = vi.fn();
const loadReceiptAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  openCheckoutTicketAction: (...args: unknown[]) => openCheckoutTicketAction(...args),
  settleTicketAction: (...args: unknown[]) => settleTicketAction(...args),
  loadReceiptAction: (...args: unknown[]) => loadReceiptAction(...args),
}));

// Le panneau part vers la route de renouvellement sur une session expirée
// (#856), et redemande le rendu serveur quand la journée de caisse change
// (#1004) : le routeur est doublé pour observer l'un et l'autre.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace }),
}));

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SERVICE_ID = 'eeeeeeee-0000-4000-8000-000000000004';
const SALE_ID = '99999999-0000-4000-8000-000000000009';

/** Un ticket de 78,00 € — celui du huitième critère de #835. */
function sale(settledMinor = 0): SaleSummary {
  return {
    id: SALE_ID,
    appointmentId: APPOINTMENT_ID,
    cashierUserId: 'bbbbbbbb-0000-4000-8000-000000000008',
    subtotal: { amountMinor: 7800, currency: 'EUR' },
    tax: { amountMinor: 0, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 7800, currency: 'EUR' },
    settled: { amountMinor: settledMinor, currency: 'EUR' },
    remaining: { amountMinor: 7800 - settledMinor, currency: 'EUR' },
    settledAt: settledMinor === 7800 ? '2026-09-05T07:05:00.000Z' : null,
    createdAt: '2026-09-05T07:00:00.000Z',
  };
}

function settlement(
  amountMinor: number,
  method: 'cash' | 'card',
  remainingMinor: number,
  extra: { readonly changeMinor?: number; readonly terminalReference?: string } = {},
): SaleSettlement {
  return {
    payment: {
      id: `ffffffff-0000-4000-8000-00000000000${String(amountMinor).slice(0, 1)}`,
      appointmentId: APPOINTMENT_ID,
      saleId: SALE_ID,
      amount: { amountMinor, currency: 'EUR' },
      refunded: { amountMinor: 0, currency: 'EUR' },
      method,
      cardChannel: method === 'card' ? 'TERMINAL' : null,
      terminalReference: extra.terminalReference ?? null,
      status: 'succeeded',
      capturedAt: '2026-09-05T07:05:00.000Z',
      createdAt: '2026-09-05T07:05:00.000Z',
    },
    saleId: SALE_ID,
    total: { amountMinor: 7800, currency: 'EUR' },
    settled: { amountMinor: 7800 - remainingMinor, currency: 'EUR' },
    remaining: { amountMinor: remainingMinor, currency: 'EUR' },
    change: { amountMinor: extra.changeMinor ?? 0, currency: 'EUR' },
    settledAt: remainingMinor === 0 ? '2026-09-05T07:05:00.000Z' : null,
    replayed: false,
  };
}

function appointment(status: AppointmentStatus = 'confirmed'): Appointment {
  return {
    id: APPOINTMENT_ID,
    reference: 'RDV-8F3K-27',
    status,
    client: {
      id: 'cccccccc-0000-4000-8000-000000000002',
      firstName: 'Rina',
      lastName: 'Andriamana',
    },
    staff: { id: 'dddddddd-0000-4000-8000-000000000003', displayName: 'Hasina' },
    service: {
      id: SERVICE_ID,
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 7800, currency: 'EUR' },
    },
    startsAt: '2026-09-05T06:00:00.000Z',
    endsAt: '2026-09-05T07:00:00.000Z',
    price: { amountMinor: 7800, currency: 'EUR' },
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

function panel(
  status: AppointmentStatus = 'confirmed',
  settlementState: SettlementState | null = null,
  ticket: SaleSummary | null = null,
): ReactElement {
  return (
    <CheckoutPanel
      appointment={appointment(status)}
      settlement={settlementState}
      tenantSlug={SLUG}
      ticket={ticket}
      timeZone={TIMEZONE}
    />
  );
}

/**
 * Monte le panneau, et rend de quoi le **remonter avec d'autres props**.
 *
 * Ce second usage est ce qui permet d'exercer `router.refresh()` sans routeur :
 * ce que le rafraîchissement produit, vu d'ici, est exactement un nouveau rendu
 * du même panneau avec le `settlement` que la page vient de relire (#1004).
 */
function renderPanel(
  status: AppointmentStatus = 'confirmed',
  settlementState: SettlementState | null = null,
  ticket: SaleSummary | null = null,
): RenderResult {
  return render(panel(status, settlementState, ticket));
}

const CASH_TRANSACTION = {
  id: 'ffffffff-0000-4000-8000-000000000005',
  appointmentId: APPOINTMENT_ID,
  saleId: SALE_ID,
  amount: { amountMinor: 7800, currency: 'EUR' },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'cash' as const,
  status: 'succeeded' as const,
  capturedAt: '2026-09-05T07:05:00.000Z',
  createdAt: '2026-09-05T07:05:00.000Z',
};

/** Le clic qui règle : le bouton des espèces, ou l'acceptation du TPE. */
const CASH_BUTTON = /en espèces/;

afterEach(() => {
  cleanup();
  openCheckoutTicketAction.mockReset();
  settleTicketAction.mockReset();
  loadReceiptAction.mockReset();
  refresh.mockReset();
});

describe('le choix du moyen de paiement', () => {
  it('offre exactement deux moyens : les espèces et la carte au TPE', () => {
    renderPanel();

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Espèces/ })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Carte bancaire \(TPE\)/ })).toBeDefined();
  });

  it('n’offre nulle part où saisir un numéro de carte, et ne nomme plus Stripe', () => {
    // Sixième critère de #835, et la garantie la plus coûteuse à perdre du
    // projet : un champ de carte ferait basculer le périmètre de SAQ A à SAQ D.
    renderPanel();

    // Seules les saisies **libres** sont examinées : un bouton radio ne porte
    // pas de numéro, et c'est le même découpage que la garde des maquettes
    // (`tests/admin-mockups.test.mjs`).
    const freeText = /^(?:text|tel|number|password|email|search)$/;

    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('autocomplete') ?? '').not.toMatch(/^cc-/);

      if (!freeText.test(field.getAttribute('type') ?? 'text')) {
        continue;
      }

      const identity = [field.id, field.name, field.getAttribute('placeholder') ?? ''].join(' ');

      expect(identity).not.toMatch(/carte|card|cvc|cvv|expirat/i);
    }

    expect(document.body.textContent).not.toMatch(/Stripe/i);
  });

  it('laisse encaisser un rendez-vous honoré par l’un ou l’autre moyen', () => {
    // Le tunnel en ligne refusait ces statuts en 422 ; le comptoir n'ouvre plus
    // d'intention, et les deux moyens acceptent donc les mêmes.
    renderPanel('completed');

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveProperty('disabled', false);
    }
  });

  it('n’encaisse rien sur un rendez-vous annulé', () => {
    renderPanel('cancelled');

    expect(screen.getByText('Rien à encaisser')).toBeDefined();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});

describe('le règlement en espèces', () => {
  it('compose le ticket au premier règlement, jamais à l’affichage', async () => {
    // Ouvrir l'écran d'un rendez-vous ne doit laisser aucune pièce comptable
    // derrière soi : le ticket naît du clic, pas du rendu.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(7800, 'cash', 0) });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    expect(openCheckoutTicketAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(openCheckoutTicketAction).toHaveBeenCalledWith(SLUG, APPOINTMENT_ID, SERVICE_ID);
    });
  });

  it('règle tout le reste dû, et n’envoie aucun total', async () => {
    // Le corps porte la **part** réglée maintenant, jamais le total du ticket :
    // celui-là est composé par le serveur et relu sous verrou (#817).
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(7800, 'cash', 0) });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(1);
    });

    const [slug, saleId, body, key] = settleTicketAction.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      string,
    ];

    expect(slug).toBe(SLUG);
    expect(saleId).toBe(SALE_ID);
    expect(body).toEqual({ method: 'CASH', amountMinor: 7800 });
    expect(key.length).toBeGreaterThanOrEqual(8);
  });

  it('affiche en grand la monnaie à rendre, calculée par le serveur', async () => {
    // Troisième critère de #835. `change` vient de l'enveloppe de règlement : le
    // front ne soustrait jamais deux montants.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: settlement(7800, 'cash', 0, { changeMinor: 2200 }),
    });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    await userEvent.type(screen.getByLabelText(/Montant remis/), '100,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    const callout = await screen.findByText('Monnaie à rendre');

    expect(callout.className).toContain('spa-admin-checkout__callout-label');
    expect(screen.getByText(/22,00/)).toBeDefined();

    const [, , body] = settleTicketAction.mock.calls[0] as [string, string, Record<string, unknown>];

    // Le billet tendu part **seul**. `amountMinor` et `tenderedAmountMinor`
    // s'excluent côté API (`settleSaleRequestSchema`, `settlement.rules.ts`) :
    // les envoyer ensemble rendait un 400 « La requête est invalide » que seul
    // un appel réel voyait — ce double-ci accepte tout. Le serveur applique le
    // reste dû et rend la différence en monnaie.
    expect(body).toEqual({ method: 'CASH', tenderedAmountMinor: 10_000 });
  });

  it('ne demande pas de billet tendu en règlement partiel — les deux s’excluent', async () => {
    // La régression que la recette a levée : le corps portait `amountMinor`
    // **et** `tenderedAmountMinor`, que l'API refuse en 400 (« un billet tendu
    // et une part réglée sont deux gestes distincts »,
    // `settleSaleRequestSchema`). Le champ disparaît donc du mode partiel, et
    // ce qui y aurait été saisi avant la bascule ne part pas.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(5000, 'cash', 2800) });
    renderPanel();

    await userEvent.type(screen.getByLabelText(/Montant remis/), '100,00');
    await userEvent.click(screen.getByLabelText(/Régler une partie/));

    expect(screen.queryByLabelText(/Montant remis/)).toBeNull();

    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(1);
    });

    const [, , body] = settleTicketAction.mock.calls[0] as [string, string, Record<string, unknown>];

    expect(body).toEqual({ method: 'CASH', amountMinor: 5000 });
    expect(body).not.toHaveProperty('tenderedAmountMinor');
  });

  it('refuse sur le champ un montant remis qui ne couvre pas le règlement', async () => {
    // Le front borne pour le confort, l'API pour la sécurité : le refus s'affiche
    // **sur le champ**, pas en bloc en haut de page (web-frontend §4).
    renderPanel();

    await userEvent.type(screen.getByLabelText(/Montant remis/), '10,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    const alert = await screen.findByRole('alert');

    expect(alert.id).toBe('montant-remis-erreur');
    expect(settleTicketAction).not.toHaveBeenCalled();
  });

  it('désactive le bouton dès le premier clic — un double clic n’encaisse pas deux fois', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockReturnValue(new Promise(() => undefined));
    renderPanel();

    const button = screen.getByRole('button', { name: CASH_BUTTON });
    await userEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveProperty('disabled', true);
    });
    await userEvent.click(button);

    expect(settleTicketAction).toHaveBeenCalledTimes(1);
  });

  it('rend la main quand l’action serveur ne répond pas du tout', async () => {
    openCheckoutTicketAction.mockRejectedValue(new Error('Failed to fetch'));
    renderPanel();

    const button = screen.getByRole('button', { name: CASH_BUTTON });
    await userEvent.click(button);

    expect((await screen.findByRole('alert')).textContent).toMatch(/n’a pas répondu/);
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
  });

  it('bascule l’écran sur le ticket déjà soldé au lieu de laisser le bouton actif', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: false,
      code: 'SALE_ALREADY_SETTLED',
      message: 'Ce ticket a déjà été réglé.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    expect(await screen.findByText('Rendez-vous déjà encaissé')).toBeDefined();
    expect(screen.queryByRole('button', { name: CASH_BUTTON })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // Le texte est celui de l'écran, pas celui que l'API a rendu.
    expect(screen.queryByText('Ce ticket a déjà été réglé.')).toBeNull();
  });

  it('renouvelle une session expirée plutôt que de la dire — #856', async () => {
    replace.mockReset();
    openCheckoutTicketAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('le règlement par carte au TPE', () => {
  async function goToTerminal(ticket: SaleSummary | null = null): Promise<void> {
    renderPanel('confirmed', null, ticket);
    await userEvent.click(screen.getByRole('radio', { name: /Carte bancaire \(TPE\)/ }));
    await userEvent.click(screen.getByRole('button', { name: /au TPE/ }));
  }

  it('annonce en grand le montant à saisir sur le terminal', async () => {
    // Deuxième critère de #835 : c'est le chiffre que l'opérateur recopie sur le
    // terminal, sous les yeux de la cliente.
    await goToTerminal();

    expect(await screen.findByText(/Saisissez ce montant sur le TPE/)).toBeDefined();
    const amount = screen.getByText(/78,00/, {
      selector: '.spa-admin-checkout__callout-amount',
    });
    expect(amount).toBeDefined();
  });

  it('n’a inscrit rien du tout tant que l’issue n’est pas déclarée', async () => {
    await goToTerminal();

    expect(settleTicketAction).not.toHaveBeenCalled();
  });

  it('reçoit un numéro de ticket TPE facultatif, et l’envoie quand il est saisi', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: settlement(7800, 'card', 0, { terminalReference: 'A1B2C3' }),
    });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    await goToTerminal();

    await userEvent.type(screen.getByLabelText(/N° de ticket TPE/), 'A1B2C3');
    await userEvent.click(screen.getByRole('button', { name: 'Paiement accepté sur le TPE' }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(1);
    });

    const [, , body] = settleTicketAction.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).toEqual({
      method: 'CARD_TERMINAL',
      amountMinor: 7800,
      terminalReference: 'A1B2C3',
    });
  });

  it('règle sans référence quand le caissier n’a pas le ticket du terminal', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(7800, 'card', 0) });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    await goToTerminal();

    await userEvent.click(screen.getByRole('button', { name: 'Paiement accepté sur le TPE' }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(1);
    });

    const [, , body] = settleTicketAction.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).toEqual({ method: 'CARD_TERMINAL', amountMinor: 7800 });
  });

  it('refuse sur le champ une référence qui ressemble à un numéro de carte', async () => {
    // Le front borne la forme ; la clé de Luhn reste côté API, où le refus tombe
    // avant tout journal (payments-stripe §1).
    await goToTerminal();

    await userEvent.type(screen.getByLabelText(/N° de ticket TPE/), '4242 4242 4242 4242');
    await userEvent.click(screen.getByRole('button', { name: 'Paiement accepté sur le TPE' }));

    const alert = await screen.findByRole('alert');

    expect(alert.id).toBe('tpe-reference-erreur');
    expect(settleTicketAction).not.toHaveBeenCalled();
  });

  it('pose sur le champ le 400 que l’API oppose à la référence — #1025, critère 3', async () => {
    // Seize chiffres collés : **bien formés** pour l'écran — alphanumériques,
    // sous 32 caractères — et refusés par l'API sur la clé de Luhn, qui ne vit
    // que là. C'est le seul chemin par lequel ce 400 arrive jusqu'ici, et c'est
    // celui qui tombait en bloc sous le bouton, avec « La requête est
    // invalide. » pour toute explication.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'La requête est invalide.',
      details: {
        violations: [
          'terminalReference : ce champ n’est pas celui d’un numéro de carte — saisir le numéro du ticket du terminal',
        ],
      },
    });
    await goToTerminal();

    await userEvent.type(screen.getByLabelText(/N° de ticket TPE/), '4242424242424242');
    await userEvent.click(screen.getByRole('button', { name: 'Paiement accepté sur le TPE' }));

    // Un seul message, et il est **sur le champ** : même identifiant que celui
    // qu'`aria-describedby` désigne, et `aria-invalid` posé sur la saisie.
    const alerts = await screen.findAllByRole('alert');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.id).toBe('tpe-reference-erreur');
    expect(screen.getByLabelText(/N° de ticket TPE/).getAttribute('aria-invalid')).toBe('true');
    // Le texte est celui du catalogue, dans la langue de l'écran — jamais le
    // message de l'API, qui n'est traduit nulle part (web-frontend §2).
    expect(screen.queryByText('La requête est invalide.')).toBeNull();
    expect(alerts[0]?.textContent).toMatch(/numéro de ticket TPE a été refusé/i);
  });

  it('désactive l’acceptation TPE dès le premier clic — #1025, critère 4', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockReturnValue(new Promise(() => undefined));
    await goToTerminal();

    const accept = screen.getByRole('button', { name: 'Paiement accepté sur le TPE' });
    await userEvent.click(accept);

    await waitFor(() => {
      expect(accept).toHaveProperty('disabled', true);
    });
    await userEvent.click(accept);

    expect(settleTicketAction).toHaveBeenCalledTimes(1);
  });

  it('ramène au choix du moyen sur « Paiement refusé », sans rien enregistrer', async () => {
    // Deuxième critère de #835, dernier point : rien n'est parti chez nous, il
    // n'y a donc rien à inscrire ni à annuler.
    await goToTerminal();

    await userEvent.click(screen.getByRole('button', { name: 'Paiement refusé' }));

    expect(settleTicketAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect((await screen.findByRole('alert')).textContent).toMatch(/refusé sur le terminal/i);
  });
});

describe('le règlement mixte — quatrième critère de #835', () => {
  it('affiche le reste dû après une part, puis solde le ticket', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValueOnce({
      ok: true,
      data: settlement(5000, 'cash', 2800),
    });
    settleTicketAction.mockResolvedValueOnce({
      ok: true,
      data: settlement(2800, 'card', 0, { terminalReference: 'A1B2C3' }),
    });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    // 50,00 € en espèces.
    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    // Le reste dû est celui du serveur, et il est écrit à l'écran.
    expect(await screen.findByText('Reste dû')).toBeDefined();
    expect(screen.getAllByText(/28,00/).length).toBeGreaterThan(0);
    // Et le règlement déjà pris reste visible.
    expect(screen.getByText('Règlements enregistrés')).toBeDefined();
    expect(screen.getAllByText(/50,00/).length).toBeGreaterThan(0);

    // 28,00 € au TPE.
    await userEvent.click(screen.getByRole('radio', { name: /Carte bancaire \(TPE\)/ }));
    await userEvent.click(screen.getByRole('button', { name: /au TPE/ }));
    await userEvent.type(screen.getByLabelText(/N° de ticket TPE/), 'A1B2C3');
    await userEvent.click(screen.getByRole('button', { name: 'Paiement accepté sur le TPE' }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(2);
    });

    const [, , first] = settleTicketAction.mock.calls[0] as [string, string, Record<string, unknown>];
    const [, , second] = settleTicketAction.mock.calls[1] as [
      string,
      string,
      Record<string, unknown>,
    ];

    expect(first).toEqual({ method: 'CASH', amountMinor: 5000 });
    expect(second).toEqual({
      method: 'CARD_TERMINAL',
      amountMinor: 2800,
      terminalReference: 'A1B2C3',
    });
    // Un seul ticket pour les deux règlements : c'est la pièce que le reçu
    // imprimera, avec ses deux lignes.
    expect(openCheckoutTicketAction).toHaveBeenCalledTimes(1);
  });

  it('donne une clé d’idempotence différente à chaque geste', async () => {
    // Même clé sur deux gestes, et le second serait rendu comme une répétition
    // du premier : 28,00 € disparaîtraient du rapprochement.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValueOnce({ ok: true, data: settlement(5000, 'cash', 2800) });
    settleTicketAction.mockResolvedValueOnce({ ok: true, data: settlement(2800, 'cash', 0) });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await screen.findByText('Reste dû');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(2);
    });

    const keys = settleTicketAction.mock.calls.map((call) => call[3] as string);
    expect(new Set(keys).size).toBe(2);
  });

  it('refuse sur le champ une part supérieure au reste dû', async () => {
    renderPanel('confirmed', null, sale(5000));

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    const alert = await screen.findByRole('alert');

    expect(alert.id).toBe('montant-regle-erreur');
    expect(alert.textContent).toMatch(/28,00/);
    expect(settleTicketAction).not.toHaveBeenCalled();
  });

  it('reprend le ticket ouvert que la page a retrouvé, sans en composer un second', async () => {
    // C'est ce qui rend le règlement mixte survivable à un rafraîchissement :
    // sans cette reprise, le second geste ouvrirait une seconde pièce et le
    // reste dû de la première resterait en l'air.
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(2800, 'cash', 0) });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel('confirmed', null, sale(5000));

    expect(screen.getByText('Reste dû')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(1);
    });
    expect(openCheckoutTicketAction).not.toHaveBeenCalled();
  });
});

describe('la clé d’idempotence est celle du geste — #1025, critère 2', () => {
  it('rejoue la **même** clé quand le premier essai n’a pas abouti', async () => {
    // Le cœur du critère : la clé est engendrée au **montage du geste**, pas au
    // clic. Engendrée au clic, le second essai en porterait une neuve, l'API
    // n'aurait aucun moyen de le reconnaître pour une répétition, et deux
    // règlements de 78,00 € seraient inscrits là où la cliente n'a payé
    // qu'une fois. Un réseau qui tombe entre le clic et la réponse suffit à
    // produire ce second essai — et c'est le cas ordinaire d'un poste de
    // comptoir, pas un cas limite.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockRejectedValueOnce(new Error('Failed to fetch'));
    settleTicketAction.mockResolvedValueOnce({
      ok: true,
      data: { ...settlement(7800, 'cash', 0), replayed: true },
    });
    loadReceiptAction.mockResolvedValue({ ok: false, code: 'X', message: 'x' });
    renderPanel();

    const button = screen.getByRole('button', { name: CASH_BUTTON });
    await userEvent.click(button);

    expect((await screen.findByRole('alert')).textContent).toMatch(/n’a pas répondu/);
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
    await userEvent.click(button);

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(2);
    });

    const keys = settleTicketAction.mock.calls.map((call) => call[3] as string);

    expect(keys[0]).toBe(keys[1]);
    // Et le ticket n'a été composé qu'une fois : le second essai vise la même
    // pièce, sans quoi la clé rejouée ne désignerait rien.
    expect(openCheckoutTicketAction).toHaveBeenCalledTimes(1);
  });
});

describe('une soumission rejouée — #1025, critère 6', () => {
  it('rend le même état, sans compter le règlement deux fois', async () => {
    // `replayed: true` veut dire « l'API a reconnu la clé et n'a rien écrit ».
    // L'écran doit donc montrer exactement ce qu'il montrerait si le premier
    // essai avait abouti : un règlement de 50,00 €, 28,00 € de reste dû — et
    // non deux lignes, ni un reste dû rogné une seconde fois.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: { ...settlement(5000, 'cash', 2800), replayed: true },
    });
    renderPanel();

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    const settlements = await screen.findByRole('list', {
      name: /Règlements déjà enregistrés/,
    });

    expect(within(settlements).getAllByRole('listitem')).toHaveLength(1);
    // Les montants sont ceux que le serveur rend, et il les rend inchangés.
    expect(screen.getByText('Reste dû')).toBeDefined();
    expect(screen.getAllByText(/28,00/).length).toBeGreaterThan(0);
  });

  it('dit que rien n’a été encaissé une seconde fois, sans annoncer un second débit', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({
      ok: true,
      data: { ...settlement(5000, 'cash', 2800), replayed: true },
    });
    renderPanel();

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    // L'annonce est un `status` et non une alerte : rien n'a échoué, et la
    // répétition n'appelle aucun geste de l'opérateur.
    const notice = await screen.findByText(/Soumission rejouée/);

    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toMatch(/Rien n’a été encaissé une seconde fois/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('n’annonce plus la répétition au règlement suivant', async () => {
    // L'annonce porte sur **ce** geste. La laisser à l'écran ferait lire au
    // comptoir qu'un règlement neuf est une répétition — et douter de ce qui a
    // réellement été pris.
    //
    // Le second règlement laisse un reste dû, et ce n'est pas un détail : un
    // ticket soldé fait basculer le panneau sur le reçu, où l'annonce n'est de
    // toute façon plus rendue. Le cas serait alors vrai sans que l'écran ait
    // rien oublié — et resterait vert si la mention devenait collante.
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValueOnce({
      ok: true,
      data: { ...settlement(5000, 'cash', 2800), replayed: true },
    });
    settleTicketAction.mockResolvedValueOnce({
      ok: true,
      data: settlement(1400, 'cash', 1400),
    });
    renderPanel();

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await screen.findByText(/Soumission rejouée/);
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    await waitFor(() => {
      expect(settleTicketAction).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/Soumission rejouée/)).toBeNull();
  });
});

describe('un rendez-vous déjà réglé (#828)', () => {
  const SETTLED: SettlementState = { kind: 'regle', payment: CASH_TRANSACTION };

  it('n’offre plus aucun encaissement — ni moyen, ni bouton', () => {
    renderPanel('completed', SETTLED);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Encaisser/ })).toBeNull();
  });

  it('annonce le règlement avant le clic — moyen, montant et instant', () => {
    renderPanel('completed', SETTLED);

    expect(screen.getByText(/Réglé en espèces/)).toBeDefined();
    expect(screen.getByText(/78,00/)).toBeDefined();
    expect(screen.getByText(/Encaissement inscrit le/)).toBeDefined();
  });

  it('ferme le comptoir tant qu’une intention en ligne n’est pas conclue', () => {
    renderPanel('confirmed', { kind: 'ouvert', payment: CASH_TRANSACTION });

    expect(screen.getByText(/en ligne/)).toBeDefined();
    expect(screen.queryByRole('button', { name: CASH_BUTTON })).toBeNull();
  });

  it('laisse l’écran intact quand l’historique n’a pas répondu', () => {
    // `null` n'est pas « rien n'est réglé » : la route est au seuil `MANAGER`, et
    // un comptoir doit pouvoir encaisser malgré tout.
    renderPanel('confirmed', null);

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('button', { name: CASH_BUTTON })).toBeDefined();
  });
});

describe('le ticket de caisse de la vente (#818)', () => {
  const RECEIPT = {
    saleId: SALE_ID,
    number: 'TIC-2026-000123',
    sequence: 123,
    issuedAt: '2026-09-05T07:05:00.000Z',
    openedAt: '2026-09-05T07:04:00.000Z',
    timezone: TIMEZONE,
    issuer: {
      name: 'Maison Lotus',
      legalName: 'LOTUS BIEN-ÊTRE SARL',
      legalIdType: 'SIRET' as const,
      legalId: '73282932000074',
      vatNumber: 'FR44732829320',
      address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
      contactPhone: '+33123456789',
      footer: 'Ni repris ni échangé.',
    },
    cashier: { displayName: 'Hasina R.' },
    client: { displayName: 'Rina Andriamana' },
    practitioner: { displayName: 'Hasina' },
    lines: [
      {
        position: 0,
        kind: 'SERVICE' as const,
        label: 'Massage suédois',
        quantity: 1,
        unitPrice: { amountMinor: 7800, currency: 'EUR' },
        total: { amountMinor: 7800, currency: 'EUR' },
      },
    ],
    taxBreakdown: [],
    subtotal: { amountMinor: 7800, currency: 'EUR' },
    taxTotal: { amountMinor: 0, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 7800, currency: 'EUR' },
    settlements: [
      {
        method: 'CASH' as const,
        amount: { amountMinor: 5000, currency: 'EUR' },
        capturedAt: '2026-09-05T07:05:00.000Z',
      },
      {
        method: 'CARD' as const,
        amount: { amountMinor: 2800, currency: 'EUR' },
        capturedAt: '2026-09-05T07:06:00.000Z',
      },
    ],
    refunds: [],
  };

  async function settleToTheEnd(): Promise<void> {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(7800, 'cash', 0) });
    loadReceiptAction.mockResolvedValue({ ok: true, data: RECEIPT });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));
  }

  it('affiche la pièce de l’API et **tous** ses règlements', async () => {
    // Quatrième critère de #835, dernier point : « le ticket les liste tous ».
    await settleToTheEnd();

    const ticket = await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });

    expect(loadReceiptAction).toHaveBeenCalledWith(SLUG, SALE_ID);
    expect(ticket.textContent).toContain('Maison Lotus');
    expect(ticket.textContent).toContain('50,00');
    expect(ticket.textContent).toContain('28,00');
  });

  it('rend un reçu définitif — il n’y a plus de tiers à attendre', async () => {
    await settleToTheEnd();

    expect(await screen.findByText(/Encaissement enregistré/)).toBeDefined();
    expect(screen.queryByText(/provisoire/i)).toBeNull();
    expect(screen.queryByText(/webhook/i)).toBeNull();
  });

  it('redemande le rendu serveur une fois le ticket soldé', async () => {
    await settleToTheEnd();

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('ne redemande rien tant qu’il reste dû', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(5000, 'cash', 2800) });
    renderPanel();

    await userEvent.click(screen.getByLabelText(/Régler une partie/));
    await userEvent.type(screen.getByLabelText(/Montant de ce règlement/), '50,00');
    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));

    expect(await screen.findByText('Reste dû')).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ouvre les deux PDF de l’API — rouleau 80 mm et facture A4', async () => {
    await settleToTheEnd();
    await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });

    expect(screen.getByRole('link', { name: 'PDF ticket' }).getAttribute('href')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=ticket-80`,
    );
    expect(screen.getByRole('link', { name: 'Facture A4' }).getAttribute('href')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=a4`,
    );
  });

  it('dit que le ticket est indisponible, et laisse réessayer', async () => {
    openCheckoutTicketAction.mockResolvedValue({ ok: true, data: sale() });
    settleTicketAction.mockResolvedValue({ ok: true, data: settlement(7800, 'cash', 0) });
    loadReceiptAction.mockResolvedValueOnce({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Le service est momentanément injoignable.',
    });
    loadReceiptAction.mockResolvedValueOnce({ ok: true, data: RECEIPT });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: CASH_BUTTON }));
    expect(await screen.findByText('Ticket indisponible')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(
      await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' }),
    ).toBeDefined();
  });
});
