import type { Tenant } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantSettingsForm } from '@/app/(admin)/[tenantSlug]/admin/components/tenant-settings-form';

const updateTenantSettingsAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  updateTenantSettingsAction: (...args: unknown[]) => updateTenantSettingsAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const tenant: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'spa-lumiere',
  name: 'Spa Lumière',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  isActive: true,
  openingHours: [
    { weekday: 1, opensAt: '09:00', closesAt: '12:00' },
    { weekday: 1, opensAt: '14:00', closesAt: '19:00' },
  ],
};

/** Les sept jours, dans l'ordre de la grille — 1 lundi … 7 dimanche. */
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const;

/** Les 28 noms accessibles attendus : quatre bornes, sept jours. */
function expectedNames(): string[] {
  return DAYS.flatMap((day) => [
    `Ouverture 1 du ${day}`,
    `Fermeture 1 du ${day}`,
    `Ouverture 2 du ${day}`,
    `Fermeture 2 du ${day}`,
  ]);
}

afterEach(() => {
  cleanup();
  updateTenantSettingsAction.mockReset();
  refresh.mockReset();
});

describe('la grille des horaires d’ouverture — ce que le lecteur d’écran annonce', () => {
  it('donne à chacun des 28 champs un nom accessible qui nomme son jour', () => {
    // La preuve est prise dans l'arbre d'accessibilité et non dans le rendu :
    // `getByRole(…, { name })` calcule le nom accessible comme le ferait un
    // lecteur d'écran, et **échoue si deux champs le partagent**. Les 28 appels
    // qui passent disent donc à la fois la présence et l'unicité — c'est
    // exactement la mesure du constat de QA, « 28 champs pour 4 noms distincts »
    // (#621).
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    const names = expectedNames();

    expect(new Set(names).size).toBe(28);

    for (const name of names) {
      expect(screen.getByRole('textbox', { name })).toBeDefined();
    }
  });

  it('ouvre le nom accessible par le libellé visible, que la voix peut dire', () => {
    // WCAG 2.5.3 : le nom accessible doit contenir le libellé visible, faute de
    // quoi « Ouverture 1 » prononcé à une commande vocale ne désigne plus rien.
    // Le vérifier sur le champ et non sur la constante : c'est l'attribut rendu
    // qui est lu.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    const field = screen.getByRole('textbox', { name: 'Fermeture 2 du dimanche' });
    const visible = document.querySelector(`label[for="${field.id}"]`);

    expect(visible?.textContent).toBe('Fermeture 2');
    expect(field.getAttribute('aria-label')).toBe('Fermeture 2 du dimanche');
  });

  it('rattache chaque jour à ses champs par un groupe qui en porte le nom', () => {
    // Sans cela le jour n'est qu'un paragraphe posé à côté de la grille : rien
    // dans l'arbre ne le relie aux quatre champs de sa ligne.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    for (const label of ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']) {
      expect(screen.getByRole('group', { name: label })).toBeDefined();
    }
  });

  it('pré-remplit la journée à coupure sans confondre ses deux plages', () => {
    // La régression qu'on redoute en renommant : des libellés justes posés sur
    // les mauvaises valeurs. Le lundi porte 09:00–12:00 puis 14:00–19:00.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    const value = (name: string): string =>
      (screen.getByRole('textbox', { name }) as HTMLInputElement).value;

    expect(value('Ouverture 1 du lundi')).toBe('09:00');
    expect(value('Fermeture 1 du lundi')).toBe('12:00');
    expect(value('Ouverture 2 du lundi')).toBe('14:00');
    expect(value('Fermeture 2 du lundi')).toBe('19:00');
    expect(value('Ouverture 1 du mardi')).toBe('');
  });
});

describe('le verdict d’enregistrement — où il se pose', () => {
  /**
   * Soumet le formulaire tel qu'il est pré-rempli et rend l'encart affiché.
   *
   * Les valeurs par défaut du `tenant` d'essai sont valides — un nom, aucune
   * adresse, une semaine à coupure —, donc le clic part sans qu'on ait à saisir
   * quoi que ce soit : ce qui est mesuré ici est la place du verdict, pas la
   * validation.
   */
  async function submitAndRead(title: string): Promise<Element> {
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const heading = await screen.findByText(title);
    const notice = heading.closest('.spa-notification');

    if (notice === null) {
      throw new Error(`aucun encart de notification autour de « ${title} »`);
    }

    return notice;
  }

  /** Le bouton de soumission, typé — on lit son `form`. */
  function submitButton(): HTMLButtonElement {
    return screen.getByRole<HTMLButtonElement>('button', { name: 'Enregistrer' });
  }

  it('rend la confirmation contre le bouton qui vient d’être cliqué', async () => {
    // La mesure du constat de QA : l'encart était peint à quelque 2 400 px
    // au-dessus du bouton, pour une fenêtre de 900 px — après le clic, l'écran
    // était strictement identique (#635). Une distance en pixels ne se mesure
    // pas sous jsdom, qui ne dispose rien ; la position dans le document, si —
    // et c'est elle qui la produit. Être le frère immédiatement précédent du
    // bouton, à l'intérieur du même formulaire, c'est être dans le même champ de
    // vision que lui, quelle que soit la taille de la fenêtre.
    updateTenantSettingsAction.mockResolvedValue({ ok: true });

    const notice = await submitAndRead('Réglages enregistrés');
    const submit = submitButton();

    expect(notice.closest('form')).toBe(submit.form);
    expect(submit.previousElementSibling).toBe(notice.parentElement);
  });

  it('pose le focus sur le verdict, pour l’amener dans la fenêtre et le faire lire', async () => {
    // Le clic peut venir d'un formulaire laissé à mi-course, ou d'un « Entrée »
    // au clavier. Le focus est ce qui, dans les deux cas, amène l'encart sous
    // les yeux sans dépendre de la seule adjacence — et ce qui le fait annoncer
    // par un lecteur d'écran au lieu d'attendre une pause de lecture.
    updateTenantSettingsAction.mockResolvedValue({ ok: true });

    const notice = await submitAndRead('Réglages enregistrés');

    await waitFor(() => {
      expect(document.activeElement).toBe(notice.parentElement);
    });
  });

  it('pose l’échec au même endroit que le succès', async () => {
    // Un refus renvoyé en tête de page aurait exactement le défaut qu'on corrige,
    // en pire : il faut agir dessus. Les deux tons partagent donc l'emplacement.
    updateTenantSettingsAction.mockResolvedValue({
      ok: false,
      message: 'Le code postal saisi est refusé.',
    });

    const notice = await submitAndRead('L’enregistrement a échoué');

    expect(notice.textContent).toContain('Le code postal saisi est refusé.');
    expect(submitButton().previousElementSibling).toBe(notice.parentElement);
  });

  it('retire la confirmation quand la soumission suivante est refusée par la validation', async () => {
    // Le défaut qu'ouvrait le déplacement : `handleSubmit` n'appelle pas son
    // rappel quand un champ est invalide, donc rien n'effaçait le verdict
    // précédent. Le « Réglages enregistrés » d'il y a une minute restait peint à
    // deux centimètres du bouton, à affirmer qu'on venait d'enregistrer — alors
    // que rien n'était parti.
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await screen.findByText('Réglages enregistrés');

    await user.clear(screen.getByLabelText(/Nom de l’établissement/));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(screen.queryByText('Réglages enregistrés')).toBeNull();
    });
    // Un seul appel : la seconde soumission n'a rien envoyé.
    expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
  });

  it('repose le focus quand le même refus se répète', async () => {
    // Deux refus au message identique sont deux verdicts, pas un seul. Tant que
    // le verdict tenait dans deux `useState`, le `null` de remise à zéro et le
    // message tombaient dans le même lot de rendu sur les chemins de validation
    // locale : la dépendance de l'effet ne bougeait pas, le focus ne se reposait
    // pas, et un lecteur d'écran n'annonçait rien du tout la seconde fois.
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    // Deux plages du lundi qui se recouvrent : le seul refus que le schéma du
    // formulaire ne voit pas — il porte sur la semaine entière — et donc le
    // chemin synchrone, sans appel au serveur, qui portait le défaut.
    await user.clear(screen.getByLabelText('Ouverture 2 du lundi'));
    await user.type(screen.getByLabelText('Ouverture 2 du lundi'), '10:00');
    await user.clear(screen.getByLabelText('Fermeture 2 du lundi'));
    await user.type(screen.getByLabelText('Fermeture 2 du lundi'), '13:00');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const heading = await screen.findByText('L’enregistrement a échoué');
    const verdict = heading.closest('.spa-notification')?.parentElement;

    await waitFor(() => {
      expect(document.activeElement).toBe(verdict);
    });

    // Le second clic repart du bouton, et le refus est mot pour mot le même.
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByText('L’enregistrement a échoué').closest('.spa-notification')?.parentElement,
      );
    });
    expect(updateTenantSettingsAction).not.toHaveBeenCalled();
  });
});
