import { describe, expect, it } from 'vitest';

import {
  anchorOf,
  daysOf,
  parseCalendarDate,
  parseCalendarView,
  rangeKey,
  rangeLabel,
  rangeOf,
  shiftAnchor,
  startOfWeek,
  todayInTimeZone,
  weekdayLabel,
} from '@/lib/admin/calendar-range';

/**
 * La période affichée par le planning (#49, cinquième critère).
 *
 * Le 26 août 2026 est un **mercredi** : c'est le repère de tout ce fichier, et
 * il rend visible la seule erreur qui coûte cher ici — une semaine qui commence
 * le dimanche décalerait les sept colonnes d'un jour.
 */

describe('semaine — la borne est le lundi', () => {
  it('ramène n’importe quel jour au lundi de sa semaine', () => {
    expect(startOfWeek('2026-08-26')).toBe('2026-08-24');
    expect(startOfWeek('2026-08-24')).toBe('2026-08-24');
    // Dimanche appartient à la semaine qui l'a précédé, pas à celle qui suit :
    // `getUTCDay` rend 0 pour dimanche, et prendre ce 0 au mot ferait sauter la
    // colonne du dimanche d'une semaine à l'autre.
    expect(startOfWeek('2026-08-30')).toBe('2026-08-24');
  });

  it('donne la même plage pour deux jours de la même semaine', () => {
    expect(rangeOf('semaine', '2026-08-26')).toEqual({ from: '2026-08-24', to: '2026-08-30' });
    expect(rangeOf('semaine', '2026-08-28')).toEqual({ from: '2026-08-24', to: '2026-08-30' });
    expect(rangeKey('semaine', '2026-08-26')).toBe(rangeKey('semaine', '2026-08-28'));
  });

  it('sépare la journée de la semaine qui la contient', () => {
    // Deux jeux de rendez-vous différents : les confondre servirait un jour
    // entier là où l'écran attend une semaine.
    expect(rangeKey('jour', '2026-08-24')).not.toBe(rangeKey('semaine', '2026-08-24'));
  });
});

describe('journée — la plage se réduit à elle-même', () => {
  it('borne la plage au jour demandé', () => {
    expect(rangeOf('jour', '2026-08-26')).toEqual({ from: '2026-08-26', to: '2026-08-26' });
    expect(anchorOf('jour', '2026-08-26')).toBe('2026-08-26');
  });
});

describe('navigation entre périodes', () => {
  it('avance d’un jour en vue jour, d’une semaine en vue semaine', () => {
    expect(shiftAnchor('jour', '2026-08-26', 1)).toBe('2026-08-27');
    expect(shiftAnchor('jour', '2026-08-26', -1)).toBe('2026-08-25');
    expect(shiftAnchor('semaine', '2026-08-26', 1)).toBe('2026-08-31');
    expect(shiftAnchor('semaine', '2026-08-26', -1)).toBe('2026-08-17');
  });

  it('franchit le changement de mois sans se décaler', () => {
    expect(shiftAnchor('jour', '2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftAnchor('jour', '2026-03-01', -1)).toBe('2026-02-28');
  });

  it('déroule les sept colonnes de la semaine, dans l’ordre', () => {
    expect(daysOf(rangeOf('semaine', '2026-08-26'))).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
    ]);
  });
});

describe('lecture de l’URL', () => {
  it('retombe sur la vue jour pour tout ce qui n’est pas une vue', () => {
    expect(parseCalendarView('semaine')).toBe('semaine');
    expect(parseCalendarView('jour')).toBe('jour');
    expect(parseCalendarView('week')).toBe('jour');
    expect(parseCalendarView(undefined)).toBe('jour');
  });

  it('refuse une date qui n’existe pas au calendrier', () => {
    expect(parseCalendarDate('2026-08-26')).toBe('2026-08-26');
    // La forme est bonne et la date n'existe pas : c'est exactement le cas que
    // `calendarDateSchema` refuse côté contrat, et que le front doit refuser
    // aussi — sinon la requête part et l'API rend un 400 sans écran pour le dire.
    expect(parseCalendarDate('2026-02-31')).toBeNull();
    expect(parseCalendarDate('26/08/2026')).toBeNull();
    expect(parseCalendarDate(undefined)).toBeNull();
  });
});

describe('libellés', () => {
  it('nomme la journée en toutes lettres, première lettre en capitale', () => {
    expect(rangeLabel('jour', '2026-08-26')).toBe('Mercredi 26 août 2026');
  });

  it('nomme la semaine par ses deux bornes', () => {
    expect(rangeLabel('semaine', '2026-08-26')).toBe('24 – 30 août 2026');
  });

  it('répète le mois quand la semaine est à cheval sur deux', () => {
    // 28 septembre 2026 est un lundi ; la semaine finit le 4 octobre.
    expect(rangeLabel('semaine', '2026-09-28')).toBe('28 septembre – 4 octobre 2026');
  });

  it('nomme une colonne de la vue semaine par son jour', () => {
    expect(weekdayLabel('2026-08-24')).toMatch(/^Lun/);
    expect(weekdayLabel('2026-08-24')).toMatch(/24$/);
  });
});

describe('aujourd’hui', () => {
  it('est la journée du salon, pas celle du navigateur', () => {
    // 23 h 30 UTC : il est déjà le lendemain à Antananarivo (UTC+3), et encore
    // la veille à Honolulu (UTC-10). Un planning qui lirait l'horloge du poste
    // ouvrirait sur le mauvais jour dès qu'on le consulte de loin.
    const instant = new Date('2026-08-26T23:30:00Z');

    expect(todayInTimeZone('Indian/Antananarivo', instant)).toBe('2026-08-27');
    expect(todayInTimeZone('Pacific/Honolulu', instant)).toBe('2026-08-26');
  });
});
