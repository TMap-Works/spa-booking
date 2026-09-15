import type { OpeningHoursEntry } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  formatOpeningRange,
  groupOpeningHoursByDay,
  weekdayLabel,
} from '@/components/salon/opening-hours';

/**
 * La présentation des horaires d'ouverture, et surtout son repli (#652).
 *
 * `weekdayLabel` est désormais le point d'écriture unique du nom de jour dans
 * `apps/web` : la vitrine publique et la grille des réglages en tirent la même
 * chaîne. Ce qui se vérifie ici n'est donc pas seulement un formatage, c'est ce
 * qu'un lecteur d'écran annoncera sur les 28 champs d'horaires de l'admin.
 *
 * La branche de repli n'a aucun écran pour l'exercer — la numérotation ISO ne
 * sort pas de 1–7 —, ce qui est exactement la raison pour laquelle elle a besoin
 * d'un test : sans lui, rien ne signalerait qu'une des deux copies d'hier avait
 * changé de formulation.
 */

describe('le nom d’un jour de la semaine', () => {
  it('nomme les sept jours en numérotation ISO, lundi en tête', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(weekdayLabel)).toEqual([
      'Lundi',
      'Mardi',
      'Mercredi',
      'Jeudi',
      'Vendredi',
      'Samedi',
      'Dimanche',
    ]);
  });

  it('replie sur « Jour N » plutôt que sur un jour anonyme, hors des bornes ISO', () => {
    // `0` est *falsy*, et `noUncheckedIndexedAccess` rend la lecture du `Record`
    // optionnelle : sans repli, le nom accessible d'un champ annoncerait
    // « undefined ».
    expect(weekdayLabel(0)).toBe('Jour 0');
    expect(weekdayLabel(8)).toBe('Jour 8');
    expect(weekdayLabel(-1)).toBe('Jour -1');
  });
});

describe('le regroupement des plages par journée', () => {
  const MONDAY_MORNING: OpeningHoursEntry = { weekday: 1, opensAt: '09:00', closesAt: '12:00' };
  const MONDAY_AFTERNOON: OpeningHoursEntry = { weekday: 1, opensAt: '14:00', closesAt: '19:00' };
  const SUNDAY: OpeningHoursEntry = { weekday: 7, opensAt: '10:00', closesAt: '14:00' };

  it('réunit une journée à coupure méridienne sur une seule ligne', () => {
    const days = groupOpeningHoursByDay([MONDAY_MORNING, MONDAY_AFTERNOON, SUNDAY]);

    expect(days.map((day) => day.weekday)).toEqual([1, 7]);
    expect(days[0]?.ranges).toEqual([MONDAY_MORNING, MONDAY_AFTERNOON]);
    expect(days[1]?.ranges).toEqual([SUNDAY]);
  });

  it('étiquette chaque journée avec le même repli que le reste de l’application', () => {
    // Le contrat borne `weekday` à 1–7 : le jour hors bornes ne s'obtient qu'en
    // forçant le type. C'est bien le propos — le repli existe pour une donnée
    // que le contrat interdit et qu'un import ou un correctif de base pourrait
    // néanmoins poser.
    const OUT_OF_RANGE = {
      weekday: 9,
      opensAt: '08:00',
      closesAt: '09:00',
    } as unknown as OpeningHoursEntry;

    const days = groupOpeningHoursByDay([MONDAY_MORNING, OUT_OF_RANGE]);

    // Des chaînes littérales, et non `weekdayLabel(9)` : confronter la sortie à
    // la fonction même qu'on vérifie ferait passer l'assertion quoi qu'il
    // advienne du repli, ce qui est précisément ce qu'elle doit surveiller.
    expect(days.map((day) => day.label)).toEqual(['Lundi', 'Jour 9']);
  });

  it('ne produit aucune ligne pour un jour absent — un jour fermé ne s’affiche pas', () => {
    expect(groupOpeningHoursByDay([])).toEqual([]);
  });
});

describe('le libellé d’une plage', () => {
  it('sépare les heures par un tiret demi-cadratin entre espaces insécables', () => {
    // L'espace insécable évite qu'un retour à la ligne tombe entre l'heure et le
    // tiret, ce qui ferait lire la plage comme deux heures sans rapport.
    expect(formatOpeningRange({ weekday: 1, opensAt: '09:00', closesAt: '12:00' })).toBe(
      '09:00\u00a0\u2013\u00a012:00',
    );
  });
});
