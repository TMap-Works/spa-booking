import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PeriodNav,
  PeriodViewSwitch,
} from '@/app/(admin)/[tenantSlug]/admin/components/period-nav';

/*
 * La barre de navigation par période, partagée par le planning et
 * l'encaissement (#629).
 *
 * Ce que la suite protège : que les deux écrans obtiennent la **même** barre —
 * quatre contrôles, dans le même ordre, la date entre les deux chevrons — quel
 * que soit le mode, gestes ou liens. Le jour où l'un des deux appelants
 * réinventerait sa propre rangée, c'est cette suite qui devrait tomber avant la
 * capture d'une campagne de QA.
 *
 * Le chevron lui-même n'est pas assertionné : il est `aria-hidden`, et c'est le
 * libellé masqué qui nomme le contrôle. Asserter le caractère reviendrait à
 * figer un choix typographique dans un test de comportement.
 */

afterEach(cleanup);

describe('PeriodNav', () => {
  it('rend quatre contrôles dans l’ordre, la date entre les deux chevrons', () => {
    render(
      <PeriodNav
        label="Vendredi 11 septembre 2026"
        next={{ href: '/maison-lotus/admin/encaissement?date=2026-09-12' }}
        nextLabel="Jour suivant"
        previous={{ href: '/maison-lotus/admin/encaissement?date=2026-09-10' }}
        previousLabel="Jour précédent"
        today={{ href: '/maison-lotus/admin/encaissement?date=2026-09-14' }}
      />,
    );

    const caption = screen.getByText('Vendredi 11 septembre 2026');
    const group = caption.parentElement;

    expect(group?.className).toBe('spa-admin-toolbar__group');

    const controls = [...(group?.children ?? [])];

    expect(controls).toHaveLength(4);
    expect(within(controls[0] as HTMLElement).getByText('Jour précédent')).toBeDefined();
    // Le cœur du constat : la date est **entre** les deux chevrons, et non posée
    // avant eux comme le faisait l'encaissement.
    expect(controls[1]).toBe(caption);
    expect(within(controls[2] as HTMLElement).getByText('Jour suivant')).toBeDefined();
    expect(controls[3]?.textContent).toBe('Aujourd’hui');
  });

  it('rend des liens quand on lui donne des chemins, et non des boutons', () => {
    render(
      <PeriodNav
        label="Vendredi 11 septembre 2026"
        next={{ href: '/maison-lotus/admin/encaissement?date=2026-09-12' }}
        nextLabel="Jour suivant"
        previous={{ href: '/maison-lotus/admin/encaissement?date=2026-09-10' }}
        previousLabel="Jour précédent"
        today={{ href: '/maison-lotus/admin/encaissement?date=2026-09-14' }}
      />,
    );

    // Un écran rendu côté serveur ne doit embarquer aucun JavaScript pour
    // changer de jour : les trois contrôles sont des liens réels, donc
    // ouvrables dans un autre onglet et suivis sans hydratation.
    expect(screen.getByRole('link', { name: 'Jour précédent' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/encaissement?date=2026-09-10',
    );
    expect(screen.getByRole('link', { name: 'Jour suivant' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/encaissement?date=2026-09-12',
    );
    expect(screen.getByRole('link', { name: 'Aujourd’hui' }).getAttribute('href')).toBe(
      '/maison-lotus/admin/encaissement?date=2026-09-14',
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('rend des boutons quand on lui donne des gestes, et les déclenche au clic', async () => {
    const previous = vi.fn();
    const next = vi.fn();
    const today = vi.fn();
    const user = userEvent.setup();

    render(
      <PeriodNav
        label="24 – 30 août 2026"
        next={{ onSelect: next }}
        nextLabel="Semaine suivante"
        previous={{ onSelect: previous }}
        previousLabel="Semaine précédente"
        today={{ onSelect: today }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Semaine précédente' }));
    await user.click(screen.getByRole('button', { name: 'Semaine suivante' }));
    await user.click(screen.getByRole('button', { name: 'Aujourd’hui' }));

    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(today).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('peint les chevrons en bouton encadré et le retour au jour courant en discret', () => {
    render(
      <PeriodNav
        label="Vendredi 11 septembre 2026"
        next={{ href: '/maison-lotus/admin/encaissement?date=2026-09-12' }}
        nextLabel="Jour suivant"
        previous={{ href: '/maison-lotus/admin/encaissement?date=2026-09-10' }}
        previousLabel="Jour précédent"
        today={{ href: '/maison-lotus/admin/encaissement?date=2026-09-14' }}
      />,
    );

    // C'est le constat de la campagne de QA : côté encaissement les deux flèches
    // étaient des liens texte sans cadre, sous la cible du bout du doigt. La
    // variante `neutral` est celle que le planning emploie, et c'est elle qui
    // porte la bordure.
    for (const name of ['Jour précédent', 'Jour suivant']) {
      expect(screen.getByRole('link', { name }).className).toContain('spa-button--neutral');
    }

    expect(screen.getByRole('link', { name: 'Aujourd’hui' }).className).toContain(
      'spa-button--quiet',
    );
  });

  it('désactive le retour au jour courant quand la période ouverte est aujourd’hui', () => {
    render(
      <PeriodNav
        label="Mercredi 23 septembre 2026"
        next={{ href: '/maison-lotus/admin/mon-planning?date=2026-09-24' }}
        nextLabel="Jour suivant"
        previous={{ href: '/maison-lotus/admin/mon-planning?date=2026-09-22' }}
        previousLabel="Jour précédent"
        today={{ href: '/maison-lotus/admin/mon-planning' }}
        todayIsCurrent
      />,
    );

    // Le défaut que cette branche ferme : sur « Mon planning », l'écran s'ouvre
    // sur aujourd'hui, le lien pointait la page où l'on était déjà, et le
    // premier clic de la praticienne ne produisait rien. Le contrôle reste à sa
    // place — la barre garde ses quatre contrôles — mais il se dit indisponible.
    const control = screen.getByRole('button', { name: 'Aujourd’hui' });

    expect(control.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Aujourd’hui' })).toBeNull();

    // Et les deux chevrons restent des liens : seul le retour est neutralisé.
    expect(screen.getByRole('link', { name: 'Jour précédent' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Jour suivant' })).toBeDefined();
  });
});

/*
 * Le sélecteur de vue de la barre d'outils — #1412.
 *
 * Même objet que la suite ci-dessus : les deux plannings du back-office
 * changeaient de vue de deux façons, l'un par un groupe segmenté dans la barre
 * (le standard que décrit `BM-AGENDA-01`), l'autre par une rangée d'onglets
 * posée au-dessus. Ce que cette suite protège, c'est que les deux obtiennent le
 * **même** groupe, quel que soit le mode — et qu'un troisième segment y entre
 * sans cas particulier, « Mon planning » en ayant trois.
 */
describe('PeriodViewSwitch', () => {
  const liens = [
    { key: 'jour', label: 'Jour', control: { href: '/x/admin/mon-planning?vue=jour' }, current: false },
    {
      key: 'semaine',
      label: 'Semaine',
      control: { href: '/x/admin/mon-planning?vue=semaine' },
      current: true,
    },
    {
      key: 'a-venir',
      label: 'À venir',
      control: { href: '/x/admin/mon-planning?vue=a-venir' },
      current: false,
    },
  ];

  it('rend les segments dans l’ordre, sous le groupe segmenté du back-office', () => {
    render(<PeriodViewSwitch label="Vue du planning" segments={liens} />);

    // La classe est celle que `admin/shell.css` peint déjà pour le planning du
    // salon : c'est elle qui fait que les deux écrans se ressemblent, et non
    // deux feuilles qui convergeraient par hasard.
    const group = screen.getByRole('group', { name: 'Vue du planning' });

    expect(group.className).toBe('spa-admin-segmented');
    expect([...group.children].map((option) => option.textContent)).toEqual([
      'Jour',
      'Semaine',
      'À venir',
    ]);
  });

  it('rend de vrais liens et marque l’ouvert d’un `aria-current`', () => {
    render(<PeriodViewSwitch label="Vue du planning" segments={liens} />);

    // Un écran rendu côté serveur ne doit embarquer aucun JavaScript pour
    // changer de vue : les trois segments sont des liens, ouvrables dans un
    // autre onglet. L'ouvert dit « vous êtes ici » — et non `aria-selected`,
    // qui promettrait un panneau dans la page.
    expect(screen.getByRole('link', { name: 'À venir' }).getAttribute('href')).toBe(
      '/x/admin/mon-planning?vue=a-venir',
    );
    expect(screen.getByRole('link', { name: 'Semaine' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Jour' }).hasAttribute('aria-current')).toBe(false);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('rend des boutons radio quand on lui donne des gestes, et les déclenche', async () => {
    const jour = vi.fn();
    const semaine = vi.fn();
    const user = userEvent.setup();

    render(
      <PeriodViewSwitch
        label="Vue du planning"
        segments={[
          { key: 'jour', label: 'Jour', control: { onSelect: jour }, current: true },
          { key: 'semaine', label: 'Semaine', control: { onSelect: semaine }, current: false },
        ]}
      />,
    );

    // Des radios natifs, d'où viennent la navigation par flèches et l'annonce
    // « 1 sur 2 » : c'est ce que rend le planning du salon, qui a déjà mis la
    // période voisine en cache et ne doit pas repasser par le serveur.
    expect(screen.getByRole('radio', { name: 'Jour' })).toHaveProperty('checked', true);
    expect(screen.queryAllByRole('link')).toHaveLength(0);

    await user.click(screen.getByRole('radio', { name: 'Semaine' }));

    expect(semaine).toHaveBeenCalledTimes(1);
    expect(jour).not.toHaveBeenCalled();
  });

  it('nomme le groupe sans l’écrire à l’œil, dans les deux modes', () => {
    // Le nom existe pour qui écoute l'écran — « Vue du planning » — mais la
    // barre ne le répète pas : les trois segments se lisent d'eux-mêmes.
    const { container } = render(<PeriodViewSwitch label="Vue du planning" segments={liens} />);

    expect(container.textContent).not.toContain('Vue du planning');

    cleanup();

    render(
      <PeriodViewSwitch
        label="Vue du planning"
        segments={[{ key: 'jour', label: 'Jour', control: { onSelect: vi.fn() }, current: true }]}
      />,
    );

    // En mode geste c'est un `<fieldset>` : sa légende porte le nom, et elle
    // est masquée. Un `<fieldset>` autour de liens aurait été un groupe de
    // champs sans champ, d'où les deux conteneurs.
    const legend = screen.getByText('Vue du planning');

    expect(legend.tagName).toBe('LEGEND');
    expect(legend.className).toBe('spa-visually-hidden');
  });
});
