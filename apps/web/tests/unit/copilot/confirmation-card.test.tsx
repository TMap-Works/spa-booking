import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmationCard } from '@/components/copilot/confirmation-card';
import messages from '@/messages/fr/copilot.json';

/**
 * La carte de confirmation (P3-01) : elle n'envoie que l'identifiant et la
 * décision, une seule fois, et annonce le résultat.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard() {
  render(
    <NextIntlClientProvider locale="fr" messages={{ copilot: messages }}>
      <ConfirmationCard
        runtimeUrl="/salon-lea/compte/copilot"
        id="11111111-2222-4333-8444-555555555555"
        titre="Annuler le massage de jeudi"
        lignes={['Jeudi 22 octobre, 14 h 00']}
      />
    </NextIntlClientProvider>,
  );
  return userEvent.setup();
}

describe('ConfirmationCard', () => {
  it('valide une seule fois, puis annonce le résultat', async () => {
    const fetchMock = vi.fn(async () => Response.json({ statut: 'faite', message: 'Rendez-vous annulé.' }));
    vi.stubGlobal('fetch', fetchMock);
    const user = renderCard();

    expect(screen.getByText('Annuler le massage de jeudi')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Valider' }));

    expect(await screen.findByText('Rendez-vous annulé.')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/salon-lea/compte/copilot/ecritures/11111111-2222-4333-8444-555555555555', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'valider' }),
    });
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull();
  });

  it('refuse sans rien changer', async () => {
    const fetchMock = vi.fn(async () => Response.json({ statut: 'refusee', message: "C'est noté, je n'ai rien changé." }));
    vi.stubGlobal('fetch', fetchMock);
    const user = renderCard();

    await user.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(await screen.findByText("C'est noté, je n'ai rien changé.")).toBeDefined();
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      decision: 'refuser',
    });
  });
});
