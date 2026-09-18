/**
 * L'étape 1 du tunnel — le choix de la prestation (#741).
 *
 * L'audit `d20260916-1` l'a relevée comme un `<select>` dont les options
 * concaténaient nom, durée et prix : à 360 px, le contrôle refermé affichait
 * « Rituel duo 90 min — 1 h 30 — 14… », le prix coupé, et rien d'autre à l'écran
 * ne le portait. `docs/design/appointments/wireframes.md` — étape 1 — prescrit
 * l'inverse : des cartes qui affichent *« durée et prix »*, une sélection en
 * *« radiogroup »*, et un CTA *« pleine largeur, ancré en bas de l'écran »*.
 *
 * Ce que cette suite tient : la **structure** que l'écart rouvrirait s'il
 * revenait — un groupe de boutons radio nommés par tout ce que la carte porte,
 * les quatre faits présents, et un bouton qui dit pourquoi il est inerte. Le
 * caractère collant de la barre et la mise en page des cartes sont affaire de
 * feuille de style, et c'est `booking-service-cards.test.mjs` qui les éprouve —
 * aucun de ces deux tests-là ne charge de CSS.
 */

import type { PublicService } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/service-step';

import { service } from './fixtures';

afterEach(cleanup);

/**
 * Une seconde prestation, **décrite** et plus chère.
 *
 * C'est elle qui rend le test représentatif du défaut relevé : l'écart n'était
 * pas qu'une prestation s'affichait mal, c'est que deux prestations ne se
 * comparaient plus. Sa description est celle que la vitrine montre et que le
 * sélecteur perdait.
 */
const rituel: PublicService = {
  ...service,
  id: '55555555-5555-4555-8555-555555555555',
  slug: 'rituel-duo',
  name: 'Rituel duo 90 min',
  description: 'Gommage puis massage, à deux mains ou à quatre.',
  durationMinutes: 90,
  price: { amountMinor: 14_000, currency: 'EUR' },
};

const CATALOGUE = [service, rituel];

function renderStep(services: readonly PublicService[] = CATALOGUE) {
  const onSubmit = vi.fn();

  render(
    <ServiceStep
      services={services}
      selectedServiceId={null}
      selectedStaffId={null}
      onSubmit={onSubmit}
    />,
  );

  return { onSubmit, user: userEvent.setup() };
}

/** La carte d'une prestation — son nom ouvre le nom accessible du radio. */
function carte(nom: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^${nom}`) });
}

describe('le choix de la prestation est un radiogroup de cartes (#741)', () => {
  it('rend une carte par prestation, et une seule sélection à la fois', async () => {
    const { user } = renderStep();

    const cartes = screen.getAllByRole('radio');

    expect(cartes).toHaveLength(CATALOGUE.length);
    // `some` et non `every` : ce qui est affirmé est qu'**aucune** carte n'est
    // cochée d'entrée. `every(...) === false` se contenterait d'une seule carte
    // libre et laisserait passer un tunnel qui présélectionne une prestation que
    // la cliente n'a pas choisie.
    expect(cartes.some((bouton) => (bouton as HTMLInputElement).checked)).toBe(false);

    await user.click(carte('Rituel duo 90 min'));

    expect(carte('Rituel duo 90 min')).toHaveProperty('checked', true);
    expect(carte('Massage suédois')).toHaveProperty('checked', false);
  });

  it('porte durée, prix et description sur chaque carte', () => {
    renderStep();

    // Le `<label>` **est** la carte, et son texte est aussi ce dont le nom
    // accessible du radio est fait : ce qui se lit et ce qui s'entend sont donc
    // la même chose, et c'est ce qu'on éprouve ici.
    const lu = carte('Rituel duo 90 min').closest('label')?.textContent ?? '';

    // Les préfixes sont donnés au lecteur d'écran seul : ils prouvent que les
    // deux nombres sont nommés, et non lâchés côte à côte.
    expect(lu).toContain('Durée : ');
    expect(lu).toContain('Tarif : ');
    // Le prix **entier**, jamais un début suivi de points de suspension : c'est
    // exactement ce que le sélecteur tronquait à 360 px.
    expect(lu).toContain('140,00');
    expect(lu).toContain('Gommage puis massage, à deux mains ou à quatre.');
  });

  it('groupe les cartes sous un libellé unique, et non sous un titre par carte', () => {
    renderStep();

    const groupe = screen.getByRole('group', { name: 'Prestation' });

    expect(within(groupe).getAllByRole('radio')).toHaveLength(CATALOGUE.length);
  });

  it('dit au catalogue vide pourquoi rien ne s’affiche', () => {
    renderStep([]);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText('Aucune prestation réservable en ligne')).toBeDefined();
  });
});

describe('le CTA de l’étape 1 (#741)', () => {
  it('reste inerte tant que rien n’est retenu, et dit pourquoi', () => {
    renderStep();

    // `wireframes.md` : « Le CTA est désactivé tant que l'étape n'est pas valide,
    // avec un libellé qui dit pourquoi ». Une barre pleine largeur et muette en
    // travers du bas de l'écran se lit sinon comme une panne.
    const cta = screen.getByRole('button', { name: 'Choisir une prestation pour continuer' });

    expect(cta).toHaveProperty('disabled', true);
  });

  it('mesure la largeur de la barre — `block`, comme le prescrit le wireframe', async () => {
    const { user, onSubmit } = renderStep();

    await user.click(carte('Rituel duo 90 min'));

    const cta = screen.getByRole('button', { name: 'Choisir un créneau' });

    expect(cta.className).toContain('spa-button--block');
    // La barre basse qui l'ancre — commune à toutes les étapes depuis #1047 :
    // c'est elle que la feuille colle au bas de l'écran.
    expect(cta.closest('.spa-booking__bar')).not.toBeNull();

    await user.click(cta);

    // Le praticien repart à « premier disponible » avec le changement de
    // prestation : `null`, et non un identifiant que la nouvelle prestation ne
    // tiendrait pas.
    expect(onSubmit).toHaveBeenCalledWith(rituel.id, null);
  });
});
