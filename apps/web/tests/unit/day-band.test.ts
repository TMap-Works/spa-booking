/**
 * La trame de la bande de jours (#1049).
 *
 * L'arithmétique vit hors du composant pour s'éprouver sans monter de DOM — les
 * mêmes raisons que [`month-grid.ts`](../../lib/booking/month-grid.ts) et
 * [`slots.ts`](../../lib/booking/slots.ts) : le sélecteur de créneau est le
 * contrôle le plus souvent raté du parcours (skill `web-frontend` §7), et les
 * règles qui décident ce qu'il montre méritent leurs propres épreuves.
 */

import type { CalendarDate } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  BAND_DAYS,
  BAND_STEP,
  bandDates,
  bandEntryDate,
  bandMoveForKey,
  bandSlice,
  bandStart,
  bandStartShowing,
  bandWindow,
  moveInBand,
} from '@/lib/booking/day-band';
import type { BookingWindow } from '@/lib/booking/month-grid';

/** Du 10 septembre au 10 octobre 2026 — trente et une journées, deux mois. */
const BOUNDS: BookingWindow = {
  first: '2026-09-10' as CalendarDate,
  last: '2026-10-10' as CalendarDate,
};

describe('les journées que la bande peut montrer', () => {
  it('s’en tient au mois chargé, rogné aux bornes réservables', () => {
    // C'est exactement la plage que l'appelant demande au serveur : la bande ne
    // peut pas montrer une journée dont personne n'a demandé les créneaux.
    const septembre = bandDates('2026-09', BOUNDS);

    expect(septembre).toHaveLength(21);
    expect(septembre[0]).toBe('2026-09-10');
    expect(septembre.at(-1)).toBe('2026-09-30');

    const octobre = bandDates('2026-10', BOUNDS);

    expect(octobre[0]).toBe('2026-10-01');
    expect(octobre.at(-1)).toBe('2026-10-10');
  });

  it('ne rend rien d’un mois entièrement hors de la fenêtre', () => {
    expect(bandDates('2026-08', BOUNDS)).toEqual([]);
    expect(bandDates('2026-11', BOUNDS)).toEqual([]);
  });
});

describe('le début de la fenêtre visible', () => {
  const dates = bandDates('2026-09', BOUNDS);

  it('part du premier jour chargé tant que rien n’a été demandé', () => {
    expect(bandStart(dates, null, null)).toBe(0);
  });

  it('ne se décale pas pour une journée qui tient déjà dans la première fenêtre', () => {
    // `BM-CRENEAU-02` veut que la première journée libre soit retenue, pas qu'on
    // efface aujourd'hui et demain pour la mettre en tête.
    expect(bandStart(dates, null, '2026-09-13' as CalendarDate)).toBe(0);
  });

  it('se décale pour ramener une journée lointaine sous les yeux', () => {
    // Le 30 est le vingt et unième jour chargé : la fenêtre s'arrête au dernier
    // début possible, pour rester pleine.
    expect(bandStart(dates, null, '2026-09-30' as CalendarDate)).toBe(dates.length - BAND_DAYS);
  });

  it('obéit d’abord à la journée que les chevrons ont posée en tête', () => {
    expect(bandStart(dates, '2026-09-17' as CalendarDate, '2026-09-11' as CalendarDate)).toBe(7);
  });

  it('oublie une tête de bande que la plage ne contient plus', () => {
    // Un changement de mois la laisse en arrière : la bande repart alors de son
    // point de départ naturel plutôt que de chercher une journée disparue.
    expect(bandStart(bandDates('2026-10', BOUNDS), '2026-09-17' as CalendarDate, null)).toBe(0);
  });

  it('ne dépasse jamais le dernier début possible', () => {
    // Une fenêtre qui commencerait après lui rendrait moins de quatorze journées,
    // et la bande se viderait par la droite.
    expect(bandStart(dates, '2026-09-29' as CalendarDate, null)).toBe(dates.length - BAND_DAYS);
  });

  it('reste à zéro quand la plage est plus courte que la bande', () => {
    const octobre = bandDates('2026-10', BOUNDS);

    expect(octobre).toHaveLength(10);
    expect(bandStart(octobre, '2026-10-09' as CalendarDate, null)).toBe(0);
    expect(bandSlice(octobre, 0)).toHaveLength(10);
  });
});

describe('la fenêtre rendue', () => {
  it('montre au plus quatorze journées', () => {
    const { dates, start, visible } = bandWindow('2026-09', BOUNDS, null, null, null);

    expect(dates).toHaveLength(21);
    expect(start).toBe(0);
    expect(visible).toHaveLength(BAND_DAYS);
    expect(visible.at(-1)).toBe('2026-09-23');
  });

  it('n’abandonne aucune journée que le serveur a rendue', () => {
    // Le serveur rend en principe la plage demandée — en principe seulement :
    // une réponse en retard d'un changement de mois en rend une autre, et une
    // journée hors bande serait une journée dont plus rien n'atteint les
    // créneaux.
    const { dates } = bandWindow(
      '2026-09',
      BOUNDS,
      ['2026-09-02' as CalendarDate, '2026-09-12' as CalendarDate],
      null,
      null,
    );

    expect(dates[0]).toBe('2026-09-02');
    expect(dates).toHaveLength(22);
    // Sans doublon, et dans l'ordre chronologique.
    expect([...dates]).toEqual([...new Set(dates)].sort());
  });

  it('suit le focus en bougeant le moins possible', () => {
    // Un cran, pas une page : le repère visuel survit au déplacement.
    expect(bandStartShowing(21, 0, BAND_DAYS)).toBe(1);
    expect(bandStartShowing(21, 5, 3)).toBe(3);
    // La cible est déjà visible : rien ne bouge.
    expect(bandStartShowing(21, 5, 10)).toBe(5);
  });
});

describe('l’entrée dans le mois voisin', () => {
  it('arrive sur la dernière fenêtre du mois précédent, pas sur son premier jour', () => {
    // La journée contiguë à celle qu'on quitte est la **dernière** du mois
    // d'arrivée : repartir du 10 sauterait le 24–30 (#1084).
    const entree = bandEntryDate('2026-09', BOUNDS, -1);
    const septembre = bandDates('2026-09', BOUNDS);

    expect(entree).toBe('2026-09-17');
    expect(bandSlice(septembre, bandStart(septembre, entree, null)).at(-1)).toBe('2026-09-30');
  });

  it('arrive sur le premier jour réservable du mois suivant', () => {
    // La journée contiguë dans ce sens-là : le 30 septembre est suivi du 1er
    // octobre, et la bande s'ouvre sur la fenêtre qui le porte.
    expect(bandEntryDate('2026-10', BOUNDS, 1)).toBe('2026-10-01');
  });

  it('ne laisse pas `BM-CRENEAU-02` décaler la fenêtre d’un geste délibéré', () => {
    // Se décaler sur la première journée libre est la règle du **premier
    // affichage**. Appliquée à un chevron, elle ferait atterrir `›` loin de la
    // journée contiguë, et `‹` ne ramènerait plus d'où l'on vient.
    const bornes: BookingWindow = {
      first: '2026-09-20' as CalendarDate,
      last: '2026-10-20' as CalendarDate,
    };
    const octobre = bandDates('2026-10', bornes);
    const premierLibre = '2026-10-18' as CalendarDate;

    // Sans tête posée, la bande suivrait cette journée lointaine…
    expect(bandStart(octobre, null, premierLibre)).toBeGreaterThan(0);
    // …avec elle, elle s'en tient à la fenêtre contiguë, que le sélecteur sait
    // rendre même pleine (« Complet du… au… », `BM-CRENEAU-03`).
    expect(bandStart(octobre, bandEntryDate('2026-10', bornes, 1), premierLibre)).toBe(0);
  });

  it('fait des deux chevrons l’inverse l’un de l’autre', () => {
    // `›` puis `‹` ramène là où l'on était : la dernière fenêtre de septembre
    // est exactement celle depuis laquelle on est parti vers octobre.
    const septembre = bandDates('2026-09', BOUNDS);
    const depart = bandStart(septembre, '2026-09-17' as CalendarDate, null);

    expect(depart + BAND_DAYS).toBe(septembre.length);
    expect(bandStart(septembre, bandEntryDate('2026-09', BOUNDS, -1), null)).toBe(depart);
  });

  it('s’en tient au premier jour d’un mois plus court que la bande', () => {
    // Octobre n'a que dix journées réservables : sa « dernière fenêtre » est la
    // seule, et elle commence au premier jour.
    expect(bandEntryDate('2026-10', BOUNDS, -1)).toBe('2026-10-01');
  });

  it('ne nomme rien d’un mois entièrement hors de la fenêtre', () => {
    // Le composant ne l'appelle jamais dans ce cas — `isNavigableMonth` éteint
    // le chevron —, mais un mois vide ne doit pas rendre une journée inventée.
    expect(bandEntryDate('2026-08', BOUNDS, -1)).toBeNull();
    expect(bandEntryDate('2026-11', BOUNDS, 1)).toBeNull();
  });
});

describe('le clavier de la bande', () => {
  it('reprend le tableau « Barre de dates » du document de conception', () => {
    expect(bandMoveForKey('ArrowLeft')).toBe('previousDay');
    expect(bandMoveForKey('ArrowRight')).toBe('nextDay');
    expect(bandMoveForKey('Home')).toBe('bandStart');
    expect(bandMoveForKey('End')).toBe('bandEnd');
    expect(bandMoveForKey('PageUp')).toBe('previousBand');
    expect(bandMoveForKey('PageDown')).toBe('nextBand');
  });

  it('laisse au navigateur les touches qui ne la regardent pas', () => {
    // Avaler `Tab` ou un raccourci système ferait bien pire que de ne rien faire.
    expect(bandMoveForKey('Tab')).toBeNull();
    expect(bandMoveForKey('a')).toBeNull();
  });

  it('porte `Début` et `Fin` sur la fenêtre visible, pas sur le mois', () => {
    // Ce sont les bornes de ce que l'œil voit, et c'est ce qu'une rangée de jours
    // promet ; le mois entier se parcourt aux chevrons ou dans le calendrier.
    expect(moveInBand(21, 7, 10, 'bandStart')).toBe(7);
    expect(moveInBand(21, 7, 10, 'bandEnd')).toBe(7 + BAND_DAYS - 1);
  });

  it('avance d’une semaine sous `PageSuiv`', () => {
    expect(moveInBand(21, 0, 2, 'nextBand')).toBe(2 + BAND_STEP);
  });

  it('ne boucle pas aux bords de la plage chargée', () => {
    // Une flèche droite qui ramènerait de la fin du mois au premier jour ferait
    // réserver un mois plus tôt qu'on ne croit.
    expect(moveInBand(21, 0, 0, 'previousDay')).toBe(0);
    expect(moveInBand(21, 7, 20, 'nextDay')).toBe(20);
    expect(moveInBand(21, 7, 20, 'bandEnd')).toBe(20);
  });

  it('ne va nulle part sur une plage vide', () => {
    expect(moveInBand(0, 0, 0, 'nextDay')).toBe(0);
  });
});
