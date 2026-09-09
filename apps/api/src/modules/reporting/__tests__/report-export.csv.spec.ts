import {
  REPORT_EXPORT_CSV_HEADER,
  buildReportExportCsv,
  type ReportExportContent,
} from '../export/report-export.csv';

/**
 * La sérialisation CSV de l'export — #563, sixième critère de #75.
 *
 * Ce que ces cas prouvent, et rien d'autre : **la forme du fichier**. Les
 * chiffres qu'il porte sont ceux que les trois rapports rendent, et ce sont
 * `reporting.service.spec.ts` et `reporting.repository.spec.ts` qui en
 * répondent — les rejouer ici ne prouverait que la fidélité d'une fixture à
 * elle-même.
 *
 * Trois propriétés valent le détour, parce que chacune se casse en silence :
 * l'argent reste entier et gardé de sa devise, la marque d'ordre d'octets est en
 * tête, et un libellé qui contient le séparateur ne coupe pas la ligne en deux.
 */

const CONTENT: ReportExportContent = {
  window: { from: new Date('2026-08-31T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z') },
  timeZone: 'Europe/Paris',
  revenue: {
    window: { from: new Date('2026-08-31T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z') },
    timeZone: 'Europe/Paris',
    days: [
      {
        date: '2026-09-03',
        method: 'CARD',
        currency: 'EUR',
        transactions: 2,
        grossAmountMinor: 12_000,
        refundedAmountMinor: 1_500,
        netAmountMinor: 10_500,
      },
    ],
    totals: [
      {
        method: 'CARD',
        currency: 'EUR',
        transactions: 2,
        grossAmountMinor: 12_000,
        refundedAmountMinor: 1_500,
        netAmountMinor: 10_500,
      },
    ],
  },
  volumes: [
    {
      window: { from: new Date('2026-08-31T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z') },
      groupBy: 'day',
      timeZone: 'Europe/Paris',
      rows: [
        {
          key: '2026-09-03',
          label: null,
          total: 3,
          byStatus: { PENDING: 0, CONFIRMED: 1, COMPLETED: 1, CANCELLED: 0, NO_SHOW: 1 },
        },
      ],
      total: 3,
    },
    {
      window: { from: new Date('2026-08-31T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z') },
      groupBy: 'staff',
      timeZone: 'Europe/Paris',
      rows: [
        {
          key: '33333333-3333-4333-8333-333333333333',
          label: 'Camille',
          total: 3,
          byStatus: { PENDING: 0, CONFIRMED: 1, COMPLETED: 1, CANCELLED: 0, NO_SHOW: 1 },
        },
      ],
      total: 3,
    },
  ],
  noShows: {
    window: { from: new Date('2026-08-31T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z') },
    timeZone: 'Europe/Paris',
    noShows: 1,
    honored: 1,
    cancelled: 0,
    pending: 1,
    total: 3,
    rate: 0.5,
  },
};

/** Les lignes du fichier, marque d'ordre d'octets et fin de fichier retirées. */
function lines(csv: string): string[] {
  return csv.replace('\uFEFF', '').trimEnd().split('\r\n');
}

describe('buildReportExportCsv', () => {
  it('ouvre sur la marque d’ordre d’octets, puis l’en-tête à six colonnes', () => {
    const csv = buildReportExportCsv(CONTENT);

    // Sans la marque, « Prestations bien-être » s'ouvre en « PrestationsÂ
    // bien-Ãªtre » dans le tableur d'une gérante en locale française.
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)[0]).toBe(REPORT_EXPORT_CSV_HEADER.join(';'));
  });

  it('termine chaque ligne par CRLF, comme RFC 4180', () => {
    expect(buildReportExportCsv(CONTENT).endsWith('\r\n')).toBe(true);
  });

  it('rappelle la période et le fuseau dans lequel les journées ont été découpées', () => {
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).toContain('periode;;Début de la fenêtre (inclus);debut_utc;2026-08-31T22:00:00.000Z;');
    expect(rows).toContain('periode;;Fin de la fenêtre (exclue);fin_utc;2026-09-30T22:00:00.000Z;');
    expect(rows).toContain('periode;;Fuseau de découpage des journées;fuseau;Europe/Paris;');
  });

  it('écrit les montants en entiers de plus petite unité, avec leur devise', () => {
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;brut_minor;12000;EUR');
    expect(rows).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;rembourse_minor;1500;EUR');
    expect(rows).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;net_minor;10500;EUR');
    expect(rows).toContain('revenu_total;CARD-EUR;CARD;net_minor;10500;EUR');
  });

  it('n’écrit aucun montant en unité principale — pas un seul séparateur décimal', () => {
    const montants = lines(buildReportExportCsv(CONTENT)).filter((line) => line.includes('_minor;'));

    expect(montants).not.toHaveLength(0);
    for (const line of montants) {
      const valeur = line.split(';')[4] ?? '';
      // `120.00` ou `120,00` sont exactement ce que la règle « jamais de float »
      // interdit : un centime perdu sur un cumul d'année ne se retrouve plus.
      expect(valeur).toMatch(/^-?\d+$/);
    }
  });

  it('ventile le volume par statut et clôt chaque axe sur son total', () => {
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).toContain('volume_day;2026-09-03;2026-09-03;rendez_vous;3;');
    expect(rows).toContain('volume_day;2026-09-03;2026-09-03;statut_no_show;1;');
    expect(rows).toContain('volume_day;2026-09-03;2026-09-03;statut_cancelled;0;');
    expect(rows).toContain('volume_day;;Tous groupes confondus;rendez_vous;3;');
  });

  it('donne une section par axe — le fichier ne dépend pas du filtre affiché', () => {
    // L'export de #75 ne portait que l'axe filtré à l'écran. Celui-ci porte les
    // trois : un seul fichier répond aux trois questions.
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).toContain(
      'volume_staff;33333333-3333-4333-8333-333333333333;Camille;rendez_vous;3;',
    );
    expect(rows).toContain('volume_staff;;Tous groupes confondus;rendez_vous;3;');
  });

  it('reprend la clé en libellé sur l’axe « jour », où le libellé est nul', () => {
    // Un trou dans la colonne `libelle` ferait qu'un tri par libellé dans le
    // tableur rassemblerait toutes les journées sous une case vide.
    const jour = lines(buildReportExportCsv(CONTENT)).find((line) =>
      line.startsWith('volume_day;2026-09-03;'),
    );

    expect(jour?.split(';')[2]).toBe('2026-09-03');
  });

  it('rend les cinq comptes de no-show et le taux', () => {
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).toContain('no_shows;;Rendez-vous non honorés;no_shows;1;');
    expect(rows).toContain(
      'no_shows;;Taux de no-show sur les rendez-vous arrivés à échéance;taux;0.5;',
    );
  });

  it('laisse le taux **vide** quand aucun rendez-vous n’était à honorer', () => {
    // Et non `0` : « rien à honorer » n'est pas « aucun no-show », et un zéro
    // dans un tableur se moyenne, se somme, et finit par ressembler à une
    // performance.
    const csv = buildReportExportCsv({
      ...CONTENT,
      noShows: { ...CONTENT.noShows, noShows: 0, honored: 0, total: 0, rate: null },
    });

    expect(lines(csv)).toContain(
      'no_shows;;Taux de no-show sur les rendez-vous arrivés à échéance;taux;;',
    );
  });

  it('échappe un libellé qui porte le séparateur, un guillemet ou un saut de ligne', () => {
    const csv = buildReportExportCsv({
      ...CONTENT,
      volumes: [
        {
          window: CONTENT.window,
          timeZone: CONTENT.timeZone,
          groupBy: 'service',
          rows: [
            {
              key: 'sv-1',
              label: 'Massage 60 min ; dos et "nuque"',
              total: 1,
              byStatus: { PENDING: 0, CONFIRMED: 0, COMPLETED: 1, CANCELLED: 0, NO_SHOW: 0 },
            },
          ],
          total: 1,
        },
      ],
    });

    const ligne = lines(csv).find((line) => line.startsWith('volume_service;sv-1;'));

    // Sans échappement, ce libellé couperait la ligne en deux colonnes de plus
    // et décalerait toute la fin du fichier d'un cran.
    expect(ligne).toContain('"Massage 60 min ; dos et ""nuque"""');
  });

  it('n’invente pas les jours sans recette', () => {
    const csv = buildReportExportCsv({
      ...CONTENT,
      revenue: { ...CONTENT.revenue, days: [], totals: [] },
    });

    expect(lines(csv).some((line) => line.startsWith('revenu_jour;'))).toBe(false);
  });
});
