import { describe, expect, it } from 'vitest';

import type {
  AppointmentStatusCounts,
  AppointmentVolumeReport,
  DailyRevenueReport,
  NoShowReport,
} from '@/lib/admin/reporting-contract';
import {
  WHOLE_TENANT,
  filterOptions,
  formatReportScope,
  noShowRate,
  noShowsOfCounts,
  parseReportScope,
  revenueByCurrency,
  revenueSeries,
  scopedActivity,
  volumePoints,
} from '@/lib/admin/reporting-view';

/**
 * Le modèle de vue du tableau de bord (#75).
 *
 * Ce que ces suites gardent, et que rien d'autre ne garde : les **décisions**.
 * Qu'aucun total ne mélange deux devises, qu'un taux de no-show sans
 * dénominateur reste `null` plutôt que de s'afficher à 0 %, et qu'un filtre
 * recalcule ses chiffres depuis la ligne de l'axe au lieu d'emprunter ceux de
 * l'établissement.
 */

const WINDOW = { from: '2026-08-31T21:00:00.000Z', to: '2026-09-04T21:00:00.000Z' };
const RANGE = { from: '2026-09-01', to: '2026-09-04' };
const TIME_ZONE = 'Indian/Antananarivo';

function counts(partial: Partial<AppointmentStatusCounts>): AppointmentStatusCounts {
  return { pending: 0, confirmed: 0, completed: 0, cancelled: 0, no_show: 0, ...partial };
}

function volumeReport(
  groupBy: AppointmentVolumeReport['groupBy'],
  rows: AppointmentVolumeReport['rows'],
): AppointmentVolumeReport {
  return {
    window: WINDOW,
    groupBy,
    timeZone: TIME_ZONE,
    rows,
    total: rows.reduce((sum, row) => sum + row.total, 0),
  };
}

const NO_SHOW_REPORT: NoShowReport = {
  window: WINDOW,
  timeZone: TIME_ZONE,
  noShows: 4,
  honored: 118,
  cancelled: 9,
  pending: 33,
  total: 164,
  rate: 0.0328,
};

describe('les valeurs de filtre', () => {
  const byStaff = volumeReport('staff', [
    { key: 'b', label: 'Tiana', total: 76, byStatus: counts({ completed: 76 }) },
    { key: 'a', label: 'Hasina', total: 88, byStatus: counts({ completed: 88 }) },
    { key: 'c', label: null, total: 12, byStatus: counts({ completed: 12 }) },
  ]);

  it('classe du plus fréquenté au moins fréquenté', () => {
    expect(filterOptions(byStaff).map((option) => option.label)).toEqual(['Hasina', 'Tiana']);
  });

  it('écarte les groupes sans libellé', () => {
    // L'axe `staff` rend `label: null` sur les rendez-vous sans praticien
    // assigné. Un choix « (sans nom) » dans un sélecteur n'apprend rien, et leur
    // compte reste dans le total de l'établissement, qui ne filtre rien.
    expect(filterOptions(byStaff).some((option) => option.key === 'c')).toBe(false);
  });
});

describe('le filtre lu de l’URL', () => {
  const staff = [{ key: 'a', label: 'Hasina', total: 88 }];
  const services = [{ key: 's1', label: 'Massage 60 min', total: 40 }];

  it('reconnaît les deux axes', () => {
    expect(parseReportScope('praticien:a', staff, services)).toEqual({
      kind: 'praticien',
      key: 'a',
      label: 'Hasina',
    });
    expect(parseReportScope('prestation:s1', staff, services)).toEqual({
      kind: 'prestation',
      key: 's1',
      label: 'Massage 60 min',
    });
  });

  it('retombe sur l’établissement sur une clé que la période ne contient pas', () => {
    // Un praticien qui n'a vu personne en septembre n'a pas de ligne : afficher
    // son nom au-dessus de zéros pris ailleurs serait un mensonge. Le lien reste
    // valide, il montre simplement l'établissement.
    expect(parseReportScope('praticien:inconnu', staff, services)).toEqual(WHOLE_TENANT);
    expect(parseReportScope('quelquechose:a', staff, services)).toEqual(WHOLE_TENANT);
    expect(parseReportScope('praticien', staff, services)).toEqual(WHOLE_TENANT);
    expect(parseReportScope(undefined, staff, services)).toEqual(WHOLE_TENANT);
  });

  it('fait l’aller-retour avec ce que l’URL porte', () => {
    const scope = parseReportScope('prestation:s1', staff, services);

    expect(formatReportScope(scope)).toBe('prestation:s1');
    expect(formatReportScope(WHOLE_TENANT)).toBeNull();
  });
});

describe('le revenu ne mélange jamais deux devises', () => {
  const report: DailyRevenueReport = {
    window: WINDOW,
    timeZone: TIME_ZONE,
    days: [
      {
        date: '2026-09-01',
        method: 'card',
        currency: 'MGA',
        transactions: 2,
        grossAmountMinor: 60_000,
        refundedAmountMinor: 0,
        netAmountMinor: 60_000,
      },
      {
        date: '2026-09-01',
        method: 'cash',
        currency: 'MGA',
        transactions: 1,
        grossAmountMinor: 20_000,
        refundedAmountMinor: 5_000,
        netAmountMinor: 15_000,
      },
      {
        date: '2026-09-03',
        method: 'card',
        currency: 'EUR',
        transactions: 1,
        grossAmountMinor: 3_500,
        refundedAmountMinor: 0,
        netAmountMinor: 3_500,
      },
    ],
    totals: [
      {
        method: 'card',
        currency: 'MGA',
        transactions: 2,
        grossAmountMinor: 60_000,
        refundedAmountMinor: 0,
        netAmountMinor: 60_000,
      },
      {
        method: 'cash',
        currency: 'MGA',
        transactions: 1,
        grossAmountMinor: 20_000,
        refundedAmountMinor: 5_000,
        netAmountMinor: 15_000,
      },
      {
        method: 'card',
        currency: 'EUR',
        transactions: 1,
        grossAmountMinor: 3_500,
        refundedAmountMinor: 0,
        netAmountMinor: 3_500,
      },
    ],
  };

  it('cumule par devise et jamais entre devises', () => {
    // Additionner 75 000 MGA et 3 500 EUR produirait un nombre qui ne veut rien
    // dire : la clé composite fait que le total se scinde au lieu de mentir.
    expect(revenueByCurrency(report.totals)).toEqual([
      {
        currency: 'MGA',
        transactions: 3,
        grossAmountMinor: 80_000,
        refundedAmountMinor: 5_000,
        netAmountMinor: 75_000,
      },
      {
        currency: 'EUR',
        transactions: 1,
        grossAmountMinor: 3_500,
        refundedAmountMinor: 0,
        netAmountMinor: 3_500,
      },
    ]);
  });

  it('reste en entiers de la plus petite unité monétaire', () => {
    const [mga] = revenueByCurrency(report.totals);

    expect(Number.isInteger(mga?.netAmountMinor)).toBe(true);
    expect(mga?.netAmountMinor).toBe(75_000);
  });

  it('ajoute les journées sans recette pour que l’axe reste continu', () => {
    // L'API omet les jours de fermeture — « un rapport ne fabrique pas les jours
    // où le salon était fermé ». Sans les zéros, deux barres voisines pourraient
    // être séparées d'une semaine, et la courbe d'activité serait fausse à l'œil.
    const series = revenueSeries(report, RANGE);
    const mga = series.find((candidate) => candidate.currency === 'MGA');

    expect(series.map((candidate) => candidate.currency)).toEqual(['EUR', 'MGA']);
    expect(mga?.days.map((day) => day.date)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
    // Le 1er cumule les deux moyens de paiement de la même devise ; les autres
    // journées valent zéro et non « absent ».
    expect(mga?.days[0]?.netAmountMinor).toBe(75_000);
    expect(mga?.days[1]?.netAmountMinor).toBe(0);
    expect(mga?.days[1]?.transactions).toBe(0);
  });
});

describe('le taux de no-show', () => {
  it('vaut null — et non zéro — quand rien n’était à honorer', () => {
    // « Aucun rendez-vous à honorer » n'est pas « aucun no-show », et un 0 %
    // affiché sur un salon fermé se lirait comme une performance.
    expect(noShowRate(0, 0)).toBeNull();
    expect(noShowsOfCounts(counts({ cancelled: 5 })).rate).toBeNull();
  });

  it('exclut les annulations du dénominateur', () => {
    // Un créneau annulé a été rendu, et souvent revendu : le compter diluerait le
    // taux de tout ce que le salon a su replacer.
    expect(noShowsOfCounts(counts({ completed: 3, no_show: 1, cancelled: 96 })).rate).toBe(0.25);
  });

  it('arrondit à quatre décimales, comme le service', () => {
    expect(noShowRate(4, 118)).toBe(0.0328);
  });
});

describe('l’activité du périmètre', () => {
  const byDay = volumeReport('day', [
    { key: '2026-09-01', label: null, total: 100, byStatus: counts({ completed: 100 }) },
    { key: '2026-09-03', label: null, total: 64, byStatus: counts({ completed: 60, no_show: 4 }) },
  ]);
  const byStaff = volumeReport('staff', [
    {
      key: 'a',
      label: 'Hasina',
      total: 30,
      byStatus: counts({ completed: 24, no_show: 3, cancelled: 2, pending: 1 }),
    },
  ]);

  it('sans filtre, prend les no-shows du rapport dédié', () => {
    const activity = scopedActivity(WHOLE_TENANT, byDay, NO_SHOW_REPORT, byDay);

    expect(activity.appointments).toBe(164);
    expect(activity.noShows.rate).toBe(0.0328);
    // La ventilation par statut n'est pas inventée : le rapport de no-shows fond
    // `pending` et `confirmed` en un seul compte, et l'écran s'en tient là.
    expect(activity.byStatus).toBeNull();
  });

  it('sous filtre, recalcule depuis la ligne de l’axe', () => {
    const scope = parseReportScope('praticien:a', filterOptions(byStaff), []);
    const activity = scopedActivity(scope, byStaff, NO_SHOW_REPORT, byDay);

    expect(activity.appointments).toBe(30);
    expect(activity.noShows.noShows).toBe(3);
    expect(activity.noShows.honored).toBe(24);
    // 3 / (24 + 3), la définition du module — et non le taux d'établissement.
    expect(activity.noShows.rate).toBeCloseTo(0.1111, 4);
  });

  it('rend des zéros plutôt qu’une erreur sur une ligne absente', () => {
    const activity = scopedActivity(
      { kind: 'praticien', key: 'fantome', label: 'Fantôme' },
      byStaff,
      NO_SHOW_REPORT,
      byDay,
    );

    expect(activity.appointments).toBe(0);
    expect(activity.noShows.rate).toBeNull();
  });
});

describe('les barres du graphique de volume', () => {
  const byDay = volumeReport('day', [
    { key: '2026-09-03', label: null, total: 64, byStatus: counts({ completed: 60, no_show: 4 }) },
  ]);
  const byStaff = volumeReport('staff', [
    { key: 'b', label: 'Tiana', total: 76, byStatus: counts({ completed: 76 }) },
    { key: 'a', label: 'Hasina', total: 88, byStatus: counts({ completed: 85, no_show: 3 }) },
  ]);

  it('couvre toute la période sur l’axe temporel, journées vides comprises', () => {
    const points = volumePoints(WHOLE_TENANT, byDay, RANGE, (date) => date);

    expect(points.map((point) => point.key)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
    expect(points[2]).toMatchObject({ total: 64, noShows: 4 });
    expect(points[0]).toMatchObject({ total: 0, noShows: 0 });
  });

  it('classe l’axe nominal et met en avant la valeur retenue', () => {
    // Montrer la seule barre sélectionnée priverait du repère qui compte : ce que
    // font les autres.
    const scope = parseReportScope('praticien:a', filterOptions(byStaff), []);
    const points = volumePoints(scope, byStaff, RANGE, (date) => date);

    expect(points.map((point) => point.label)).toEqual(['Hasina', 'Tiana']);
    expect(points[0]?.selected).toBe(true);
    expect(points[1]?.selected).toBe(false);
  });

  it('nomme les groupes sans libellé plutôt que de les taire', () => {
    const orphan = volumeReport('staff', [
      { key: 'x', label: null, total: 5, byStatus: counts({ completed: 5 }) },
    ]);

    expect(volumePoints(WHOLE_TENANT, orphan, RANGE, (date) => date)[0]?.label).toBe(
      'Non attribué',
    );
  });
});
