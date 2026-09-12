import type { Tenant } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
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
