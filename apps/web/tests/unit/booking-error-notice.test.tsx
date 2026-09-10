import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookingErrorNotice, visitorErrorMessage } from '@/app/(booking)/[tenantSlug]/booking-error-notice';
import { ApiClientError, fetchPublicTenant } from '@/lib/api-client';

/**
 * L'encart d'erreur du parcours client, et la phrase qu'il ne doit dire qu'une
 * fois (#601).
 *
 * Ce qui est éprouvé ici est exactement le défaut relevé : le visiteur lisait
 * « … Merci de réessayer dans un instant. Merci de réessayer dans un instant. »,
 * parce que la page concaténait une invitation à un message qui la portait déjà.
 * La règle retenue est que **le message est une phrase complète et que l'écran
 * n'y ajoute rien** ; ces tests la tiennent sur ses deux branches — l'erreur
 * d'API, et le repli quand l'erreur n'en est pas une.
 */

afterEach(() => {
  cleanup();
  // `restoreMocks` de la configuration ne défait pas un `stubGlobal` : sans
  // ceci, le `fetch` bouchonné du dernier cas survivrait aux suites voisines.
  vi.unstubAllGlobals();
});

const INVITATION = 'Merci de réessayer dans un instant.';

/** Nombre de fois que l'invitation apparaît dans le texte rendu. */
function invitationCount(text: string): number {
  return text.split(INVITATION).length - 1;
}

describe('BookingErrorNotice', () => {
  it("n'invite à réessayer qu'une seule fois sur une erreur d'API", () => {
    const error = new ApiClientError(
      'SERVICE_UNAVAILABLE',
      `Le service de réservation est momentanément injoignable. ${INVITATION}`,
      503,
    );

    const { container } = render(
      <BookingErrorNotice title="La page de réservation n’a pas pu être chargée" error={error} />,
    );

    expect(invitationCount(container.textContent ?? '')).toBe(1);
    expect(
      screen.getByText(`Le service de réservation est momentanément injoignable. ${INVITATION}`),
    ).toBeDefined();
  });

  it("invite à réessayer une fois — et une seule — sur le repli", () => {
    const { container } = render(
      <BookingErrorNotice
        title="La page du salon n’a pas pu être chargée"
        error={new TypeError('Cannot read properties of undefined')}
      />,
    );

    // Le repli n'a pas de message affichable : c'est celui de l'écran qui porte
    // l'invitation, sans quoi la règle rendrait un encart sans issue proposée.
    expect(invitationCount(container.textContent ?? '')).toBe(1);
    expect(screen.getByText(`Une erreur inattendue est survenue. ${INVITATION}`)).toBeDefined();
  });

  it("ne laisse pas fuiter le détail technique de l'erreur au visiteur", () => {
    const { container } = render(
      <BookingErrorNotice
        title="La page du salon n’a pas pu être chargée"
        error={new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:3001')}
      />,
    );

    expect(container.textContent).not.toContain('ECONNREFUSED');
  });

  it('rend le titre annoncé, avec le rôle qui interrompt un lecteur d’écran', () => {
    render(<BookingErrorNotice title="La page du salon n’a pas pu être chargée" error={new Error('x')} />);

    expect(screen.getByRole('alert').textContent).toContain(
      'La page du salon n’a pas pu être chargée',
    );
  });

  it("ne double pas l'invitation sur l'erreur que produit réellement une API injoignable", async () => {
    // Le cas du ticket, bout à bout : `fetch` qui échoue — l'API éteinte, ou
    // `API_URL` sur un port fermé — puis l'encart rendu sur l'erreur obtenue.
    // C'est ce chaînage-là qui répétait la phrase, pas l'un ou l'autre bout.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const error = await fetchPublicTenant('salon-lotus').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);

    const { container } = render(
      <BookingErrorNotice title="La page de réservation n’a pas pu être chargée" error={error} />,
    );

    expect(invitationCount(container.textContent ?? '')).toBe(1);
  });
});

describe('visitorErrorMessage', () => {
  it("rend le message de l'API tel quel, sans rien y ajouter", () => {
    const message = 'Le service de réservation est momentanément injoignable.';

    expect(visitorErrorMessage(new ApiClientError('SERVICE_UNAVAILABLE', message, 503))).toBe(
      message,
    );
  });

  it('substitue une phrase complète à ce qui n’est pas une erreur d’API', () => {
    expect(visitorErrorMessage('une chaîne jetée telle quelle')).toBe(
      `Une erreur inattendue est survenue. ${INVITATION}`,
    );
  });
});
