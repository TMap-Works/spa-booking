import { netOf } from '../../payments/pos.totals';
import {
  buildReportExportCsv,
  reportExportCsvHeader,
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
  /** 20 % — le taux de l'établissement, tel que `tenants.tax_rate_bps` le porte. */
  taxRateBps: 2_000,
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
    expect(lines(csv)[0]).toBe(reportExportCsvHeader('fr').join(';'));
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

  it('porte le montant hors taxes à côté du brut, par jour et par moyen de paiement', () => {
    const rows = lines(buildReportExportCsv(CONTENT));

    // 120,00 € TTC à 20 % font 100,00 € HT — le premier critère de #891.
    expect(rows).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;ht_minor;10000;EUR');
    expect(rows).toContain('revenu_total;CARD-EUR;CARD;ht_minor;10000;EUR');
  });

  it('range le hors taxes **immédiatement après** le brut, jamais ailleurs', () => {
    // « À côté du brut » se lit dans le fichier, pas seulement dans l'issue :
    // une mesure rangée après `net_minor` obligerait à chercher dans un tableur.
    const rows = lines(buildReportExportCsv(CONTENT));
    const brut = rows.findIndex((line) => line.includes(';brut_minor;'));

    expect(rows[brut + 1]).toContain(';ht_minor;');
  });

  it('extrait le hors taxes du **brut**, jamais du net de remboursements', () => {
    // Un remboursement défait une vente ; ce n'est pas une base taxable de
    // moins. `ht_minor` porte donc sur `brut_minor` (12 000) et non sur
    // `net_minor` (10 500), dont le hors-taxes vaudrait 8 750.
    const rows = lines(buildReportExportCsv(CONTENT));

    expect(rows).not.toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;ht_minor;8750;EUR');
  });

  it('applique le taux reçu, et non un taux écrit dans le sérialiseur', () => {
    // Le même fichier, le même brut, un autre établissement : si la valeur ne
    // bougeait pas, c'est qu'une constante aurait remplacé le taux lu en base
    // (troisième critère de #891).
    const aDixPourCent = lines(buildReportExportCsv({ ...CONTENT, taxRateBps: 1_000 }));

    expect(aDixPourCent).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;ht_minor;10909;EUR');
  });

  it('rend un hors taxes égal au brut pour un établissement à taux nul', () => {
    // Quatrième critère de #891 : aucune taxe à extraire, le prix affiché *est*
    // le montant hors taxes.
    const rows = lines(buildReportExportCsv({ ...CONTENT, taxRateBps: 0 }));

    expect(rows).toContain('revenu_jour;2026-09-03;2026-09-03 · CARD;ht_minor;12000;EUR');
    expect(rows).toContain('revenu_total;CARD-EUR;CARD;ht_minor;12000;EUR');
  });

  it('reprend l’arrondi de `netOf`, sans en réinventer un second', () => {
    // C'est *le* deuxième critère de #891 : 65,00 € à 20 % valent 54,17 € au
    // comptoir, et doivent valoir 54,17 € dans le fichier. Une règle d'arrondi
    // recopiée ici rendrait 54,16 € le jour où l'une des deux dérive — c'est la
    // divergence que #816 vient de corriger.
    const jour = {
      date: '2026-09-04',
      method: 'CASH' as const,
      currency: 'EUR',
      transactions: 1,
      grossAmountMinor: 6_500,
      refundedAmountMinor: 0,
      netAmountMinor: 6_500,
    };
    const csv = buildReportExportCsv({
      ...CONTENT,
      revenue: {
        ...CONTENT.revenue,
        days: [jour],
        totals: [
          {
            method: 'CASH',
            currency: 'EUR',
            transactions: 1,
            grossAmountMinor: 6_500,
            refundedAmountMinor: 0,
            netAmountMinor: 6_500,
          },
        ],
      },
    });

    expect(netOf(6_500, 2_000)).toBe(5_417);
    expect(lines(csv)).toContain('revenu_jour;2026-09-04;2026-09-04 · CASH;ht_minor;5417;EUR');
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
      'no_shows;;Taux de no-show sur les rendez-vous arrivés à échéance;taux;0,5;',
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

/**
 * La langue du fichier — #851, troisième et quatrième critères.
 *
 * Trois propriétés, et chacune se casse en silence : l'en-tête suit la langue,
 * les deux séparateurs la suivent **ensemble**, et les chiffres ne la suivent
 * pas du tout.
 */
describe('buildReportExportCsv — la langue', () => {
  /** La ligne du taux de no-show, la seule valeur fractionnaire du fichier. */
  const taux = (csv: string): string =>
    lines(csv).find((line) => line.includes('taux')) ?? '';

  it('traduit la ligne d’en-tête', () => {
    expect(lines(buildReportExportCsv({ ...CONTENT, locale: 'fr' }))[0]).toBe(
      'section;cle;libelle;mesure;valeur;devise',
    );
    expect(lines(buildReportExportCsv({ ...CONTENT, locale: 'en' }))[0]).toBe(
      'section,key,label,measure,value,currency',
    );
  });

  it('traduit la colonne des libellés, et **pas** les codes de section ni de mesure', () => {
    // Traduire `section` et `mesure` ferait qu'un export de septembre en
    // français et un export d'octobre en anglais cessent de s'empiler dans le
    // même tableau croisé — alors que la forme longue a été choisie pour cela.
    const rows = lines(buildReportExportCsv({ ...CONTENT, locale: 'en' }));

    expect(rows).toContain('periode,,Window start (inclusive),debut_utc,2026-08-31T22:00:00.000Z,');
    expect(rows).toContain('no_shows,,No-show appointments,no_shows,1,');
    expect(rows).toContain('volume_day,,All groups combined,rendez_vous,3,');
    expect(rows).toContain('revenu_total,CARD-EUR,CARD,net_minor,10500,EUR');
  });

  it('sépare par « ; » et écrit la décimale « , » en français', () => {
    // Un CSV à virgules atterrit en une seule colonne dans un tableur français,
    // où la virgule est le séparateur décimal : les deux choix vont ensemble.
    expect(taux(buildReportExportCsv({ ...CONTENT, locale: 'fr' }))).toBe(
      'no_shows;;Taux de no-show sur les rendez-vous arrivés à échéance;taux;0,5;',
    );
  });

  it('sépare par « , » et écrit la décimale « . » en anglais', () => {
    expect(taux(buildReportExportCsv({ ...CONTENT, locale: 'en' }))).toBe(
      'no_shows,,No-show rate over appointments that came due,taux,0.5,',
    );
  });

  it('écrit en français quand la demande ne porte aucune langue', () => {
    // Le repli d'avant le ticket : un appelant qui ne demande rien reçoit le
    // fichier qu'il recevait.
    expect(buildReportExportCsv(CONTENT)).toBe(
      buildReportExportCsv({ ...CONTENT, locale: 'fr' }),
    );
  });

  it('échappe le champ qui contient le séparateur **de sa langue**', () => {
    const avecVirgule = {
      ...CONTENT,
      volumes: [
        {
          window: CONTENT.window,
          timeZone: CONTENT.timeZone,
          groupBy: 'service' as const,
          rows: [
            {
              key: 'sv-1',
              label: 'Forfait duo, 90 min',
              total: 1,
              byStatus: { PENDING: 0, CONFIRMED: 0, COMPLETED: 1, CANCELLED: 0, NO_SHOW: 0 },
            },
          ],
          total: 1,
        },
      ],
    };

    // La virgule ne gêne pas le fichier français et couperait la ligne anglaise
    // en deux colonnes de plus.
    expect(buildReportExportCsv({ ...avecVirgule, locale: 'en' })).toContain(
      '"Forfait duo, 90 min"',
    );
    expect(buildReportExportCsv({ ...avecVirgule, locale: 'fr' })).not.toContain(
      '"Forfait duo, 90 min"',
    );
  });

  it('ne touche ni aux montants, ni à leur devise, ni au fuseau', () => {
    // L'argent reste un entier de la plus petite unité monétaire quelle que soit
    // la langue (`CLAUDE.md`), et le fuseau de découpage des journées est celui
    // de l'établissement — la langue dit comment on écrit, pas ce qu'on compte.
    for (const [locale, separator] of [
      ['fr', ';'],
      ['en', ','],
    ] as const) {
      const rows = lines(buildReportExportCsv({ ...CONTENT, locale }));
      const montants = rows.filter((line) => line.includes('_minor'));

      expect(montants).not.toHaveLength(0);
      for (const line of montants) {
        expect(line.split(separator)[4]).toMatch(/^-?\d+$/);
      }

      expect(rows.some((line) => line.includes('Europe/Paris'))).toBe(true);
    }
  });
});
