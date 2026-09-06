import type { StaffScheduleEntry } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  ISO_WEEKDAYS,
  newScheduleRow,
  rowsFromEntries,
  validateScheduleRows,
  weekdayLabel,
  type ScheduleRow,
} from '@/lib/admin/staff-schedule';

/**
 * La semaine de travail telle que l'écran la lit et la juge (#53).
 *
 * Ce qui est vérifié ici est ce qui, mal fait, produit un agenda faux : un jour
 * mal nommé, une ligne de formulaire dont la clé glisse, un chevauchement laissé
 * passer jusqu'à la contrainte d'exclusion de la base.
 */

const MONDAY_MORNING: StaffScheduleEntry = { weekday: 1, startsAt: '09:00', endsAt: '12:30' };
const MONDAY_AFTERNOON: StaffScheduleEntry = { weekday: 1, startsAt: '13:30', endsAt: '18:00' };
const SUNDAY: StaffScheduleEntry = { weekday: 7, startsAt: '10:00', endsAt: '14:00' };

describe('les jours de la grille', () => {
  it('couvre la semaine entière, lundi en tête', () => {
    expect(ISO_WEEKDAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('nomme le dimanche 7, jamais 0', () => {
    // `0` est *falsy* : un `weekday ?? défaut` ferait disparaître l'horaire du
    // dimanche sans qu'aucun test de forme ne rougisse.
    expect(weekdayLabel(7)).toBe('Dimanche');
    expect(weekdayLabel(1)).toBe('Lundi');
  });

  it('ne rend jamais un jour sans nom, même sur une valeur hors bornes', () => {
    // La case 0 du tableau de libellés porte une chaîne vide : un `?? défaut`
    // seul la laisserait passer, et la grille afficherait un jour anonyme.
    expect(weekdayLabel(0 as unknown as (typeof ISO_WEEKDAYS)[number])).toBe('Jour 0');
  });
});

describe('les lignes du formulaire', () => {
  it('donne à chaque ligne une clé stable, jamais son rang', () => {
    // Une ligne retirée au milieu ferait sinon glisser l'état de saisie de
    // toutes les suivantes.
    const rows = rowsFromEntries([MONDAY_AFTERNOON, MONDAY_MORNING, SUNDAY]);

    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.map((row) => row.weekday)).toEqual([1, 1, 7]);
    expect(rows[0]?.startsAt).toBe('09:00');
  });

  it('propose une plage du matin plutôt que deux champs vides', () => {
    const row = newScheduleRow(3, 'graine');

    expect(row).toMatchObject({ weekday: 3, startsAt: '09:00', endsAt: '12:00' });
  });
});

describe('le verdict rendu avant l’appel', () => {
  function rows(...entries: readonly Omit<ScheduleRow, 'id'>[]): ScheduleRow[] {
    return entries.map((entry, index) => ({ ...entry, id: `ligne-${String(index)}` }));
  }

  it('accepte une semaine vide — c’est ainsi qu’un praticien cesse d’être proposé', () => {
    const verdict = validateScheduleRows([]);

    expect(verdict.ok).toBe(true);
  });

  it('refuse deux plages du même jour qui se recouvrent, sans désigner une seule ligne', () => {
    // La faute porte sur la paire : l'imputer à l'une des deux ferait chercher
    // l'erreur au mauvais endroit.
    const verdict = validateScheduleRows(
      rows(
        { weekday: 1, startsAt: '09:00', endsAt: '13:00' },
        { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
      ),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rowId).toBeNull();
      expect(verdict.message).toMatch(/recouvrent/i);
    }
  });

  it('laisse passer deux plages adjacentes', () => {
    const verdict = validateScheduleRows(
      rows(
        { weekday: 1, startsAt: '09:00', endsAt: '12:00' },
        { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
      ),
    );

    expect(verdict.ok).toBe(true);
  });

  it('n’oppose pas deux jours différents', () => {
    const verdict = validateScheduleRows(
      rows(
        { weekday: 1, startsAt: '09:00', endsAt: '18:00' },
        { weekday: 2, startsAt: '09:00', endsAt: '18:00' },
      ),
    );

    expect(verdict.ok).toBe(true);
  });

  it('refuse une plage dont la fin précède le début, et nomme la ligne', () => {
    const verdict = validateScheduleRows(rows({ weekday: 4, startsAt: '18:00', endsAt: '09:00' }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rowId).toBe('ligne-0');
    }
  });

  it('refuse une ligne à demi remplie en la désignant', () => {
    // Zod ne saurait la rattacher à personne : `''` échoue au motif `HH:MM` sans
    // dire qu'il s'agit d'un champ resté vide.
    const verdict = validateScheduleRows(rows({ weekday: 4, startsAt: '09:00', endsAt: '' }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rowId).toBe('ligne-0');
      expect(verdict.message).toMatch(/deux bornes/i);
    }
  });

  it('accepte minuit de fin de journée', () => {
    const verdict = validateScheduleRows(rows({ weekday: 5, startsAt: '20:00', endsAt: '24:00' }));

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.request.entries[0]?.endsAt).toBe('24:00');
    }
  });

  it('refuse plus de plages que la semaine n’en accepte', () => {
    const verdict = validateScheduleRows(
      Array.from({ length: 29 }, (_unused, index) => ({
        id: `ligne-${String(index)}`,
        weekday: 1 as const,
        startsAt: '09:00',
        endsAt: '10:00',
      })),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.rowId).toBeNull();
    }
  });
});
