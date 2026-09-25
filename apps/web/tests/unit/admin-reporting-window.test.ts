import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_WINDOW_DAYS,
  daysInRange,
  parseReportDate,
  parseReportPeriod,
  rangeLabel,
  rangeOfPeriod,
  rangeRefusal,
  reportPeriodLabels,
  resolveReportRange,
  shortDayLabel,
  startOfCivilDay,
  todayInTenant,
  windowOfRange,
} from '@/lib/admin/reporting-window';

/**
 * La période du tableau de bord (#75, premier critère).
 *
 * Le repère de tout ce fichier est un salon **à l'est de Greenwich** —
 * `Indian/Antananarivo`, UTC+3, sans heure d'été — parce que c'est là que
 * l'erreur classique se voit : lire les bornes en UTC ferait commencer la
 * journée de caisse trois heures trop tard, et la recette de 21 h basculerait au
 * lendemain.
 */

const TANA = 'Indian/Antananarivo';
const PARIS = 'Europe/Paris';

describe('la journée civile du salon, en instants', () => {
  it('commence à minuit local, pas à minuit UTC', () => {
    expect(startOfCivilDay('2026-09-03', TANA).toISOString()).toBe('2026-09-02T21:00:00.000Z');
  });

  it('suit le décalage d’été là où il existe', () => {
    // Paris est à UTC+2 en septembre, UTC+1 en janvier : une conversion qui
    // figerait un décalage se tromperait d'une heure la moitié de l'année.
    expect(startOfCivilDay('2026-09-03', PARIS).toISOString()).toBe('2026-09-02T22:00:00.000Z');
    expect(startOfCivilDay('2026-01-03', PARIS).toISOString()).toBe('2026-01-02T23:00:00.000Z');
  });

  it('traverse la bascule d’heure d’été sans se décaler', () => {
    // 29 mars 2026 : la France passe à l'heure d'été à 2 h locale. La veille est
    // encore à UTC+1, le jour même déjà à UTC+2 — c'est le cas que la seconde
    // passe de `startOfCivilDay` existe pour attraper.
    expect(startOfCivilDay('2026-03-28', PARIS).toISOString()).toBe('2026-03-27T23:00:00.000Z');
    expect(startOfCivilDay('2026-03-30', PARIS).toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });
});

describe('la fenêtre envoyée à l’API', () => {
  it('exclut sa borne de fin en ajoutant la journée affichée', () => {
    // Le piège du ticket : s'arrêter à minuit du 30 amputerait le rapport de la
    // journée du 30 entière, alors que l'écran annonce « au 30 inclus ».
    expect(windowOfRange({ from: '2026-09-01', to: '2026-09-30' }, TANA)).toEqual({
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-30T21:00:00.000Z',
    });
  });

  it('rend une fenêtre non vide sur une plage d’un seul jour', () => {
    const window = windowOfRange({ from: '2026-09-03', to: '2026-09-03' }, TANA);

    expect(new Date(window.to).getTime() - new Date(window.from).getTime()).toBe(24 * 3600 * 1000);
  });
});

describe('les périodes proposées', () => {
  // Un mercredi, comme les suites du planning : la période glissante ne doit pas
  // dépendre du jour de la semaine.
  const now = new Date('2026-09-16T08:30:00Z');

  it('termine les périodes glissantes aujourd’hui, pas hier', () => {
    // La matinée qu'on vient de faire compte : l'escamoter donnerait un tableau
    // de bord toujours en retard d'un jour.
    expect(rangeOfPeriod('sept-jours', TANA, now)).toEqual({
      from: '2026-09-10',
      to: '2026-09-16',
    });
    expect(daysInRange(rangeOfPeriod('sept-jours', TANA, now))).toBe(7);
    expect(daysInRange(rangeOfPeriod('trente-jours', TANA, now))).toBe(30);
  });

  it('borne le mois courant au premier du mois', () => {
    expect(rangeOfPeriod('mois-courant', TANA, now)).toEqual({
      from: '2026-09-01',
      to: '2026-09-16',
    });
  });

  it('rend le mois précédent entier, dernier jour compris', () => {
    expect(rangeOfPeriod('mois-precedent', TANA, now)).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('lit « aujourd’hui » dans le salon et non dans le navigateur', () => {
    // 2026-09-16T22:30Z est déjà le 17 à Antananarivo. Un tableau de bord qui
    // lirait l'horloge du serveur ouvrirait sur la veille de ce que l'équipe vit.
    const evening = new Date('2026-09-16T22:30:00Z');

    expect(todayInTenant(TANA, evening)).toBe('2026-09-17');
    expect(todayInTenant('Pacific/Tahiti', evening)).toBe('2026-09-16');
  });

  it('retombe sur la période par défaut quand « personnalisée » n’a pas de bornes', () => {
    expect(rangeOfPeriod('personnalisee', TANA, now)).toEqual(
      rangeOfPeriod('trente-jours', TANA, now),
    );
    expect(resolveReportRange('personnalisee', null, null, TANA, now)).toEqual(
      rangeOfPeriod('trente-jours', TANA, now),
    );
    // Une seule borne ne décrit rien : compléter l'autre au jugé afficherait une
    // période que personne n'a demandée.
    expect(resolveReportRange('personnalisee', '2026-01-01', null, TANA, now)).toEqual(
      rangeOfPeriod('trente-jours', TANA, now),
    );
  });

  it('retient les deux bornes d’une période personnalisée', () => {
    expect(resolveReportRange('personnalisee', '2026-01-01', '2026-01-31', TANA, now)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });
});

describe('les refus que l’API opposerait', () => {
  it('refuse une fenêtre inversée', () => {
    expect(rangeRefusal({ from: '2026-09-30', to: '2026-09-01' })).toMatch(/précède/);
  });

  it('accepte exactement le plafond et refuse le jour de trop', () => {
    // 366 jours, et non 365 : « l'année 2028 » est bissextile, et la borne haute
    // étant incluse à l'écran, du 1er janvier au 31 décembre fait bien 366 jours.
    expect(daysInRange({ from: '2028-01-01', to: '2028-12-31' })).toBe(MAX_REPORT_WINDOW_DAYS);
    expect(rangeRefusal({ from: '2028-01-01', to: '2028-12-31' })).toBeNull();
    expect(rangeRefusal({ from: '2028-01-01', to: '2029-01-01' })).toMatch(/367/);
  });

  it('accepte une journée seule', () => {
    expect(rangeRefusal({ from: '2026-09-03', to: '2026-09-03' })).toBeNull();
  });

  it('refuse une borne vidée plutôt que de la laisser passer', () => {
    // Un champ de date rendu vide donne `''` : ni la comparaison ni le comptage
    // de journées n'en disent rien — `NaN > 366` est faux. Sans ce refus, la
    // saisie partait telle quelle et l'écran retombait en silence sur les trente
    // derniers jours, tout en affichant « Période personnalisée ».
    expect(rangeRefusal({ from: '', to: '2026-09-30' })).toMatch(/bornes/);
    expect(rangeRefusal({ from: '2026-09-01', to: '' })).toMatch(/bornes/);
    expect(rangeRefusal({ from: '2026-02-31', to: '2026-03-05' })).toMatch(/bornes/);
  });
});

describe('ce que l’URL porte', () => {
  it('retombe sur la période par défaut sur une valeur inconnue', () => {
    expect(parseReportPeriod(undefined)).toBe('trente-jours');
    expect(parseReportPeriod('n’importe quoi')).toBe('trente-jours');
    expect(parseReportPeriod('mois-precedent')).toBe('mois-precedent');
  });

  it('refuse une date bien formée qui n’existe pas', () => {
    expect(parseReportDate('2026-02-31')).toBeNull();
    expect(parseReportDate('03/09/2026')).toBeNull();
    expect(parseReportDate(undefined)).toBeNull();
    expect(parseReportDate('2026-09-03')).toBe('2026-09-03');
  });
});

describe('les libellés', () => {
  it('n’ajoute pas le mois deux fois quand la période n’en couvre qu’un', () => {
    expect(rangeLabel({ from: '2026-09-01', to: '2026-09-30' })).toBe('1 – 30 septembre 2026');
  });

  it('nomme les deux mois d’une période à cheval', () => {
    expect(rangeLabel({ from: '2026-08-24', to: '2026-09-06' })).toBe('24 août – 6 septembre 2026');
  });

  it('écrit une journée seule en toutes lettres', () => {
    expect(rangeLabel({ from: '2026-09-03', to: '2026-09-03' })).toBe('3 septembre 2026');
  });

  it('met en forme les dates civiles hors de tout fuseau', () => {
    // Une date civile est **déjà** celle du salon : la reprojeter dans son fuseau
    // la décalerait d'un jour pour tout salon à l'est de Greenwich.
    expect(shortDayLabel('2026-09-03')).toBe('3 sept.');
  });
});

/**
 * La langue des libellés — #851, premier et deuxième critères.
 *
 * Ce que ces cas gardent : que les **mots** suivent la langue, que la **région**
 * vient du pays de l'établissement, et que ni l'une ni l'autre ne déplace une
 * journée — une date civile reste la même date des deux côtés.
 */
describe('la langue des libellés', () => {
  it('écrit la période dans la langue demandée', () => {
    const range = { from: '2026-09-01', to: '2026-09-30' } as const;

    expect(rangeLabel(range, { locale: 'fr' })).toBe('1 – 30 septembre 2026');
    expect(rangeLabel(range, { locale: 'en', countryCode: 'GB' })).toBe('1 – 30 September 2026');
  });

  it('prend la région au pays de l’établissement, jamais au navigateur', () => {
    // Un salon montréalais écrit ses dates comme le Québec, en français comme en
    // anglais : la langue dit les mots, la région dit l'ordre et la ponctuation.
    const jour = { from: '2026-09-03', to: '2026-09-03' } as const;

    expect(rangeLabel(jour, { locale: 'en', countryCode: 'GB' })).toBe('3 September 2026');
    expect(rangeLabel(jour, { locale: 'en', countryCode: 'US' })).toBe('September 3, 2026');
  });

  it('abrège l’abscisse d’un graphique quotidien dans la langue de l’écran', () => {
    expect(shortDayLabel('2026-09-03', { locale: 'fr' })).toBe('3 sept.');
    expect(shortDayLabel('2026-09-03', { locale: 'en', countryCode: 'GB' })).toBe('3 Sept');
  });

  it('garde le français par défaut — aucun appelant ne bascule sans le demander', () => {
    // Le repli transitoire de l'épique #843 : les écrans qui lisent ce module
    // sans lui demander un mot — `rangeOfPeriod`, `windowOfRange` — n'ont pas à
    // changer de signature pour cela, et ne basculent pas de langue tout seuls.
    expect(shortDayLabel('2026-09-03')).toBe(shortDayLabel('2026-09-03', { locale: 'fr' }));
    expect(rangeLabel({ from: '2026-09-01', to: '2026-09-30' })).toBe(
      rangeLabel({ from: '2026-09-01', to: '2026-09-30' }, { locale: 'fr' }),
    );
  });

  it('dit les refus de période dans la langue de l’écran', () => {
    const inversee = { from: '2026-09-30', to: '2026-09-01' } as const;
    const trop = { from: '2020-01-01', to: '2026-09-30' } as const;

    expect(rangeRefusal(inversee, 'fr')).toMatch(/précède/);
    expect(rangeRefusal(inversee, 'en')).toMatch(/before/);
    // Le plafond reste le même nombre : seule la phrase change.
    expect(rangeRefusal(trop, 'en')).toContain(String(MAX_REPORT_WINDOW_DAYS));
    expect(rangeRefusal({ from: '2026-09-01', to: '2026-09-30' }, 'en')).toBeNull();
  });

  it('nomme les périodes du sélecteur sans traduire leur valeur d’URL', () => {
    // La clé est un segment d'URL, pas un mot : la traduire ferait qu'un lien
    // partagé entre deux collègues n'ouvre pas le même écran.
    expect(reportPeriodLabels('fr')['trente-jours']).toBe('30 derniers jours');
    expect(reportPeriodLabels('en')['trente-jours']).toBe('Last 30 days');
    expect(Object.keys(reportPeriodLabels('en'))).toEqual(Object.keys(reportPeriodLabels('fr')));
  });
});

/**
 * Une seule écriture de l'abscisse quotidienne — #1193.
 *
 * ## Pourquoi une garde de source, et pas seulement un cas d'égalité
 *
 * Le tableau de bord a longtemps eu son propre `barDayLabel` : `shortDayLabel`
 * fixait encore `fr-FR` en dur quand #1104 a branché les sept barres de la
 * semaine sur la langue de la session, et `reporting-window.ts` était hors de
 * l'empreinte de ce ticket-là. Les deux écritures ont coexisté le temps que
 * l'épique #843 déroule ses écrans, et le même jour pouvait dès lors se graduer
 * de deux façons sur deux écrans du même back-office.
 *
 * Une fois la seconde écriture supprimée, rien n'empêche la prochaine de
 * revenir : c'est une ligne de `Intl.DateTimeFormat` que n'importe quel écran
 * peut réécrire « pour ne pas dépendre du reporting ». Un cas d'égalité entre
 * deux appels de `shortDayLabel` ne le verrait pas — il ne parle que de la
 * fonction restée. C'est donc la **source** des deux écrans à graphique
 * quotidien qui est lue.
 *
 * Ce que la garde cherche est **tout formateur de date construit sur place**,
 * et non la seule option `month: 'short'` : une abscisse réécrite en
 * `dateStyle: 'medium'`, ou avec des guillemets doubles, gradue tout autant de
 * travers, et un motif collé à une orthographe se contourne sans le vouloir.
 * Ces deux écrans n'ont aucune date à mettre en forme eux-mêmes — ils lisent
 * `lib/format.ts` et ce module.
 *
 * Le périmètre s'arrête à eux. Les autres abréviations de mois de `apps/web` —
 * la pastille de date du parcours public, le planning, les absences du
 * personnel, l'axe **hebdomadaire** de la console de plateforme
 * (`app/plateforme/components/overview-widgets.tsx`) — ne sont pas l'abscisse
 * quotidienne d'un graphique de reporting, et rien ici ne les concerne.
 */
describe('l’abscisse quotidienne ne s’écrit qu’ici', () => {
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** Les deux écrans qui portent un graphique gradué en journées. */
  const CHART_SCREENS: readonly string[] = [
    'app/(admin)/[tenantSlug]/admin/tableau-de-bord/page.tsx',
    'app/(admin)/[tenantSlug]/admin/reporting/page.tsx',
  ];

  it.each(CHART_SCREENS)('%s lit shortDayLabel au lieu de réécrire son axe', (screen) => {
    const source = readFileSync(path.join(webDir, screen), 'utf8');

    expect(source).toContain('shortDayLabel');
    expect(source).not.toMatch(/Intl\.DateTimeFormat/u);
  });

  it('gradue selon la région du pays du salon, et pas seulement sa langue', () => {
    // Ce que les deux écrans affichent est désormais ce seul appel : ce cas dit
    // donc ce qu'il gradue là où les deux écrans, eux, sont tenus par la garde
    // de source ci-dessus. La région compte autant que la langue — `en-US`
    // antépose le mois là où `en-GB` (cas plus haut) le postpose.
    const jour = '2026-09-03';

    expect(shortDayLabel(jour, { locale: 'en', countryCode: 'US' })).toBe('Sep 3');
    expect(shortDayLabel(jour, { locale: 'en', countryCode: 'GB' })).toBe('3 Sept');
  });
});
