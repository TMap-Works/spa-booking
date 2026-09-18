import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegisterForm } from '@/app/(account)/[tenantSlug]/compte/components/register-form';

const registerAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

// L'action serveur est un module Next qui n'existe pas hors du serveur, et le
// routeur non plus. On les remplace entièrement : ce qu'on éprouve ici est le
// formulaire, pas le transport.
vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  registerAction: (...args: unknown[]) => registerAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  // Le paramètre de retour (#1087) : absent ici, ce que ces cas-là supposent.
  // Ce qu'il fait quand il est présent est éprouvé par `account-return.test.tsx`.
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  registerAction.mockReset();
  replace.mockReset();
  refresh.mockReset();
});

function renderForm(): void {
  render(<RegisterForm tenantSlug="salon-des-lilas" />);
}

/**
 * La saisie exacte de #698 : « Nom » laissé vide, les trois autres fautifs.
 *
 * Le prénom est rempli à dessein — c'est ce qui distingue un champ obligatoire
 * **traversé et corrigé** d'un champ obligatoire **jamais visité**, et seul le
 * second était passé sous silence.
 */
async function saisieDuRapport(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/Prénom/), 'Zoé');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'zoe-pas-un-email');
  await user.type(screen.getByLabelText(/Téléphone/), 'abc');
  await user.type(screen.getByLabelText(/Mot de passe/), 'court');
  // La case de consentement (#734) est cochée d'entrée : elle ne fait pas
  // partie du rapport de #698, et la laisser vide ferait porter aux listes de
  // messages ci-dessous le libellé d'un autre ticket. Ce qu'elle refuse est
  // éprouvé par `booking-consent.test.tsx`.
  await user.click(screen.getByRole('checkbox'));
}

function messagesAffiches(): readonly string[] {
  return screen.queryAllByRole('alert').map((node) => node.textContent ?? '');
}

describe('inscription — première soumission', () => {
  /**
   * Le garde-fou de #698, et il porte sur la **cause**, pas sur le symptôme.
   *
   * jsdom ne sait pas reproduire la perte de clic elle-même : `userEvent` vise
   * l'élément, jamais un point de l'écran, si bien que le bouton peut descendre
   * de 25 px entre le `mousedown` et le `mouseup` sans que le `click` se perde.
   * Un navigateur, lui, calcule le point une fois pour toutes — et c'est
   * exactement ce qui faisait disparaître la première soumission.
   *
   * Ce qui se vérifie ici est donc la condition qui rendait cette perte
   * possible : qu'aucun message ne s'insère dans le flux **avant** la première
   * soumission. Tant qu'elle tient, rien ne peut déplacer le bouton sous le
   * pointeur au moment du clic.
   */
  it('n’insère aucun message avant la première soumission — le bouton ne peut pas se dérober', async () => {
    const user = userEvent.setup();
    renderForm();

    await saisieDuRapport(user);
    // Le focus quitte le dernier champ, comme au `mousedown` sur le bouton.
    await user.tab();

    expect(messagesAffiches()).toEqual([]);
    expect(screen.getByLabelText(/Adresse e-mail/).getAttribute('aria-invalid')).toBeNull();
  });

  it('signale tous les champs fautifs d’un coup, « Nom » jamais visité compris', async () => {
    const user = userEvent.setup();
    renderForm();

    await saisieDuRapport(user);
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    // Le critère de l'issue : quatre erreurs, en une seule soumission.
    expect(await screen.findByText('ce champ est obligatoire')).toBeDefined();
    expect(messagesAffiches()).toEqual([
      'ce champ est obligatoire',
      'adresse e-mail invalide',
      'numéro de téléphone invalide',
      'le mot de passe fait au moins 12 caractères',
    ]);
    expect(registerAction).not.toHaveBeenCalled();
  });

  it('rattache chaque message à son champ, jamais en bloc en haut de page', async () => {
    // web-frontend §4 : un message d'erreur appartient à son champ, et c'est
    // `aria-describedby` qui fait qu'un lecteur d'écran l'annonce en y arrivant.
    const user = userEvent.setup();
    renderForm();

    await saisieDuRapport(user);
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    const nom = await screen.findByLabelText(/^Nom/);
    const message = await screen.findByText('ce champ est obligatoire');
    expect(nom.getAttribute('aria-invalid')).toBe('true');
    expect(nom.getAttribute('aria-describedby')).toContain(message.id);
  });
});

describe('inscription — correction', () => {
  it('efface le message d’un champ dès qu’il est corrigé, sans resoumettre', async () => {
    const user = userEvent.setup();
    renderForm();

    await saisieDuRapport(user);
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));
    await screen.findByText('ce champ est obligatoire');

    await user.type(screen.getByLabelText(/^Nom/), 'Ranaivo');

    expect(screen.queryByText('ce champ est obligatoire')).toBeNull();
    // Les trois autres restent signalées : corriger un champ n'absout pas les autres.
    expect(messagesAffiches()).toEqual([
      'adresse e-mail invalide',
      'numéro de téléphone invalide',
      'le mot de passe fait au moins 12 caractères',
    ]);
  });

  it('soumet une fois tout corrigé, et sans envoyer de téléphone vide', async () => {
    registerAction.mockResolvedValue({ ok: true, data: { id: 'x' } });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/Prénom/), 'Zoé');
    await user.type(screen.getByLabelText(/^Nom/), 'Ranaivo');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'zoe@example.test');
    await user.type(screen.getByLabelText(/Mot de passe/), 'correct horse battery');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Créer mon compte/ }));

    expect(registerAction).toHaveBeenCalledWith('salon-des-lilas', {
      email: 'zoe@example.test',
      password: 'correct horse battery',
      firstName: 'Zoé',
      lastName: 'Ranaivo',
      // L'accord part avec l'inscription depuis #880 — et lui seul : aucune
      // date n'accompagne le booléen, c'est le serveur qui l'horodate.
      dataConsent: true,
    });
  });
});
