import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ReportChart,
  labelStride,
  niceCeiling,
} from '@/app/(admin)/[tenantSlug]/admin/components/report-chart';
import {
  appointmentStatusCountsSchema,
  dailyRevenueReportSchema,
  noShowReportSchema,
} from '@/lib/admin/reporting-contract';
import { formatMoney, formatMoneyCompact } from '@/lib/format';

/**
 * Le graphique du tableau de bord (#75, troisième critère) et la frontière qui
 * l'alimente.
 *
 * Ce qui est vérifié ici n'est pas l'esthétique — un rapport de contraste se
 * calcule, et `tests/contrast.test.mjs` le fait sur les deux thèmes. C'est ce
 * qu'un lecteur non voyant reçoit : le tableau en lecture d'écran doit porter
 * **toutes** les valeurs, dans l'ordre des barres, sans quoi le graphique ne
 * dirait rien à qui ne le voit pas.
 */

afterEach(cleanup);

const BARS = [
  { key: '2026-09-01', label: '1 sept.', value: 12, valueLabel: '12 rendez-vous', inner: 1, innerLabel: '1' },
  { key: '2026-09-02', label: '2 sept.', value: 0, valueLabel: '0 rendez-vous', inner: 0, innerLabel: '0' },
  { key: '2026-09-03', label: '3 sept.', value: 7, valueLabel: '7 rendez-vous', inner: 2, innerLabel: '2' },
];

describe('l’échelle et l’axe', () => {
  it('arrondit la borne haute au cran supérieur', () => {
    // Une échelle calée sur le maximum brut ferait toucher le plafond à la plus
    // haute barre : on ne saurait pas si elle est haute ou si elle sature.
    expect(niceCeiling(18)).toBe(20);
    expect(niceCeiling(240)).toBe(250);
    expect(niceCeiling(1_384)).toBe(1_500);
    expect(niceCeiling(0)).toBe(1);
  });

  it('garde une graduation médiane entière sur les petits comptes', () => {
    // Sous dix, le demi-ordre de grandeur vaut 0,5 : tout entier était son
    // propre plafond — la plus haute barre touchait le haut du cadre — et la
    // graduation médiane s'écrivait « 0,5 » ou « 3,5 » sur un axe qui compte des
    // rendez-vous. C'est le régime courant d'un petit salon.
    for (const value of [1, 3, 5, 7, 9]) {
      const ceiling = niceCeiling(value);

      expect(ceiling).toBeGreaterThan(value);
      expect(Number.isInteger(ceiling / 2)).toBe(true);
    }
  });

  it('espace les étiquettes pour qu’elles ne se chevauchent pas', () => {
    expect(labelStride(10)).toBe(1);
    expect(labelStride(366)).toBe(31);
  });
});

describe('l’échelle dit la même chose que le tableau de sa figure', () => {
  /** Les graduations peintes, espaces insécables ramenées à l'ordinaire. */
  const scaleOf = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.spa-admin-chart__scale')].map((tick) =>
      (tick.textContent ?? '').replace(/[\u202f\u00a0]/g, ' '),
    );

  it('gradue un axe monétaire dans la devise, et non en centimes', () => {
    // #614 : la barre porte 8 500 unités mineures — 85,00 € —, et l'axe
    // graduait « 8,5 k » sous un titre « EUR ». La gérante lisait 8 500 € là où
    // la caisse avait fait 85 €, sur le seul graphe de chiffre d'affaires du
    // produit. La donnée reste en unité mineure : c'est le rendu qui convertit.
    const amount = { amountMinor: 8_500, currency: 'EUR' } as const;
    const { container } = render(
      <ReportChart
        bars={[{ key: '2026-09-11', label: '11 sept.', value: amount.amountMinor, valueLabel: formatMoney(amount) }]}
        emptyLabel="Aucun encaissement sur la période."
        formatScaleValue={(value) => formatMoneyCompact({ amountMinor: value, currency: amount.currency })}
        layout="colonnes"
        seriesLabel="Revenu net (EUR)"
        summary="Revenu net par journée de caisse en EUR."
        title="Revenu net par jour — EUR"
        valueHeader="Revenu net"
      />,
    );

    const scale = scaleOf(container);

    expect(scale).toContain('85 €');
    expect(scale).not.toContain('8,5 k');
    // Le plafond de l'échelle et la ligne du tableau annoncent le même montant.
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toContain(
      formatMoney(amount),
    );
  });

  it('laisse un axe de comptage en nombres nus', () => {
    // Le graphe de volume est juste et doit le rester : sans formateur, l'axe
    // écrit le compact d'un entier, pas une devise.
    const { container } = render(
      <ReportChart
        bars={[{ key: '2026-09-11', label: '11 sept.', value: 18, valueLabel: '18 rendez-vous' }]}
        emptyLabel="Aucun rendez-vous sur la période."
        layout="colonnes"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par jour."
        title="Rendez-vous par jour"
        valueHeader="Rendez-vous"
      />,
    );

    // `niceCeiling(18)` vaut 20 : l'axe se gradue 0, 10, 20.
    expect(scaleOf(container)).toEqual(['0', '10', '20']);
  });
});

describe('ce qu’un lecteur d’écran reçoit', () => {
  it('rend toutes les valeurs dans un tableau, y compris la série secondaire', () => {
    render(
      <ReportChart
        bars={BARS}
        emptyLabel="Aucun rendez-vous sur la période."
        innerHeader="Dont no-shows"
        innerSeriesLabel="dont no-shows"
        layout="colonnes"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par jour, dont no-shows."
        title="Rendez-vous par jour"
        valueHeader="Rendez-vous"
      />,
    );

    expect(screen.getByRole('img', { name: 'Rendez-vous par jour' })).toBeTruthy();
    // Une ligne par barre — l'en-tête comprise dans le compte.
    expect(screen.getAllByRole('row')).toHaveLength(BARS.length + 1);
    expect(screen.getByRole('rowheader', { name: '1 sept.' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '12 rendez-vous' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Dont no-shows' })).toBeTruthy();
  });

  it('dit pourquoi il n’y a rien plutôt que de peindre un cadre vide', () => {
    // « Ça charge » et « il n'y a rien » ne sont pas le même écran, et un écran
    // vide sans explication est un bug d'UX (web-frontend §6).
    render(
      <ReportChart
        bars={[{ key: 'a', label: 'a', value: 0, valueLabel: '0' }]}
        emptyLabel="Aucun encaissement sur la période."
        layout="colonnes"
        seriesLabel="Revenu net"
        summary="Revenu net par journée de caisse."
        title="Revenu net par jour"
        valueHeader="Revenu net"
      />,
    );

    expect(screen.getByText('Aucun encaissement sur la période.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    // Le tableau reste rendu : la période a beau être vide, ses journées sont
    // une information.
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });
});

describe('ce qui déborde reste atteignable', () => {
  // #616 : sur une carte plus étroite que le plancher de lisibilité du tracé, le
  // canevas défile horizontalement et la fin de la période est hors cadre. Un
  // conteneur de défilement sans descendant atteignable au clavier ne se
  // manœuvre qu'à la souris (WCAG 2.1.1) : le SVG est l'arrêt de tabulation qui
  // donne aux flèches de quoi défiler son conteneur.
  for (const layout of ['colonnes', 'barres'] as const) {
    it(`donne au tracé en ${layout} un arrêt de tabulation`, () => {
      const { container } = render(
        <ReportChart
          bars={BARS}
          emptyLabel="Aucun rendez-vous sur la période."
          layout={layout}
          seriesLabel="Rendez-vous"
          summary="Nombre de rendez-vous par jour."
          title="Rendez-vous par jour"
          valueHeader="Rendez-vous"
        />,
      );

      expect(container.querySelector('.spa-admin-chart__svg')?.getAttribute('tabindex')).toBe('0');
    });
  }

  it('masque le tableau de lecture d’écran par une div, jamais par la table', () => {
    // `.spa-visually-hidden` réduit sa boîte à 1 px et coupe ce qui dépasse. Une
    // table en `table-layout: auto` ignore cette largeur — elle ne descend pas
    // sous la largeur minimale de son contenu — et, posée en absolu, étendait la
    // zone de défilement du document : 690 px de large sur un écran de 360 px.
    // Le masque appartient donc à l'enveloppe, et la table reste une table.
    const { container } = render(
      <ReportChart
        bars={BARS}
        emptyLabel="Aucun rendez-vous sur la période."
        layout="colonnes"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par jour."
        title="Rendez-vous par jour"
        valueHeader="Rendez-vous"
      />,
    );

    const masque = container.querySelector('.spa-visually-hidden');

    expect(masque?.tagName).toBe('DIV');
    expect(masque?.querySelector('table')).toBeTruthy();
    expect(container.querySelector('table.spa-visually-hidden')).toBeNull();
  });
});

describe('la couleur ne porte jamais l’information seule', () => {
  it('marque la barre retenue par un liseré, pas seulement par sa teinte', () => {
    const { container } = render(
      <ReportChart
        bars={[
          { key: 'a', label: 'Hasina', value: 88, valueLabel: '88 rendez-vous', highlighted: true },
          { key: 'b', label: 'Tiana', value: 76, valueLabel: '76 rendez-vous' },
        ]}
        emptyLabel="Aucun rendez-vous sur la période."
        layout="barres"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par praticien."
        title="Rendez-vous par praticien"
        valueHeader="Rendez-vous"
      />,
    );

    expect(container.querySelectorAll('.spa-admin-chart__bar--selected')).toHaveLength(1);
  });

  it('hachure la série secondaire en plus de la teindre', () => {
    const { container } = render(
      <ReportChart
        bars={BARS}
        emptyLabel="Aucun rendez-vous sur la période."
        innerHeader="Dont no-shows"
        innerSeriesLabel="dont no-shows"
        layout="colonnes"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par jour, dont no-shows."
        title="Rendez-vous par jour"
        valueHeader="Rendez-vous"
      />,
    );

    // Deux barres portent une part non nulle : chacune reçoit son aplat et sa
    // hachure. Un daltonisme deutan ne distingue pas deux aplats voisins.
    expect(container.querySelectorAll('.spa-admin-chart__bar-inner')).toHaveLength(2);
    expect(container.querySelectorAll('rect[fill^="url(#spa-chart-hatch-"]')).toHaveLength(2);
  });

  it('donne à chaque graphique son propre motif de hachure', () => {
    // Un SVG inséré dans une page HTML ne fait pas document à part : deux
    // graphiques portant le même `id` de motif produiraient des identifiants en
    // double, et `url(#…)` résoudrait toujours celui du premier.
    const { container } = render(
      <>
        <ReportChart
          bars={BARS}
          emptyLabel="Aucun rendez-vous."
          innerHeader="Dont no-shows"
          innerSeriesLabel="dont no-shows"
          layout="colonnes"
          seriesLabel="Rendez-vous"
          summary="Volume par jour."
          title="Rendez-vous par jour"
          valueHeader="Rendez-vous"
        />
        <ReportChart
          bars={BARS}
          emptyLabel="Aucun encaissement."
          innerHeader="Dont no-shows"
          innerSeriesLabel="dont no-shows"
          layout="colonnes"
          seriesLabel="Revenu net"
          summary="Revenu par jour."
          title="Revenu net par jour — EUR"
          valueHeader="Revenu net"
        />
      </>,
    );

    const ids = [...container.querySelectorAll('pattern')].map((pattern) => pattern.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('n’écrit aucune couleur dans le balisage', () => {
    // Tout passe par une classe et un jeton : une couleur littérale ici
    // échapperait à la bascule de thème et à la substitution de rampe.
    const { container } = render(
      <ReportChart
        bars={BARS}
        emptyLabel="Aucun rendez-vous sur la période."
        layout="colonnes"
        seriesLabel="Rendez-vous"
        summary="Nombre de rendez-vous par jour."
        title="Rendez-vous par jour"
        valueHeader="Rendez-vous"
      />,
    );

    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.querySelector('[style]')).toBeNull();
  });
});

describe('la frontière de contrat', () => {
  it('ramène les statuts du fil au vocabulaire du front', () => {
    // L'API agrège `NO_SHOW` parce que c'est ce que la colonne écrit ;
    // `@spa/shared` nomme `no_show` parce que c'est ce que le front lit. La
    // conversion se fait une fois, ici.
    expect(
      appointmentStatusCountsSchema.parse({
        PENDING: 2,
        CONFIRMED: 3,
        COMPLETED: 5,
        CANCELLED: 1,
        NO_SHOW: 4,
      }),
    ).toEqual({ pending: 2, confirmed: 3, completed: 5, cancelled: 1, no_show: 4 });
  });

  it('refuse une réponse à laquelle il manque un statut', () => {
    // Un compte absent vaudrait zéro en silence, et un total en serait faux.
    expect(() =>
      appointmentStatusCountsSchema.parse({ PENDING: 2, CONFIRMED: 3, COMPLETED: 5, CANCELLED: 1 }),
    ).toThrow();
  });

  it('accepte un taux nul de no-show sans le ramener à zéro', () => {
    const report = noShowReportSchema.parse({
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      timeZone: 'Indian/Antananarivo',
      noShows: 0,
      honored: 0,
      cancelled: 0,
      pending: 0,
      total: 0,
      rate: null,
    });

    expect(report.rate).toBeNull();
  });

  it('ramène le moyen d’encaissement à la casse du contrat', () => {
    const report = dailyRevenueReportSchema.parse({
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      timeZone: 'Indian/Antananarivo',
      days: [
        {
          date: '2026-09-03',
          method: 'CARD',
          currency: 'MGA',
          transactions: 1,
          grossAmountMinor: 20_000,
          refundedAmountMinor: 0,
          netAmountMinor: 20_000,
        },
      ],
      totals: [],
    });

    expect(report.days[0]?.method).toBe('card');
  });
});
