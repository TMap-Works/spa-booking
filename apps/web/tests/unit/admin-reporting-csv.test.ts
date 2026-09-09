import { describe, expect, it } from 'vitest';

import {
  REPORT_CSV_HEADER,
  buildReportCsv,
  reportCsvFilename,
  reportCsvRows,
  type ReportCsvInput,
} from '@/lib/admin/reporting-csv';
import { WHOLE_TENANT } from '@/lib/admin/reporting-view';

/**
 * L'export CSV (#75, quatrième critère) et son nom de fichier (cinquième
 * critère, pour la part qui se tient côté web).
 *
 * Deux propriétés valent d'être vérifiées par exécution plutôt que relues :
 * **l'argent reste entier** — un export en unité principale aurait réintroduit
 * le flottant que `CLAUDE.md` interdit —, et **le fichier est préfixé par
 * l'établissement**, sans quoi deux salons exportés depuis le même poste se
 * recouvriraient dans le dossier de téléchargements.
 */

const RANGE = { from: '2026-09-01', to: '2026-09-30' };

const INPUT: ReportCsvInput = {
  range: RANGE,
  timeZone: 'Indian/Antananarivo',
  scope: WHOLE_TENANT,
  revenueTotals: [
    {
      currency: 'MGA',
      transactions: 3,
      grossAmountMinor: 80_000,
      refundedAmountMinor: 5_000,
      netAmountMinor: 75_000,
    },
  ],
  revenueSeries: [
    {
      currency: 'MGA',
      days: [
        {
          date: '2026-09-01',
          transactions: 3,
          grossAmountMinor: 80_000,
          refundedAmountMinor: 5_000,
          netAmountMinor: 75_000,
        },
      ],
    },
  ],
  revenueByMethod: [
    {
      method: 'card',
      currency: 'MGA',
      transactions: 2,
      grossAmountMinor: 60_000,
      refundedAmountMinor: 0,
      netAmountMinor: 60_000,
    },
  ],
  volumeAxis: 'jour',
  volume: [
    { key: '2026-09-01', label: '1 sept.', total: 12, noShows: 1, selected: false },
  ],
  appointments: 164,
  noShows: {
    noShows: 4,
    honored: 118,
    cancelled: 9,
    pending: 33,
    total: 164,
    rate: 0.0328,
  },
};

/** Les lignes d'une section, en clair — pour dire ce qu'on regarde. */
function section(rows: string[][], name: string): string[][] {
  return rows.filter((row) => row[0] === name);
}

describe('le nom du fichier', () => {
  it('préfixe par l’établissement et porte la période', () => {
    expect(reportCsvFilename('maison-lotus', RANGE)).toBe(
      'maison-lotus-reporting-2026-09-01_2026-09-30.csv',
    );
  });

  it('assainit le slug plutôt que de le recopier', () => {
    // Le slug vient de l'URL, et un nom de fichier n'est pas un chemin : rien
    // qui ressemble à un séparateur ne doit pouvoir s'y glisser.
    expect(reportCsvFilename('../../etc/passwd', RANGE)).toBe(
      'etc-passwd-reporting-2026-09-01_2026-09-30.csv',
    );
    expect(reportCsvFilename('Maison Lotus', RANGE)).toBe(
      'maison-lotus-reporting-2026-09-01_2026-09-30.csv',
    );
    expect(reportCsvFilename('!!!', RANGE)).toBe(
      'etablissement-reporting-2026-09-01_2026-09-30.csv',
    );
  });
});

describe('les lignes du fichier', () => {
  const rows = reportCsvRows(INPUT);

  it('annonce la période et le fuseau qui la découpe', () => {
    expect(section(rows, 'periode')).toEqual([
      ['periode', '', '', 'du', '2026-09-01', ''],
      ['periode', '', '', 'au', '2026-09-30', ''],
      ['periode', '', '', 'fuseau', 'Indian/Antananarivo', ''],
    ]);
  });

  it('exporte l’argent en entiers de la plus petite unité, avec sa devise', () => {
    // La règle du dépôt : jamais de flottant sur un montant. Un export en unité
    // principale l'aurait réintroduit, et un centime perdu sur un cumul d'année
    // ne se retrouve plus.
    const totals = section(rows, 'revenu-total');

    expect(totals).toContainEqual(['revenu-total', '', '', 'net_minor', '75000', 'MGA']);
    expect(totals).toContainEqual(['revenu-total', '', '', 'rembourse_minor', '5000', 'MGA']);
    for (const row of totals) {
      expect(row[4]).toMatch(/^-?\d+$/);
      expect(row[5]).toBe('MGA');
    }
  });

  it('garde le taux vide quand aucun rendez-vous n’était à honorer', () => {
    const withoutRate = reportCsvRows({
      ...INPUT,
      noShows: { ...INPUT.noShows, noShows: 0, honored: 0, rate: null },
    });

    expect(section(withoutRate, 'indicateurs')).toContainEqual([
      'indicateurs',
      '',
      '',
      'taux_no_show',
      '',
      '',
    ]);
    expect(section(rows, 'indicateurs')).toContainEqual([
      'indicateurs',
      '',
      '',
      'taux_no_show',
      '0.0328',
      '',
    ]);
  });

  it('nomme la section de volume d’après l’axe affiché', () => {
    expect(section(rows, 'volume-jour')).toHaveLength(2);

    const filtered = reportCsvRows({ ...INPUT, volumeAxis: 'praticien' });

    expect(section(filtered, 'volume-praticien')).toHaveLength(2);
    expect(section(filtered, 'volume-jour')).toHaveLength(0);
  });

  it('donne six colonnes à chaque ligne, en-tête compris', () => {
    for (const row of [REPORT_CSV_HEADER, ...rows]) {
      expect(row).toHaveLength(6);
    }
  });
});

describe('la mise en forme du fichier', () => {
  it('pose la marque d’ordre d’octets et des fins de ligne RFC 4180', () => {
    const csv = buildReportCsv(INPUT);

    // Sans la marque, « Prestations bien-être » s'ouvre en « bien-Ãªtre ».
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.includes('\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')[0]).toBe('﻿section;cle;libelle;mesure;valeur;devise');
  });

  it('encadre les champs qui contiennent le séparateur ou un guillemet', () => {
    const csv = buildReportCsv({
      ...INPUT,
      scope: { kind: 'prestation', key: 's1', label: 'Massage « détente » ; 60 min' },
    });

    expect(csv).toContain('"Massage « détente » ; 60 min"');
  });

  it('double les guillemets plutôt que de les échapper', () => {
    const csv = buildReportCsv({
      ...INPUT,
      scope: { kind: 'praticien', key: 'a', label: 'Ha"sina' },
    });

    expect(csv).toContain('"Ha""sina"');
    expect(csv).not.toContain('\\"');
  });

  it('neutralise un libellé que le tableur prendrait pour une formule', () => {
    // Les libellés viennent du catalogue du salon, donc d'une saisie. Une
    // prestation nommée `=HYPERLINK(…)` est exécutée à l'ouverture par Excel
    // comme par LibreOffice — c'est l'injection de formule CSV, et elle n'exige
    // que l'ouverture du fichier par la gérante.
    const csv = buildReportCsv({
      ...INPUT,
      scope: { kind: 'prestation', key: 's1', label: '=HYPERLINK("http://exemple";"Facture")' },
    });

    expect(csv).not.toContain(';=HYPERLINK');
    expect(csv).toContain("'=HYPERLINK");
  });

  it('laisse les montants négatifs se sommer dans le tableur', () => {
    // Un net négatif s'écrit `-1200` : le préfixer en ferait du texte, et
    // l'export cesserait de s'additionner — tout ce qu'on lui demande.
    const csv = buildReportCsv({
      ...INPUT,
      revenueTotals: [
        {
          currency: 'EUR',
          transactions: 2,
          grossAmountMinor: 1_000,
          refundedAmountMinor: 2_200,
          netAmountMinor: -1_200,
        },
      ],
    });

    expect(csv).toContain(';net_minor;-1200;EUR');
    expect(csv).not.toContain("'-1200");
  });
});
