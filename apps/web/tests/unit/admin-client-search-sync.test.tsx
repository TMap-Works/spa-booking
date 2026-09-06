import { CUSTOMER_SEARCH_MAX_LENGTH } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientSearchForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-search-form';

/*
 * La resynchronisation du champ de recherche du fichier client sur l'URL (#480,
 * troisième critère).
 *
 * ## Ce qui se vérifie ici, et qu'aucune lecture du JSX ne montre
 *
 * `useState(term)` ne lit sa valeur qu'au montage, et un « retour » du
 * navigateur ne remonte pas le composant. Le champ gardait donc la saisie
 * précédente pendant que la liste, rendue par le serveur, était revenue à l'état
 * de l'URL — deux volets du même écran qui disent deux choses différentes.
 *
 * L'autre moitié du critère est la contrainte : la réparation ne doit pas voler
 * le focus. C'est elle qui interdit la correction la plus courte — une
 * `key={term}` qui remonterait le formulaire —, et c'est donc elle qu'une suite
 * doit tenir, sans quoi la prochaine réécriture la reperdrait sans le voir.
 *
 * ## Pourquoi un fichier à part
 *
 * Plutôt qu'allongé dans `admin-client-forms.test.tsx`, pour la raison qui a
 * fait naître `clients/paths.ts` à côté de `admin/paths.ts` : plusieurs branches
 * du jalon avancent en parallèle, et deux fichiers qui grandissent chacun de
 * leur côté fusionnent — un seul que deux branches allongent au même endroit,
 * non.
 */

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const HINT = 'Nom, téléphone ou e-mail.';

afterEach(() => {
  cleanup();
  push.mockReset();
});

/** Le champ, tel que l'opérateur le voit. */
const field = (): HTMLInputElement =>
  screen.getByLabelText(/rechercher un client/i) as HTMLInputElement;

describe('le champ de recherche suit l’URL', () => {
  it('revient au terme de l’URL quand le navigateur remonte l’historique', async () => {
    const { rerender } = render(
      <ClientSearchForm tenantSlug="maison-lotus" term="rako" hint={HINT} />,
    );

    await userEvent.clear(field());
    await userEvent.type(field(), 'randria');
    expect(field().value).toBe('randria');

    // Le « précédent » : la page est rejouée avec l'URL nue, le composant n'est
    // pas remonté — c'est exactement ce que fait le routeur de Next.
    rerender(<ClientSearchForm tenantSlug="maison-lotus" term="" hint={HINT} />);

    expect(field().value).toBe('');
  });

  it('suit aussi un « suivant » qui repose un terme', async () => {
    const { rerender } = render(
      <ClientSearchForm tenantSlug="maison-lotus" term="" hint={HINT} />,
    );

    await userEvent.type(field(), 'randria');
    rerender(<ClientSearchForm tenantSlug="maison-lotus" term="rako" hint={HINT} />);

    expect(field().value).toBe('rako');
  });

  it('ne vole pas le focus à l’opérateur en train de taper', async () => {
    const { rerender } = render(
      <ClientSearchForm tenantSlug="maison-lotus" term="rako" hint={HINT} />,
    );

    await userEvent.click(field());
    expect(document.activeElement).toBe(field());

    rerender(<ClientSearchForm tenantSlug="maison-lotus" term="" hint={HINT} />);

    // Une `key={term}` aurait remonté le formulaire, et le champ aurait perdu
    // le focus au milieu d'un appel téléphonique.
    expect(document.activeElement).toBe(field());
  });

  it('laisse la saisie intacte tant que l’URL ne bouge pas', async () => {
    const { rerender } = render(
      <ClientSearchForm tenantSlug="maison-lotus" term="rako" hint={HINT} />,
    );

    await userEvent.clear(field());
    await userEvent.type(field(), 'randria');

    // Un nouveau rendu qui ne change pas le terme — le compteur de résultats
    // sous le champ, par exemple — ne doit rien effacer.
    rerender(
      <ClientSearchForm tenantSlug="maison-lotus" term="rako" hint="1 fiche pour « rako »." />,
    );

    expect(field().value).toBe('randria');
  });

  it('retire le refus de la borne quand l’URL remplace la saisie fautive', async () => {
    const { rerender } = render(
      <ClientSearchForm tenantSlug="maison-lotus" term="" hint={HINT} />,
    );

    await userEvent.type(field(), 'r');
    await userEvent.click(screen.getByRole('button', { name: /rechercher/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/au moins 2 caractères/i);
    expect(push).not.toHaveBeenCalled();

    rerender(<ClientSearchForm tenantSlug="maison-lotus" term="rako" hint={HINT} />);

    // Le message accusait une saisie qui n'est plus là.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field().value).toBe('rako');
  });

  it('refuse un terme plus long que le contrat plutôt que de l’envoyer', async () => {
    // La resynchronisation rend cette borne indispensable : au-delà de la borne
    // haute, `parseSearchTerm` rejette le terme, la page rend le fichier entier
    // et le champ — remis à l'URL — effacerait la saisie sans rien expliquer.
    render(<ClientSearchForm tenantSlug="maison-lotus" term="" hint={HINT} />);

    const tooLong = 'r'.repeat(CUSTOMER_SEARCH_MAX_LENGTH + 1);

    await userEvent.click(field());
    await userEvent.paste(tooLong);
    await userEvent.click(screen.getByRole('button', { name: /rechercher/i }));

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(
      new RegExp(String(CUSTOMER_SEARCH_MAX_LENGTH)),
    );
    // La saisie reste sous les yeux de l'opérateur : c'est elle qu'il corrige.
    expect(field().value).toBe(tooLong);
  });
});
