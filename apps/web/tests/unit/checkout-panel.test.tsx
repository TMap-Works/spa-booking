import type { Appointment, AppointmentStatus } from '@spa/shared';
import { cleanup, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';
import type { SettlementState } from '@/lib/admin/checkout-summary';

/**
 * Le panneau d'encaissement tel qu'il se manipule (#59, critères 2, 3, 4 et 5).
 *
 * Les actions serveur sont doublées : ce qui est exercé ici est **l'écran** —
 * les moyens offerts, la protection du double clic, ce que le reçu affirme —,
 * pas le transport. Le transport a sa recette, et l'API a la sienne.
 *
 * Le SDK de Stripe est doublé lui aussi, et pour une raison qui n'est pas
 * seulement pratique : la vraie implémentation charge un script depuis
 * `js.stripe.com`, précisément parce que les champs carte ne doivent jamais
 * appartenir à notre DOM. Il n'y a donc rien à monter dans jsdom, et c'est le
 * signe que la frontière PCI tient.
 */

const settleInCashAction = vi.fn();
const openCardPaymentAction = vi.fn();
const loadReceiptAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const confirmPayment = vi.fn();
const mount = vi.fn();
const destroy = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  settleInCashAction: (...args: unknown[]) => settleInCashAction(...args),
  openCardPaymentAction: (...args: unknown[]) => openCardPaymentAction(...args),
  loadReceiptAction: (...args: unknown[]) => loadReceiptAction(...args),
}));

// Le panneau part vers la route de renouvellement sur une session expirée
// (#856), et redemande le rendu serveur quand la journée de caisse change
// (#1004) : le routeur est doublé pour observer l'un et l'autre.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace }),
}));

// Le module réel est conservé et seul `loadStripeSdk` est doublé : le
// formulaire de carte importe aussi `StripeLoadError` — une **valeur**, dont il
// se sert pour classer un échec de chargement — et une doublure qui ne
// l'exporterait pas ferait échouer l'accès plutôt que le chargement (#850).
vi.mock('@/lib/admin/payment-stripe', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/admin/payment-stripe')>(
      '@/lib/admin/payment-stripe',
    );

  return {
    ...actual,
    loadStripeSdk: () =>
      Promise.resolve({
        elements: () => ({ create: () => ({ mount, unmount: vi.fn(), destroy }) }),
        confirmPayment: (...args: unknown[]) => confirmPayment(...args),
      }),
  };
});

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';
const APPOINTMENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function appointment(status: AppointmentStatus = 'confirmed'): Appointment {
  return {
    id: APPOINTMENT_ID,
    reference: 'RDV-8F3K-27',
    status,
    client: { id: 'cccccccc-0000-4000-8000-000000000002', firstName: 'Rina', lastName: 'Andriamana' },
    staff: { id: 'dddddddd-0000-4000-8000-000000000003', displayName: 'Hasina' },
    service: {
      id: 'eeeeeeee-0000-4000-8000-000000000004',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: '2026-09-05T06:00:00.000Z',
    endsAt: '2026-09-05T07:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-09-01T08:00:00.000Z',
  };
}

function panel(
  status: AppointmentStatus = 'confirmed',
  settlement: SettlementState | null = null,
): ReactElement {
  return (
    <CheckoutPanel
      appointment={appointment(status)}
      settlement={settlement}
      tenantSlug={SLUG}
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
  settlement: SettlementState | null = null,
): RenderResult {
  return render(panel(status, settlement));
}

const CASH_TRANSACTION = {
  id: 'ffffffff-0000-4000-8000-000000000005',
  appointmentId: APPOINTMENT_ID,
  amount: { amountMinor: 3500, currency: 'EUR' },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'cash' as const,
  status: 'succeeded' as const,
  capturedAt: '2026-09-05T07:05:00.000Z',
  createdAt: '2026-09-05T07:05:00.000Z',
};

afterEach(() => {
  cleanup();
  settleInCashAction.mockReset();
  openCardPaymentAction.mockReset();
  loadReceiptAction.mockReset();
  confirmPayment.mockReset();
  refresh.mockReset();
  mount.mockReset();
  destroy.mockReset();
});

describe('le choix du moyen de paiement', () => {
  it('offre les espèces et la carte, et rien qui suppose un lecteur absent', () => {
    renderPanel();

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Espèces/ })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Carte/ })).toBeDefined();
  });

  it('n’offre nulle part où saisir un numéro de carte', () => {
    // La preuve la plus solide de la frontière PCI : il n'y a aucun champ de
    // saisie sur ce panneau, hors les deux boutons radio du moyen de paiement.
    renderPanel();

    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('type')).toBe('radio');
    }
  });

  it('ferme la carte sur un rendez-vous honoré, et dit ce qu’il reste à faire', () => {
    renderPanel('completed');

    expect(screen.getByRole('radio', { name: /Carte/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /Espèces/ })).toHaveProperty('disabled', false);
  });

  it('n’encaisse rien sur un rendez-vous annulé', () => {
    renderPanel('cancelled');

    expect(screen.getByText('Rien à encaisser')).toBeDefined();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});

describe('un rendez-vous déjà réglé (#828)', () => {
  const SETTLED_BY_CARD: SettlementState = {
    kind: 'regle',
    payment: { ...CASH_TRANSACTION, method: 'card' },
  };

  it('n’offre plus aucun encaissement — ni moyen, ni bouton', () => {
    // L'écran ouvrait ce rendez-vous avec « À encaisser », ses deux moyens et un
    // bouton actif ; le refus n'arrivait qu'après le clic, en 409.
    renderPanel('completed', SETTLED_BY_CARD);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Encaisser/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Payer/ })).toBeNull();
  });

  it('annonce le règlement avant le clic — moyen, montant et instant', () => {
    renderPanel('completed', SETTLED_BY_CARD);

    expect(screen.getByText(/Réglé par carte/)).toBeDefined();
    expect(screen.getByText(/35,00/)).toBeDefined();
    expect(screen.getByText(/Encaissement inscrit le/)).toBeDefined();
  });

  it('propose de réimprimer le ticket, et ce reçu-là n’est pas provisoire', async () => {
    // Le webhook signé a écrit la ligne qu'on vient de relire : la réimpression
    // est définitive, là où le reçu imprimé sur la réponse du navigateur ne
    // l'était pas (payments-stripe §2).
    renderPanel('completed', SETTLED_BY_CARD);

    await userEvent.click(screen.getByRole('button', { name: 'Réimprimer le ticket' }));

    expect(await screen.findByText(/Encaissement enregistré/)).toBeDefined();
    expect(screen.getByText(/définitif/i)).toBeDefined();
    expect(screen.queryByText(/pas de capture/i)).toBeNull();
  });

  it('écrit le remboursement sur le ticket réimprimé, jamais la somme entière', async () => {
    // Le ticket se remet en main propre : lui faire affirmer « Total 35,00 € »
    // sur un encaissement que le prestataire a rendu contredirait le bandeau
    // au-dessus, qui annonce déjà le remboursement (#63).
    renderPanel('completed', {
      kind: 'regle',
      payment: {
        ...CASH_TRANSACTION,
        method: 'card',
        status: 'refunded',
        refunded: { amountMinor: 3500, currency: 'EUR' },
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Réimprimer le ticket' }));

    expect(await screen.findByText('Remboursé')).toBeDefined();
    expect(screen.getByText('Reste acquis')).toBeDefined();
    // « Total » ne subsiste que comme en-tête de la colonne des lignes ; la
    // ligne des totaux, elle, ne l'écrit plus.
    expect(screen.queryByText('Total', { selector: 'span' })).toBeNull();
    expect(screen.getByText(/0,00/)).toBeDefined();
  });

  it('ferme les espèces et présélectionne la carte quand une intention court', () => {
    // `replayOrRefuse` refuse les espèces tant qu'une intention carte existe :
    // ouvrir l'écran sur une case grisée ferait chercher la panne.
    renderPanel('confirmed', { kind: 'ouvert', payment: CASH_TRANSACTION });

    expect(screen.getByRole('radio', { name: /Espèces/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /Carte/ })).toHaveProperty('checked', true);
  });

  it('laisse l’écran intact quand l’historique n’a pas répondu', () => {
    // `null` n'est pas « rien n'est réglé » : la route est au seuil `MANAGER`, et
    // un comptoir `STAFF` doit pouvoir encaisser malgré tout.
    renderPanel('confirmed', null);

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /en espèces/ })).toBeDefined();
  });

  it('bascule l’écran sur le refus 409 au lieu de laisser le bouton actif', async () => {
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'PAYMENT_ALREADY_SETTLED',
      message: 'Already settled.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText('Rendez-vous déjà encaissé')).toBeDefined();
    expect(screen.queryByRole('button', { name: /en espèces/ })).toBeNull();
  });

  it('bascule aussi sur le ticket soldé, et n’affiche pas le message brut de l’API', async () => {
    // La reproduction exacte de l'audit `d20260917-2` (#1005) : second clic sur
    // un rendez-vous déjà réglé. La route rend 409 `SALE_ALREADY_SETTLED` depuis
    // qu'elle compose la vente avant de la régler (#817) ; l'écran laissait
    // passer ce code, affichait « Ce ticket a déjà été réglé. » en ligne rouge et
    // gardait son bouton recliquable — un second clic ne pouvait qu'échouer de la
    // même façon, devant la cliente.
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'SALE_ALREADY_SETTLED',
      message: 'Ce ticket a déjà été réglé.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText('Rendez-vous déjà encaissé')).toBeDefined();
    // Le bouton **et** le choix du moyen ont disparu : c'est un état de l'écran,
    // pas une ligne glissée entre les moyens de paiement et un bouton resté plein.
    expect(screen.queryByRole('button', { name: /en espèces/ })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // Et le texte est celui de l'écran, pas celui que l'API a rendu.
    expect(screen.queryByText('Ce ticket a déjà été réglé.')).toBeNull();
  });
});

describe('le règlement en espèces', () => {
  it('n’envoie que l’établissement et le rendez-vous — jamais un montant', async () => {
    // Le prix est celui figé à la réservation, relu en base : un montant envoyé
    // par l'écran serait un prix choisi par l'écran.
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    await waitFor(() => {
      expect(settleInCashAction).toHaveBeenCalledWith(SLUG, APPOINTMENT_ID);
    });
  });

  it('rend un reçu définitif — la caisse fait foi', async () => {
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText(/Encaissement enregistré/)).toBeDefined();
    expect(screen.getByText(/caisse qui fait foi/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Imprimer le ticket' })).toBeDefined();
  });

  it('dit que le passage en « honoré » n’est pas encore servi par l’API', async () => {
    // Un encaissement qui laisse le rendez-vous en `confirmed` doit s'expliquer
    // au comptoir, faute de quoi l'opérateur cherche l'erreur de son côté.
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByText(/honoré/)).toBeDefined();
  });

  it('désactive le bouton dès le premier clic — un double clic n’encaisse pas deux fois', async () => {
    settleInCashAction.mockReturnValue(new Promise(() => undefined));
    renderPanel();

    const button = screen.getByRole('button', { name: /en espèces/ });
    await userEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveProperty('disabled', true);
    });
    await userEvent.click(button);

    expect(settleInCashAction).toHaveBeenCalledTimes(1);
  });

  it('rend la main quand l’action serveur ne répond pas du tout', async () => {
    // Une action serveur ne rend un résultat que si elle aboutit : si le réseau
    // du poste tombe entre le clic et le POST, la promesse est **rejetée**. Sans
    // reprise, le bouton resterait grisé et muet, et il ne resterait qu'à
    // recharger la page devant la cliente.
    settleInCashAction.mockRejectedValue(new Error('Failed to fetch'));
    renderPanel();

    const button = screen.getByRole('button', { name: /en espèces/ });
    await userEvent.click(button);

    expect((await screen.findByRole('alert')).textContent).toMatch(/n’a pas répondu/);
    await waitFor(() => {
      expect(button).toHaveProperty('disabled', false);
    });
  });

  it('traduit le refus de l’API en une conduite, pas en un code', async () => {
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'PAYMENT_ALREADY_SETTLED',
      message: 'Already settled.',
    });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    const refusal = await screen.findByRole('alert');
    expect(refusal.textContent).toMatch(/déjà été encaissé/i);
    expect(refusal.textContent).not.toMatch(/Already settled/);
  });

  it('renouvelle une session expirée plutôt que de la dire — #856', async () => {
    replace.mockReset();
    settleInCashAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
    });
    renderPanel();

    const button = screen.getByRole('button', { name: /en espèces/ });
    await userEvent.click(button);

    // Rien n'a été encaissé : l'écran part se renouveler et revient sur la
    // page affichée, sans message de refus ni bouton resté grisé.
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toBe(
      `/${SLUG}/admin/session/refresh?next=${encodeURIComponent(
        `${globalThis.location.pathname}${globalThis.location.search}`,
      )}`,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /en espèces/ }).hasAttribute('disabled')).toBe(
        false,
      );
    });
  });
});

describe('le paiement par carte', () => {
  const INTENT = {
    paymentId: 'aaaaaaaa-0000-4000-8000-000000000009',
    appointmentId: APPOINTMENT_ID,
    amount: { amountMinor: 3500, currency: 'EUR' },
    status: 'pending' as const,
    // Volontairement écrit en clair et sans entropie : `gitleaks` lit
    // « clientSecret: … » comme une clé d'API et fait rougir la CI sur une valeur
    // qui *ressemble* à un laissez-passer Stripe, fût-elle inventée. Le schéma
    // n'attend qu'une chaîne non vide — la ressemblance ne prouvait rien.
    clientSecret: 'laissez-passer-de-recette',
    publishableKey: 'cle-publiable-de-recette',
  };

  async function openCard(): Promise<void> {
    openCardPaymentAction.mockResolvedValue({ ok: true, data: INTENT });
    renderPanel();

    await userEvent.click(screen.getByRole('radio', { name: /Carte/ }));
    await userEvent.click(screen.getByRole('button', { name: /par carte/ }));
  }

  it('monte l’élément de Stripe plutôt qu’un formulaire de carte à nous', async () => {
    await openCard();

    await waitFor(() => {
      expect(mount).toHaveBeenCalledTimes(1);
    });

    // Toujours aucun champ de saisie hors les radios : ce que Stripe monte est
    // une iframe servie par son domaine, pas un `<input>` de notre arbre.
    for (const field of document.querySelectorAll('input')) {
      expect(field.getAttribute('type')).toBe('radio');
    }
  });

  it('rend un reçu explicitement provisoire quand Stripe accepte', async () => {
    // Le navigateur n'a jamais autorité pour déclarer un paiement abouti : c'est
    // le webhook signé qui inscrit l'encaissement (payments-stripe §2).
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    await openCard();

    // Le bouton reste inerte tant que le SDK n'est pas prêt : confirmer sans lui
    // n'enverrait rien nulle part.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /par carte$/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: /par carte$/ }));

    expect(await screen.findByText('Paiement accepté par le prestataire')).toBeDefined();
    expect(screen.getByText(/pas de capture/i)).toBeDefined();

    // Et rien, sur ce reçu-là, ne prétend l'encaissement déjà inscrit : c'est le
    // webhook qui l'inscrit, et il n'est pas arrivé. Une note qui l'affirmerait
    // contredirait la ligne du dessus, sur le seul point qui ne se brouille pas.
    expect(screen.queryByText(/l’encaissement est bien inscrit/)).toBeNull();
  });

  it('affiche le refus de Stripe sans rien conclure', async () => {
    confirmPayment.mockResolvedValue({ error: { message: 'Votre carte a été refusée.' } });
    await openCard();

    // Le bouton reste inerte tant que le SDK n'est pas prêt : confirmer sans lui
    // n'enverrait rien nulle part.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /par carte$/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: /par carte$/ }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Votre carte a été refusée.',
    );
    expect(screen.queryByText(/Paiement accepté/)).toBeNull();
  });

  it('ne redemande aucun rendu serveur : seul le webhook inscrit la capture', async () => {
    // Le récapitulatif d'à côté dit « À encaisser », et c'est **vrai** tant que
    // le webhook signé n'a rien inscrit — le reçu d'en face s'annonce d'ailleurs
    // provisoire. Relire la journée de caisse ici ne ramènerait qu'une intention
    // `pending` et coûterait un aller-retour devant la cliente (#1004).
    confirmPayment.mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    await openCard();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /par carte$/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
    await userEvent.click(screen.getByRole('button', { name: /par carte$/ }));

    expect(await screen.findByText('Paiement accepté par le prestataire')).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});

/**
 * Le récapitulatif rendu côté serveur, après l'encaissement (#1004).
 *
 * L'écran se contredisait d'une moitié à l'autre : « Encaissement enregistré —
 * 65,00 € » à droite, « À encaisser 65,00 € » à gauche, et rien pour le
 * corriger sinon un rechargement complet. Le récapitulatif est un Server
 * Component, ce panneau ne peut pas le réécrire — il ne peut que **redemander
 * son rendu**.
 *
 * Ce que ces cas exercent est donc les deux moitiés du geste : le
 * rafraîchissement est-il demandé quand la journée de caisse a changé, et le
 * panneau tient-il bon quand le rendu revient ?
 */
describe('le récapitulatif rendu côté serveur, après l’encaissement (#1004)', () => {
  const SETTLED_IN_CASH: SettlementState = { kind: 'regle', payment: CASH_TRANSACTION };

  it('redemande le rendu serveur quand les espèces aboutissent', async () => {
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('garde le ticket à l’écran quand le rendu revient avec le règlement', async () => {
    // Le piège du correctif : le panneau sait déjà rendre un rendez-vous réglé —
    // un bandeau et un bouton « Réimprimer le ticket ». Si cet état-là l'emporte
    // sur le reçu qu'on vient de produire, le rafraîchissement escamote le
    // ticket au moment précis où l'opérateur le tend à sa cliente.
    settleInCashAction.mockResolvedValue({ ok: true, data: CASH_TRANSACTION });
    const { rerender } = renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));
    expect(await screen.findByText(/Encaissement enregistré/)).toBeDefined();

    // Ce que `router.refresh()` produit, vu d'ici : la page a relu la journée de
    // caisse, et ce panneau reçoit le règlement qu'il vient lui-même d'obtenir.
    rerender(panel('confirmed', SETTLED_IN_CASH));

    expect(screen.getByText(/Encaissement enregistré/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Imprimer le ticket' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Réimprimer le ticket' })).toBeNull();
  });

  it('ne redemande rien quand rien n’a été encaissé', async () => {
    // Un refus, une panne de réseau : la journée de caisse n'a pas bougé, et un
    // rafraîchissement ne ferait que coûter un aller-retour devant la cliente.
    settleInCashAction.mockRejectedValue(new Error('Failed to fetch'));
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['PAYMENT_ALREADY_SETTLED', 'SALE_ALREADY_SETTLED'])(
    'ne redemande rien sur le refus « déjà encaissé » non plus (%s)',
    async (code) => {
      // Le refus qu'un poste voisin provoque apprend, lui aussi, que la journée
      // de caisse a changé — mais relire la journée ne rendrait pas au comptoir
      // le ticket qu'il n'a pas produit, et coûterait un aller-retour devant la
      // cliente. L'écran bascule, il ne se recharge pas.
      //
      // `SALE_ALREADY_SETTLED` est ici pour la raison qui a motivé #1005 : le
      // classement vivait dans `lib/admin/checkout-summary.ts`, que #1004
      // laissait hors de son empreinte, et ce code-là — le seul que
      // `POST /payments/cash` rende vraiment depuis #817 — n'y était pas rangé.
      settleInCashAction.mockResolvedValue({
        ok: false,
        code,
        message: 'Already settled.',
      });
      renderPanel();

      await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));

      expect(await screen.findByText('Rendez-vous déjà encaissé')).toBeDefined();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});

describe('le ticket de caisse de la vente (#818)', () => {
  const SALE_ID = '99999999-0000-4000-8000-000000000009';
  const SOLD = { ...CASH_TRANSACTION, saleId: SALE_ID };
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
        unitPrice: { amountMinor: 3500, currency: 'EUR' },
        total: { amountMinor: 3500, currency: 'EUR' },
      },
      {
        position: 1,
        kind: 'TAX' as const,
        label: 'TVA 20 %',
        quantity: 1,
        unitPrice: { amountMinor: 583, currency: 'EUR' },
        total: { amountMinor: 583, currency: 'EUR' },
      },
    ],
    taxBreakdown: [
      {
        rateBps: 2000,
        base: { amountMinor: 2917, currency: 'EUR' },
        tax: { amountMinor: 583, currency: 'EUR' },
      },
    ],
    subtotal: { amountMinor: 2917, currency: 'EUR' },
    taxTotal: { amountMinor: 583, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 3500, currency: 'EUR' },
    settlements: [
      {
        method: 'CASH' as const,
        amount: { amountMinor: 3500, currency: 'EUR' },
        tendered: { amountMinor: 5000, currency: 'EUR' },
        change: { amountMinor: 1500, currency: 'EUR' },
        capturedAt: '2026-09-05T07:05:00.000Z',
      },
    ],
    refunds: [],
  };

  async function settleWithSale(): Promise<void> {
    settleInCashAction.mockResolvedValue({ ok: true, data: SOLD });
    loadReceiptAction.mockResolvedValue({ ok: true, data: RECEIPT });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));
  }

  it('affiche la pièce de l’API : salon, numéro, client, HT, TVA, TTC', async () => {
    await settleWithSale();

    const ticket = await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });

    expect(loadReceiptAction).toHaveBeenCalledWith(SLUG, SALE_ID);
    expect(ticket.textContent).toContain('Maison Lotus');
    expect(ticket.textContent).toContain('LOTUS BIEN-ÊTRE SARL');
    expect(ticket.textContent).toContain('SIRET 73282932000074');
    expect(ticket.textContent).toContain('Rina Andriamana');
    expect(ticket.textContent).toContain('Total HT');
    expect(ticket.textContent).toContain('Total TTC');
    expect(ticket.textContent).toContain('20 %');
    expect(ticket.textContent).toContain('Rendu');
    expect(ticket.textContent).toContain('Ni repris ni échangé.');
  });

  it('n’imprime pas la ligne de taxe parmi les articles — c’est une ventilation', async () => {
    await settleWithSale();

    await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });
    const items = screen.getByRole('table', { name: 'Articles' });

    expect(items.textContent).toContain('Massage suédois');
    expect(items.textContent).not.toContain('TVA 20 %');
  });

  it('imprime le ticket seul, et non la page', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await settleWithSale();
    await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });

    await userEvent.click(screen.getByRole('button', { name: 'Imprimer le ticket' }));

    expect(print).toHaveBeenCalledTimes(1);
    // La copie destinée à l'imprimante vit directement sous <body>, hors de la
    // page, et <html> porte l'attribut qui efface tout le reste à l'impression.
    const copy = document.body.querySelector(':scope > [data-print-ticket]');
    expect(copy?.textContent).toContain('TIC-2026-000123');
    expect(document.documentElement.getAttribute('data-printing')).toBe('ticket');

    window.dispatchEvent(new Event('afterprint'));
    expect(document.documentElement.hasAttribute('data-printing')).toBe(false);
    print.mockRestore();
  });

  it('ouvre les deux PDF de l’API — rouleau 80 mm et facture A4', async () => {
    await settleWithSale();
    await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' });

    expect(screen.getByRole('link', { name: 'PDF ticket' }).getAttribute('href')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=ticket-80`,
    );
    expect(screen.getByRole('link', { name: 'Facture A4' }).getAttribute('href')).toBe(
      `/${SLUG}/admin/encaissement/ticket/${SALE_ID}?format=a4`,
    );
  });

  it('dit que le ticket est indisponible, et laisse réessayer', async () => {
    settleInCashAction.mockResolvedValue({ ok: true, data: SOLD });
    loadReceiptAction.mockResolvedValueOnce({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Le service est momentanément injoignable.',
    });
    loadReceiptAction.mockResolvedValueOnce({ ok: true, data: RECEIPT });
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: /en espèces/ }));
    expect(await screen.findByText('Ticket indisponible')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(
      await screen.findByRole('article', { name: 'Ticket n° TIC-2026-000123' }),
    ).toBeDefined();
  });
});
