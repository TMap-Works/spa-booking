import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginForm } from '@/app/(account)/[tenantSlug]/compte/components/login-form';
import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';

/**
 * Le retour au tunnel après connexion, sur les deux écrans d'identité (#1087).
 *
 * Ce qui se joue ici est le premier critère d'acceptation — « ramène au tunnel,
 * à l'étape où la cliente l'avait quitté » — et le troisième, qui exige qu'un
 * retour hostile soit **ignoré au profit de `accountPath`**. L'arithmétique du
 * garde-fou est éprouvée à part (`account-return-path.test.ts`) ; ce qui
 * s'éprouve ici est que les deux formulaires s'en servent, et qu'ils se
 * passent le paramètre par leurs liens croisés.
 *
 * Que l'étape soit retrouvée est l'affaire du brouillon de `sessionStorage`, que
 * le retour ne touche pas : il pointe le tunnel **sans clé de progression**,
 * précisément pour que le brouillon ait le dernier mot (voir le commentaire de
 * `(booking)/…/reservation/page.tsx`).
 */

const loginAction = vi.fn();
const registerAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

/** L'adresse de l'écran, que chaque cas repose avant de rendre. */
let search = new URLSearchParams();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  loginAction: (...args: unknown[]) => loginAction(...args),
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  useSearchParams: () => search,
}));

const SLUG = 'maison-lotus';
const SALON = `/${SLUG}`;
const TUNNEL = `${SALON}/reservation`;
const ESPACE_CLIENT = `${SALON}/compte`;

beforeEach(() => {
  search = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  loginAction.mockReset();
  registerAction.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

function renderLogin(): void {
  render(<LoginForm tenantSlug={SLUG} notice={null} />);
}

function renderRegister(): void {
  render(<RegisterForm tenantSlug={SLUG} />);
}

async function seConnecte(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  loginAction.mockResolvedValue({ ok: true, data: { id: 'x' } });

  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  await user.type(screen.getByLabelText(/Mot de passe/), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: /Se connecter/ }));
}

async function creeSonCompte(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  registerAction.mockResolvedValue({ ok: true, data: { id: 'x' } });

  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  await user.type(screen.getByLabelText(/Mot de passe/), 'correct horse battery');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));
}

describe('connexion — retour au tunnel', () => {
  it('revient là d’où la cliente vient quand l’adresse le dit', async () => {
    search = new URLSearchParams({ retour: TUNNEL });
    const user = userEvent.setup();
    renderLogin();

    await seConnecte(user);

    expect(replace).toHaveBeenCalledWith(TUNNEL);
    // Le rendu de destination est fait côté serveur : sans ce rafraîchissement,
    // le tunnel redemanderait les coordonnées que le cookie de présence
    // connaît désormais (#1086).
    expect(refresh).toHaveBeenCalled();
  });

  it('dépose dans l’espace client quand rien ne dit d’où l’on vient', async () => {
    const user = userEvent.setup();
    renderLogin();

    await seConnecte(user);

    expect(replace).toHaveBeenCalledWith(ESPACE_CLIENT);
  });

  it.each([
    ['une URL absolue', 'https://exemple.test/piege'],
    ['une URL protocole-relative', '//exemple.test/piege'],
    ['un autre salon', '/autre-salon/reservation'],
    ['le préfixe qui piège', `${SALON}-bis/reservation`],
    ['un détour qui sort du site une fois résolu', `${SALON}/compte/../..//exemple.test`],
    ['l’écran de connexion lui-même, qui boucle', `${SALON}/compte/connexion`],
  ])('ignore %s au profit de l’espace client', async (_cas, hostile) => {
    search = new URLSearchParams({ retour: hostile });
    const user = userEvent.setup();
    renderLogin();

    await seConnecte(user);

    expect(replace).toHaveBeenCalledWith(ESPACE_CLIENT);
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('exemple.test'));
  });

  it('passe le retour au lien « Créer mon compte » — sans compte, on revient au même endroit', () => {
    search = new URLSearchParams({ retour: TUNNEL });
    renderLogin();

    const href = screen.getByRole('link', { name: /Créer mon compte/ }).getAttribute('href');

    expect(href).toBe(
      `${ESPACE_CLIENT}/inscription?retour=${encodeURIComponent(TUNNEL)}`,
    );
  });

  it('ne traîne aucun paramètre sur ce lien quand il n’y a pas de retour', () => {
    renderLogin();

    expect(screen.getByRole('link', { name: /Créer mon compte/ }).getAttribute('href')).toBe(
      `${ESPACE_CLIENT}/inscription`,
    );
  });
});

describe('inscription — retour au tunnel', () => {
  it('revient là d’où la cliente vient quand l’adresse le dit', async () => {
    search = new URLSearchParams({ retour: TUNNEL });
    const user = userEvent.setup();
    renderRegister();

    await creeSonCompte(user);

    expect(replace).toHaveBeenCalledWith(TUNNEL);
  });

  it('dépose dans l’espace client quand rien ne dit d’où l’on vient', async () => {
    const user = userEvent.setup();
    renderRegister();

    await creeSonCompte(user);

    expect(replace).toHaveBeenCalledWith(ESPACE_CLIENT);
  });

  it('ignore un retour hostile — cet écran est atteignable sans passer par la connexion', async () => {
    search = new URLSearchParams({ retour: 'https://exemple.test/piege' });
    const user = userEvent.setup();
    renderRegister();

    await creeSonCompte(user);

    expect(replace).toHaveBeenCalledWith(ESPACE_CLIENT);
  });

  it('repasse le retour au lien « Se connecter »', () => {
    search = new URLSearchParams({ retour: TUNNEL });
    renderRegister();

    expect(screen.getByRole('link', { name: /Se connecter/ }).getAttribute('href')).toBe(
      `${ESPACE_CLIENT}/connexion?retour=${encodeURIComponent(TUNNEL)}`,
    );
  });
});
