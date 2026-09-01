import type { SessionUser } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileForm } from '@/app/(account)/[tenantSlug]/compte/components/profile-form';

const updateProfileAction = vi.fn();
const refresh = vi.fn();

// L'action serveur est un module Next qui n'existe pas hors du serveur, et le
// routeur non plus. On les remplace entièrement : ce qu'on éprouve ici est le
// formulaire, pas le transport.
vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  updateProfileAction: (...args: unknown[]) => updateProfileAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

const profile: SessionUser = {
  id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
  email: 'camille@example.test',
  role: 'client',
  firstName: 'Camille',
  lastName: 'Rakoto',
  phone: '+261 34 12 345 67',
};

afterEach(() => {
  cleanup();
  updateProfileAction.mockReset();
  refresh.mockReset();
});

function renderForm(): void {
  render(<ProfileForm tenantSlug="salon-des-lilas" profile={profile} />);
}

/**
 * La valeur **courante** d'un champ.
 *
 * La propriété DOM et non l'attribut : `react-hook-form` travaille en
 * non-contrôlé et pose la valeur initiale par la propriété, si bien qu'un
 * `getAttribute('value')` rend `null` sur un champ pourtant rempli.
 */
function valueOf(label: RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe('coordonnées — pré-remplissage', () => {
  it('affiche les coordonnées du compte, e-mail compris', () => {
    renderForm();

    expect(valueOf(/Prénom/)).toBe('Camille');
    expect(valueOf(/Téléphone/)).toBe('+261 34 12 345 67');
    expect(valueOf(/Adresse e-mail/)).toBe('camille@example.test');
  });

  it('laisse l’adresse e-mail en lecture seule, et dit pourquoi', () => {
    // Elle est l'identifiant de connexion et la clé d'unicité du compte : la
    // changer demande une vérification que le périmètre MVP ne porte pas.
    renderForm();

    const email = screen.getByLabelText(/Adresse e-mail/);
    expect(email.hasAttribute('readonly')).toBe(true);
    expect(screen.getByText(/identifiant de connexion/i)).toBeDefined();
  });
});

describe('coordonnées — validation', () => {
  it('rattache le message d’erreur au champ fautif, jamais en bloc en haut de page', async () => {
    const user = userEvent.setup();
    renderForm();

    const phone = screen.getByLabelText(/Téléphone/);
    await user.clear(phone);
    await user.type(phone, 'pas un numéro');
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    const message = await screen.findByText(/numéro de téléphone invalide/i);
    // Le lien est `aria-describedby` : c'est ce qui fait qu'un lecteur d'écran
    // annonce l'erreur en arrivant sur le champ (web-frontend §4).
    expect(phone.getAttribute('aria-describedby')).toContain(message.id);
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(updateProfileAction).not.toHaveBeenCalled();
  });

  it('envoie `null` — et non la chaîne vide — quand le numéro est effacé', async () => {
    // `null` est la valeur par laquelle on **retire** un numéro ; la chaîne vide
    // descendrait jusqu'à la colonne comme un numéro de zéro caractère.
    updateProfileAction.mockResolvedValue({ ok: true, data: { ...profile, phone: null } });
    const user = userEvent.setup();
    renderForm();

    await user.clear(screen.getByLabelText(/Téléphone/));
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(updateProfileAction).toHaveBeenCalledWith('salon-des-lilas', {
      firstName: 'Camille',
      lastName: 'Rakoto',
      phone: null,
    });
  });
});

describe('coordonnées — soumission', () => {
  it('ne produit qu’un enregistrement sur un double clic', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    updateProfileAction.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );

    const user = userEvent.setup();
    renderForm();

    const submit = screen.getByRole('button', { name: /Enregistrer/ });
    await user.click(submit);
    await user.click(submit);

    expect(updateProfileAction).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: profile });
  });

  it('annonce l’échec sans effacer la saisie', async () => {
    updateProfileAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Les coordonnées saisies sont invalides.',
    });
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByText('Les coordonnées saisies sont invalides.')).toBeDefined();
    expect(valueOf(/Prénom/)).toBe('Camille');
  });
});
