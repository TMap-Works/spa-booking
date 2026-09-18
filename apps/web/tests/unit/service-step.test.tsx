/**
 * L'étape 1 du tunnel — la prestation, puis le praticien (#741, #1048).
 *
 * L'audit `d20260916-1` l'avait relevée comme un `<select>` dont les options
 * concaténaient nom, durée et prix ; #741 y a posé un `radiogroup`. L'audit
 * `d20260918-1` relève ce qui restait : *« trois cartes à rond radio sans
 * regroupement par catégorie alors que la vitrine en a deux »*, et *« le
 * praticien [qui] est une `<select>` grisée »*. Quatre motifs du benchmark
 * disent l'inverse (`docs/design/benchmark/parcours-client.md`) :
 * `BM-SERVICE-01`, `BM-SERVICE-06`, `BM-PRATICIEN-01` et `BM-PRATICIEN-02`.
 *
 * Ce que cette suite tient : la **structure** que l'écart rouvrirait s'il
 * revenait — des rubriques en onglets, une ligne qui porte ses quatre faits, un
 * praticien qui se choisit sans liste déroulante, et un bouton qui dit pourquoi
 * il est inerte. La mise en page — deux colonnes à 48 rem, la coche, le
 * défilement horizontal des praticiens — est affaire de feuille de style, et
 * c'est `booking-service-cards.test.mjs` qui l'éprouve : aucun de ces deux
 * tests-là ne charge de CSS.
 */

import type { PublicService } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServiceStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/service-step';

import { service } from './fixtures';

afterEach(cleanup);

/**
 * Une seconde prestation, **décrite**, plus chère — et dans la même rubrique.
 *
 * C'est elle qui rend le test représentatif du défaut que #741 a corrigé :
 * l'écart n'était pas qu'une prestation s'affichait mal, c'est que deux
 * prestations ne se comparaient plus. Sa description est celle que la vitrine
 * montre et que le sélecteur perdait.
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

/**
 * Une prestation d'une **autre** rubrique, tenue par un autre praticien.
 *
 * L'écart relevé par `d20260918-1` est précisément là : la vitrine range ce
 * catalogue en deux rubriques, l'étape 1 les empilait en une seule coulée.
 */
const coupe: PublicService = {
  ...service,
  id: '66666666-6666-4666-8666-666666666666',
  slug: 'coupe-brushing',
  name: 'Coupe et brushing',
  description: null,
  category: { id: '77777777-7777-4777-8777-777777777777', slug: 'coiffure', name: 'Coiffure' },
  durationMinutes: 45,
  price: { amountMinor: 4500, currency: 'EUR' },
  staff: [
    { id: '88888888-8888-4888-8888-888888888888', displayName: 'Lila Andria' },
    { id: '99999999-9999-4999-8999-999999999999', displayName: 'Yanis B.' },
  ],
};

/** Deux prestations, une seule rubrique — le cas sans onglet. */
const UNE_RUBRIQUE = [service, rituel];
/** Trois prestations, deux rubriques — le cas que l'audit décrit. */
const DEUX_RUBRIQUES = [service, rituel, coupe];

function renderStep(services: readonly PublicService[] = UNE_RUBRIQUE) {
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

/** Le groupe des prestations — nommé par sa `<legend>` ou par son onglet. */
function prestations(nom: string): HTMLElement {
  return screen.getByRole('group', { name: nom });
}

/** La ligne d'une prestation — son nom ouvre le nom accessible du radio. */
function ligne(nom: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^${nom}`) });
}

describe('le choix de la prestation est un radiogroup de lignes (#741)', () => {
  it('rend une ligne par prestation, et une seule sélection à la fois', async () => {
    const { user } = renderStep();

    const lignes = within(prestations('Prestation')).getAllByRole('radio');

    expect(lignes).toHaveLength(UNE_RUBRIQUE.length);
    // `some` et non `every` : ce qui est affirmé est qu'**aucune** ligne n'est
    // cochée d'entrée. `every(...) === false` se contenterait d'une seule ligne
    // libre et laisserait passer un tunnel qui présélectionne une prestation que
    // la cliente n'a pas choisie.
    expect(lignes.some((bouton) => (bouton as HTMLInputElement).checked)).toBe(false);

    await user.click(ligne('Rituel duo 90 min'));

    expect(ligne('Rituel duo 90 min')).toHaveProperty('checked', true);
    expect(ligne('Massage suédois')).toHaveProperty('checked', false);
  });

  it('porte durée, prix et description sur chaque ligne', () => {
    renderStep();

    // Le `<label>` **est** la ligne, et son texte est aussi ce dont le nom
    // accessible du radio est fait : ce qui se lit et ce qui s'entend sont donc
    // la même chose, et c'est ce qu'on éprouve ici.
    const lu = ligne('Rituel duo 90 min').closest('label')?.textContent ?? '';

    // Les préfixes sont donnés au lecteur d'écran seul : ils prouvent que les
    // deux nombres sont nommés, et non lâchés côte à côte.
    expect(lu).toContain('Durée : ');
    expect(lu).toContain('Tarif : ');
    // Le prix **entier**, jamais un début suivi de points de suspension : c'est
    // exactement ce que le sélecteur tronquait à 360 px.
    expect(lu).toContain('140,00');
    expect(lu).toContain('Gommage puis massage, à deux mains ou à quatre.');
  });

  it('dit au catalogue vide pourquoi rien ne s’affiche', () => {
    renderStep([]);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText('Aucune prestation réservable en ligne')).toBeDefined();
  });
});

describe('les rubriques du catalogue se retrouvent à l’étape 1 (#1048, BM-SERVICE-02)', () => {
  it('n’ouvre aucun onglet quand le catalogue n’a qu’une rubrique', () => {
    renderStep();

    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    // La `<legend>` redevient alors visible : c'est le seul libellé du groupe.
    expect(prestations('Prestation')).toBeDefined();
  });

  it('range les prestations en onglets, avec l’effectif de chacun (BM-SERVICE-05)', () => {
    renderStep(DEUX_RUBRIQUES);

    const onglets = screen.getAllByRole('tab');

    // L'ordre est celui du catalogue — celui que la vitrine emploie déjà
    // (`groupServicesByCategory`), et non l'alphabet. Le « · » est donné au
    // lecteur d'écran seul : il sépare le libellé de son effectif, que l'œil lit
    // déjà dans sa pastille (`Tabs`, #1044).
    expect(onglets.map((onglet) => onglet.textContent)).toEqual(['Massages · 2', 'Coiffure · 1']);
    expect(onglets[0]).toHaveProperty('ariaSelected', 'true');

    // Seule la rubrique ouverte est dans l'arbre d'accessibilité : les panneaux
    // fermés portent `hidden`, et leurs boutons radio cessent d'être atteignables
    // à la flèche.
    expect(screen.getAllByRole('radio', { name: /^(Massage suédois|Rituel duo|Coupe)/u })).toHaveLength(
      2,
    );
  });

  it('garde la prestation retenue quand on passe d’une rubrique à l’autre', async () => {
    const { user } = renderStep(DEUX_RUBRIQUES);

    await user.click(ligne('Rituel duo 90 min'));
    await user.click(screen.getByRole('tab', { name: /^Coiffure/u }));

    expect(ligne('Coupe et brushing')).toHaveProperty('checked', false);
    // Le choix n'est pas tombé avec le changement d'onglet : il vit dans l'état
    // de l'étape, pas dans le panneau ouvert.
    expect(screen.getByRole('button', { name: 'Choisir un créneau' })).toHaveProperty(
      'disabled',
      false,
    );

    await user.click(screen.getByRole('tab', { name: /^Massages/u }));

    expect(ligne('Rituel duo 90 min')).toHaveProperty('checked', true);
  });

  it('ouvre la rubrique de la prestation déjà retenue au retour sur l’étape', () => {
    render(
      <ServiceStep
        services={DEUX_RUBRIQUES}
        selectedServiceId={coupe.id}
        selectedStaffId={null}
        onSubmit={vi.fn()}
      />,
    );

    // `BM-TUNNEL-08` : « la cliente retrouve la même étape avec les mêmes
    // choix ». Un onglet ouvert sur « Massages » cacherait la prestation qu'elle
    // vient de choisir.
    expect(screen.getByRole('tab', { name: /^Coiffure/u })).toHaveProperty('ariaSelected', 'true');
    expect(ligne('Coupe et brushing')).toHaveProperty('checked', true);
  });
});

describe('le praticien se choisit sans liste déroulante (#1048, BM-PRATICIEN-01)', () => {
  it('ne paraît pas tant qu’aucune prestation n’est retenue', () => {
    renderStep();

    expect(screen.queryByRole('group', { name: 'Praticien' })).toBeNull();
    // Et surtout : plus aucune liste déroulante sur l'étape — c'est le critère
    // d'acceptation de l'issue.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('propose « Premier disponible » en tête, avec ce qu’il rapporte', async () => {
    const { user } = renderStep(DEUX_RUBRIQUES);

    await user.click(screen.getByRole('tab', { name: /^Coiffure/u }));
    await user.click(ligne('Coupe et brushing'));

    const groupe = screen.getByRole('group', { name: 'Praticien' });
    const cartes = within(groupe).getAllByRole('radio');

    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    // Un choix par praticien de la prestation, plus l'absence de préférence.
    expect(cartes).toHaveLength(coupe.staff.length + 1);
    // En **tête**, et coché par défaut : `null` veut dire « pas de préférence »,
    // pas « pas encore choisi » (CDC §1.4).
    expect(cartes[0]?.getAttribute('value')).toBe('');
    expect(cartes[0]).toHaveProperty('checked', true);
    // « dit-il pourquoi le choisir ? » — BM-PRATICIEN-01.
    expect(cartes[0]?.closest('label')?.textContent).toContain('Premier disponible');
    expect(cartes[0]?.closest('label')?.textContent).toContain('Le plus de créneaux');
  });

  it('se choisit au clavier, et remonte l’identifiant retenu', async () => {
    const { user, onSubmit } = renderStep(DEUX_RUBRIQUES);

    await user.click(screen.getByRole('tab', { name: /^Coiffure/u }));
    await user.click(ligne('Coupe et brushing'));

    const groupe = screen.getByRole('group', { name: 'Praticien' });
    const lila = within(groupe).getByRole('radio', { name: /Lila Andria/u });

    // Un bouton radio **natif** : la barre d'espace le coche, et c'est le
    // contrôle lui-même qui porte le comportement — là où la liste déroulante
    // demandait d'ouvrir puis de viser. La navigation aux flèches vient du
    // navigateur et non du composant : jsdom n'expose pas d'objet `CSS`, et
    // l'émulation de `user-event` s'y casse ; c'est la recette au navigateur qui
    // en fait foi (phase 4bis de #1048).
    lila.focus();
    await user.keyboard('[Space]');

    expect(lila).toHaveProperty('checked', true);
    expect(within(groupe).getAllByRole('radio')[0]).toHaveProperty('checked', false);

    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(onSubmit).toHaveBeenCalledWith(coupe.id, coupe.staff[0]?.id);
  });

  it('dit qu’aucun praticien ne pratique la prestation, au lieu d’une rangée vide', async () => {
    const orpheline: PublicService = { ...service, staff: [] };
    const { user } = renderStep([orpheline]);

    await user.click(ligne('Massage suédois'));

    expect(within(screen.getByRole('group', { name: 'Praticien' })).queryAllByRole('radio')).toHaveLength(
      0,
    );
    expect(screen.getByText(/Aucun praticien ne propose cette prestation/u)).toBeDefined();
  });

  it('ignore un praticien du brouillon que la prestation ne tient pas', async () => {
    const onSubmit = vi.fn();

    render(
      <ServiceStep
        services={DEUX_RUBRIQUES}
        selectedServiceId={coupe.id}
        // Un lien partagé peut nommer les deux sans qu'ils aillent ensemble :
        // celui-ci pratique les massages, pas la coupe.
        selectedStaffId={service.staff[0]?.id ?? null}
        onSubmit={onSubmit}
      />,
    );

    const groupe = screen.getByRole('group', { name: 'Praticien' });

    // Une carte cochée, et c'est « Premier disponible » : un `radiogroup` dont
    // aucune option n'est retenue ne dit rien à la cliente, et l'identifiant
    // orphelin partirait pourtant à l'étape du créneau.
    expect(within(groupe).getAllByRole('radio')[0]).toHaveProperty('checked', true);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(onSubmit).toHaveBeenCalledWith(coupe.id, null);
  });

  it('repart à « premier disponible » quand la prestation change', async () => {
    const { user, onSubmit } = renderStep(DEUX_RUBRIQUES);

    await user.click(screen.getByRole('tab', { name: /^Coiffure/u }));
    await user.click(ligne('Coupe et brushing'));
    await user.click(
      within(screen.getByRole('group', { name: 'Praticien' })).getByRole('radio', {
        name: /Yanis B\./u,
      }),
    );

    await user.click(screen.getByRole('tab', { name: /^Massages/u }));
    await user.click(ligne('Rituel duo 90 min'));
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    // `null`, et non un identifiant que la nouvelle prestation ne tiendrait pas.
    expect(onSubmit).toHaveBeenCalledWith(rituel.id, null);
  });
});

describe('le CTA de l’étape 1 (#741, #1048)', () => {
  it('reste inerte tant que rien n’est retenu, et dit quoi faire', () => {
    renderStep();

    // `wireframes.md` : « Le CTA est désactivé tant que l'étape n'est pas valide,
    // avec un libellé qui dit pourquoi ». Une barre pleine largeur et muette en
    // travers du bas de l'écran se lit sinon comme une panne.
    const cta = screen.getByRole('button', { name: 'Choisissez une prestation' });

    expect(cta).toHaveProperty('disabled', true);
  });

  it('mesure la largeur de la barre — `block`, comme le prescrit le wireframe', async () => {
    const { user, onSubmit } = renderStep();

    await user.click(ligne('Rituel duo 90 min'));

    const cta = screen.getByRole('button', { name: 'Choisir un créneau' });

    expect(cta.className).toContain('spa-button--block');
    // La barre basse qui l'ancre — commune à toutes les étapes depuis #1047 :
    // c'est elle que la feuille colle au bas de l'écran.
    expect(cta.closest('.spa-booking__bar')).not.toBeNull();

    await user.click(cta);

    expect(onSubmit).toHaveBeenCalledWith(rituel.id, null);
  });
});
