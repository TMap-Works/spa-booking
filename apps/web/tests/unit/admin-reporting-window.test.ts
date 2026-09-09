import { describe, expect, it } from 'vitest';

import {
  MAX_REPORT_WINDOW_DAYS,
  daysInRange,
  parseReportDate,
  parseReportPeriod,
  rangeLabel,
  rangeOfPeriod,
  rangeRefusal,
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
