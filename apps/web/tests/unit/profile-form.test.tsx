import type { SessionUser } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileForm } from '@/app/(account)/[tenantSlug]/compte/components/profile-form';

const updateProfileAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

// L'action serveur est un module Next qui n'existe pas hors du serveur, et le
// routeur non plus. On les remplace entièrement : ce qu'on éprouve ici est le
// formulaire, pas le transport.
vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  updateProfileAction: (...args: unknown[]) => updateProfileAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
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
  replace.mockReset();
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
    expect(screen.getByText('camille@example.test')).toBeDefined();
  });

  it('écrit l’adresse e-mail en information et non en champ grisé (#1053)', () => {
    // Elle est l'identifiant de connexion et la clé d'unicité du compte : la
    // changer demande une vérification que le périmètre MVP ne porte pas. Un
    // `<input readonly>` promettait pourtant une saisie — il prend le focus et
    // porte un libellé de champ ; la valeur est donc une ligne d'information,
    // avec la raison écrite à côté.
    renderForm();

    expect(screen.queryByLabelText(/Adresse e-mail/)).toBeNull();
    expect(document.querySelector('.spa-account__readonly')).not.toBeNull();
    expect(screen.getByText(/identifiant de connexion/i)).toBeDefined();
  });

  it('groupe les champs en « Identité » et « Contact » (#1053)', () => {
    renderForm();

    // Deux `fieldset` nommés : leur `legend` est annoncée avec chaque champ du
    // groupe (WCAG 1.3.1), là où quatre champs empilés ne disaient rien de ce
    // qui va ensemble.
    expect(screen.getByRole('group', { name: 'Identité' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Contact' })).toBeDefined();
  });
});

describe('coordonnées — « Enregistrer » attend un changement (#1053)', () => {
  it('reste inactif tant que rien n’a bougé', () => {
    renderForm();

    // Un envoi sans modification déclenche une requête, une notification de
    // succès et un rafraîchissement pour rien — et apprend à la cliente que le
    // succès annoncé ne veut rien dire.
    expect(screen.getByRole('button', { name: /Enregistrer/ }).hasAttribute('disabled')).toBe(true);
  });

  it('s’active à la première frappe', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/Prénom/), 'e');

    expect(screen.getByRole('button', { name: /Enregistrer/ }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('redevient inactif une fois l’enregistrement abouti', async () => {
    updateProfileAction.mockResolvedValue({ ok: true, data: profile });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/Prénom/), 'e');
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Enregistrer/ }).hasAttribute('disabled')).toBe(
        true,
      );
    });
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

    // Le bouton n'accepte un envoi qu'une fois quelque chose modifié (#1053) :
    // c'est la frappe qui l'arme, le double clic qui est éprouvé ici.
    await user.type(screen.getByLabelText(/Prénom/), 'e');

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

    await user.type(screen.getByLabelText(/Prénom/), 'e');
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    expect(await screen.findByText('Les coordonnées saisies sont invalides.')).toBeDefined();
    expect(valueOf(/Prénom/)).toBe('Camillee');
  });

  it('renouvelle une session expirée au lieu de dire « reconnectez-vous » — #856', async () => {
    updateProfileAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
    });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/Prénom/), 'e');
    await user.click(screen.getByRole('button', { name: /Enregistrer/ }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('/salon-des-lilas/compte/session/refresh?next=');
    expect(screen.queryByText(/Reconnectez-vous/)).toBeNull();
    // La saisie reste en place : la page revient telle quelle.
    expect(valueOf(/Prénom/)).toBe('Camillee');
  });
});
