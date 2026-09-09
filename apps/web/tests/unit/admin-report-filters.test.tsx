import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportFilters } from '@/app/(admin)/[tenantSlug]/admin/components/report-filters';
import { WHOLE_TENANT } from '@/lib/admin/reporting-view';

/**
 * La barre de filtres du tableau de bord (#75, premier critère).
 *
 * Ce qu'elle garde, et que la lecture du JSX ne montre pas : que la période et
 * le filtre partent bien **dans l'URL** — c'est ce qui rend un tableau de bord
 * partageable et le fait survivre à un rafraîchissement —, que les bornes ne
 * s'affichent que là où elles ont un sens, et qu'une période impossible est
 * refusée **sur le champ** plutôt qu'en retour d'un aller-retour.
 */

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  push.mockReset();
});

const STAFF = [
  { key: 'a1', label: 'Hasina', total: 88 },
  { key: 'b2', label: 'Tiana', total: 76 },
];
const SERVICES = [{ key: 's1', label: 'Massage 60 min', total: 40 }];

function renderFilters(overrides: Partial<Parameters<typeof ReportFilters>[0]> = {}) {
  return render(
    <ReportFilters
      period="trente-jours"
      range={{ from: '2026-09-01', to: '2026-09-30' }}
      scope={WHOLE_TENANT}
      services={SERVICES}
      staff={STAFF}
      tenantSlug="maison-lotus"
      timeZone="Indian/Antananarivo"
      {...overrides}
    />,
  );
}

describe('la période', () => {
  it('cache les bornes tant que la période est nommée', () => {
    // Toujours visibles, elles laisseraient croire qu'elles bornent « les 30
    // derniers jours » — alors que cette période se recalcule chaque matin.
    renderFilters();

    expect(screen.queryByLabelText('Du')).toBeNull();
    expect(screen.queryByLabelText('Au (inclus)')).toBeNull();
  });

  it('ouvre les deux bornes dès qu’on passe en personnalisée', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.selectOptions(screen.getByLabelText('Période'), 'personnalisee');

    expect(screen.getByLabelText('Du')).toBeTruthy();
    expect(screen.getByLabelText('Au (inclus)')).toBeTruthy();
  });

  it('envoie la période dans l’URL, pas dans un état local', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.selectOptions(screen.getByLabelText('Période'), 'mois-precedent');
    await user.click(screen.getByRole('button', { name: 'Afficher' }));

    expect(push).toHaveBeenCalledWith('/maison-lotus/admin/reporting?periode=mois-precedent');
  });

  it('refuse une fenêtre inversée sur le champ, sans naviguer', async () => {
    // L'API répondrait 422 ; le dire ici épargne l'aller-retour, et le message se
    // pose sous le champ fautif plutôt qu'en bloc en haut de page.
    const user = userEvent.setup();
    renderFilters({ period: 'personnalisee' });

    await user.clear(screen.getByLabelText('Au (inclus)'));
    await user.type(screen.getByLabelText('Au (inclus)'), '2026-08-01');
    await user.click(screen.getByRole('button', { name: 'Afficher' }));

    expect(screen.getByRole('alert').textContent).toMatch(/précède/);
    expect(push).not.toHaveBeenCalled();
  });
});

describe('la resynchronisation sur l’URL', () => {
  it('remet les bornes à la période affichée après une navigation', async () => {
    // Le défaut que la recette de #75 a pris sur le fait : après être passé au
    // mois précédent, rouvrir « personnalisée » pré-remplissait les bornes des
    // trente derniers jours — celles du premier rendu — pendant que l'écran
    // affichait bien août. `useState` ne lit sa valeur qu'au montage, et une
    // navigation ne remonte pas ce composant.
    const user = userEvent.setup();
    const { rerender } = renderFilters();

    rerender(
      <ReportFilters
        period="mois-precedent"
        range={{ from: '2026-08-01', to: '2026-08-31' }}
        scope={WHOLE_TENANT}
        services={SERVICES}
        staff={STAFF}
        tenantSlug="maison-lotus"
        timeZone="Indian/Antananarivo"
      />,
    );

    await user.selectOptions(screen.getByLabelText('Période'), 'personnalisee');

    expect(screen.getByLabelText<HTMLInputElement>('Du').value).toBe('2026-08-01');
    expect(screen.getByLabelText<HTMLInputElement>('Au (inclus)').value).toBe('2026-08-31');
  });

  it('ne touche pas à la saisie tant que l’URL ne change pas', async () => {
    // La contrepartie : l'ajustement ne doit pas se déclencher sous la frappe,
    // sans quoi il effacerait ce que la gérante est en train de saisir.
    const user = userEvent.setup();
    const { rerender } = renderFilters({ period: 'personnalisee' });

    await user.clear(screen.getByLabelText('Du'));
    await user.type(screen.getByLabelText('Du'), '2026-07-04');

    rerender(
      <ReportFilters
        period="personnalisee"
        range={{ from: '2026-09-01', to: '2026-09-30' }}
        scope={WHOLE_TENANT}
        services={SERVICES}
        staff={STAFF}
        tenantSlug="maison-lotus"
        timeZone="Indian/Antananarivo"
      />,
    );

    expect(screen.getByLabelText<HTMLInputElement>('Du').value).toBe('2026-07-04');
  });
});

describe('le filtre', () => {
  it('propose les praticiens et les prestations en deux groupes', () => {
    // Un seul sélecteur, et c'est ce que l'API sait répondre : les deux axes ne
    // se croisent pas, et deux sélecteurs combinables auraient promis un chiffre
    // que rien ne calcule.
    renderFilters();

    const select = screen.getByLabelText('Filtrer');
    const groups = select.querySelectorAll('optgroup');

    expect([...groups].map((group) => group.getAttribute('label'))).toEqual([
      'Praticiens',
      'Prestations',
    ]);
    expect(screen.getByRole('option', { name: 'Tout l’établissement' })).toBeTruthy();
  });

  it('porte le filtre retenu dans l’URL', async () => {
    const user = userEvent.setup();
    renderFilters();

    await user.selectOptions(screen.getByLabelText('Filtrer'), 'praticien:a1');
    await user.click(screen.getByRole('button', { name: 'Afficher' }));

    expect(push).toHaveBeenCalledWith('/maison-lotus/admin/reporting?filtre=praticien%3Aa1');
  });

  it('n’affiche aucun groupe vide', () => {
    // Un `<optgroup>` sans option laisse un intitulé inerte dans la liste, que
    // certains navigateurs annoncent quand même.
    renderFilters({ staff: [], services: [] });

    expect(screen.getByLabelText('Filtrer').querySelectorAll('optgroup')).toHaveLength(0);
  });
});
