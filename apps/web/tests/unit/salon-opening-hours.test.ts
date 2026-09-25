import type { Locale, OpeningHoursEntry } from '@spa/shared';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import {
  formatOpeningRange,
  groupOpeningHoursByDay,
  openingStatus,
  weekSchedule,
  weekdayLabel,
  type HoursTranslator,
} from '@/components/salon/opening-hours';
import { loadMessages } from '@/i18n/messages';
import type { DisplayLocale } from '@/lib/format';

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
 *
 * ## Le traducteur est passé, comme les écrans le passent (#1142)
 *
 * Le module ne lit plus les catalogues par import direct — il en embarquait les
 * deux langues entières dans le bundle de tout Client Component qui l'atteignait.
 * Chaque appel reçoit donc le contexte d'affichage et un traducteur du namespace
 * `booking`.
 *
 * Celui d'ici est le **vrai formateur ICU** de `next-intl`, monté sur les
 * catalogues du dépôt (`loadMessages`), exactement comme l'amorce des suites le
 * fait pour les composants (`tests/support/next-intl.ts`). Une table de doublure
 * aurait vérifié la doublure : c'est bien « Ouvert — ferme à 19:00 » tel que
 * `messages/fr/booking.json` l'écrit qui est confronté à la sortie, et la
 * disparition d'une clé échoue ici comme elle échouerait en production.
 *
 * Et puisque la langue est devenue un paramètre, les cas la font varier : les
 * phrases anglaises sont désormais éprouvées au même titre que les françaises,
 * ce qu'aucun test ne faisait tant que le module portait un repli français.
 */

/** Le traducteur `booking` d'une langue, sur les catalogues du dépôt. */
function hoursTranslator(locale: Locale): HoursTranslator {
  /*
   * `createTranslator` est typé sur le catalogue complet ; le réduire aux six
   * clés de `HoursTranslator` demande de relâcher la contrainte une fois, ici.
   * Le formatage, lui, est celui de la bibliothèque — même détour, et même
   * raison, que dans `tests/support/next-intl.ts`.
   */
  const make = createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace: string;
  }) => HoursTranslator;

  return make({ locale, messages: loadMessages(locale), namespace: 'booking' });
}

const FR: DisplayLocale = { locale: 'fr' };
const EN: DisplayLocale = { locale: 'en' };
const fr = hoursTranslator('fr');
const en = hoursTranslator('en');

describe('le nom d’un jour de la semaine', () => {
  it('nomme les sept jours en numérotation ISO, lundi en tête', () => {
    // Appelé par une lambda et non passé directement à `map` : `weekdayLabel`
    // prend le contexte d'affichage en second paramètre, que `map` remplirait
    // avec l'index de l'itération.
    expect([1, 2, 3, 4, 5, 6, 7].map((weekday) => weekdayLabel(weekday, FR, fr))).toEqual([
      'Lundi',
      'Mardi',
      'Mercredi',
      'Jeudi',
      'Vendredi',
      'Samedi',
      'Dimanche',
    ]);
  });

  it('suit la langue demandée, sans table de noms nulle part', () => {
    // Les noms viennent d'`Intl` : la preuve que la langue circule bien jusqu'au
    // formateur, et qu'aucune des deux n'est écrite en dur dans le module.
    expect([1, 6].map((weekday) => weekdayLabel(weekday, EN, en))).toEqual(['Monday', 'Saturday']);
  });

  it('replie sur « Jour N » plutôt que sur un jour anonyme, hors des bornes ISO', () => {
    // `0` est *falsy*, et `noUncheckedIndexedAccess` rend la lecture du `Record`
    // optionnelle : sans repli, le nom accessible d'un champ annoncerait
    // « undefined ».
    expect(weekdayLabel(0, FR, fr)).toBe('Jour 0');
    expect(weekdayLabel(8, FR, fr)).toBe('Jour 8');
    expect(weekdayLabel(-1, FR, fr)).toBe('Jour -1');
    // Le repli est un message du catalogue, et il se traduit donc lui aussi.
    expect(weekdayLabel(0, EN, en)).toBe('Day 0');
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

  it('n’écrit aucun libellé — c’est l’appelant qui nomme le jour (#1142)', () => {
    // Le seul appelant, la carte du salon de l'espace client, ne cherche ici que
    // les plages du jour courant : lui faire porter un nom de jour l'obligeait à
    // réclamer le traducteur du namespace `booking` pour un mot qu'il jette.
    // `weekdayLabel` reste le point d'écriture unique, et il est testé plus haut.
    const days = groupOpeningHoursByDay([MONDAY_MORNING, SUNDAY]);

    expect(days.map((day) => Object.keys(day).sort())).toEqual([
      ['ranges', 'weekday'],
      ['ranges', 'weekday'],
    ]);
  });

  it('conserve l’ordre reçu, y compris pour un jour que le contrat interdit', () => {
    // Le contrat borne `weekday` à 1–7 : le jour hors bornes ne s'obtient qu'en
    // forçant le type. C'est bien le propos — un import ou un correctif de base
    // pourrait en poser un, et le groupement ne doit pas le perdre en route.
    const OUT_OF_RANGE = {
      weekday: 9,
      opensAt: '08:00',
      closesAt: '09:00',
    } as unknown as OpeningHoursEntry;

    expect(groupOpeningHoursByDay([MONDAY_MORNING, OUT_OF_RANGE]).map((day) => day.weekday)).toEqual(
      [1, 9],
    );
  });

  it('ne produit aucune ligne pour un jour absent — un jour fermé ne s’affiche pas', () => {
    expect(groupOpeningHoursByDay([])).toEqual([]);
  });
});

/**
 * La semaine de la carte « Horaires » (#1046, BM-VITRINE-03).
 *
 * Ce que ces cas verrouillent est la **frontière** entre les deux lectures du
 * même tableau : `groupOpeningHoursByDay` n'affirme que ce qui a été publié,
 * tandis que `weekSchedule` écrit sept lignes — les fermetures comprises — et
 * n'y est autorisée que parce qu'une semaine vide la fait renoncer d'un bloc.
 */
describe('la semaine entière', () => {
  const MARDI: OpeningHoursEntry = { weekday: 2, opensAt: '09:00', closesAt: '19:00' };

  it('rend les sept jours dès qu’une plage est publiée, fermetures comprises', () => {
    const week = weekSchedule([MARDI], FR, fr);

    expect(week).toHaveLength(7);
    expect(week.map((day) => day.label)).toEqual([
      'Lundi',
      'Mardi',
      'Mercredi',
      'Jeudi',
      'Vendredi',
      'Samedi',
      'Dimanche',
    ]);
    expect(week[0]?.ranges).toEqual([]);
    expect(week[1]?.ranges).toEqual([MARDI]);
  });

  it('nomme les sept jours dans la langue demandée', () => {
    expect(weekSchedule([MARDI], EN, en).map((day) => day.label)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]);
  });

  it('ne fabrique aucune semaine quand le salon n’a rien publié', () => {
    // Sans quoi la carte annoncerait un salon fermé sept jours sur sept, là où
    // l'API dit seulement que personne n'a saisi d'horaires.
    expect(weekSchedule([], FR, fr)).toEqual([]);
  });

  it('réunit les plages d’une même journée, dans l’ordre reçu', () => {
    const matin: OpeningHoursEntry = { weekday: 2, opensAt: '09:00', closesAt: '12:00' };
    const apresMidi: OpeningHoursEntry = { weekday: 2, opensAt: '14:00', closesAt: '19:00' };

    expect(weekSchedule([matin, apresMidi], FR, fr)[1]?.ranges).toEqual([matin, apresMidi]);
  });
});

/**
 * L'état d'ouverture du bandeau d'identité (#1046, BM-VITRINE-02).
 *
 * Le fuseau des cas est `Indian/Antananarivo` (UTC+3, sans heure d'été), comme
 * celui des fixtures : c'est ce qui fait échouer un calcul qui aurait oublié le
 * fuseau du salon, sans faire dépendre la suite de la date à laquelle elle
 * tourne. Le 15 septembre 2026 est un mardi.
 */
describe('l’état d’ouverture, maintenant', () => {
  const ZONE = 'Indian/Antananarivo';
  const MARDI: OpeningHoursEntry = { weekday: 2, opensAt: '09:00', closesAt: '19:00' };
  const SAMEDI: OpeningHoursEntry = { weekday: 6, opensAt: '10:00', closesAt: '24:00' };

  /** Un instant UTC tel que l'horloge du salon marque `HH:MM` ce jour-là. */
  const chez = (jour: number, heure: string): Date =>
    new Date(`2026-09-${String(13 + jour).padStart(2, '0')}T${heure}:00.000Z`);

  it('dit l’heure de fermeture quand le salon est ouvert', () => {
    // 09:00 UTC = 12:00 à Antananarivo, un mardi : le salon est ouvert.
    expect(openingStatus([MARDI], ZONE, chez(2, '09:00'), FR, fr)).toEqual({
      open: true,
      label: 'Ouvert — ferme à 19:00',
    });
  });

  it('se lit dans le fuseau du salon, et non dans celui du serveur', () => {
    // 17:00 UTC = 20:00 à Antananarivo : fermé, alors qu'un calcul en UTC — ou à
    // Paris — aurait conclu que le salon est encore ouvert.
    expect(openingStatus([MARDI], ZONE, chez(2, '17:00'), FR, fr)?.open).toBe(false);
  });

  it('annonce la prochaine ouverture du jour quand elle n’est pas encore venue', () => {
    // 04:00 UTC = 07:00 à Antananarivo, avant l'ouverture de 09:00.
    expect(openingStatus([MARDI], ZONE, chez(2, '04:00'), FR, fr)).toEqual({
      open: false,
      label: 'Fermé — ouvre à 09:00',
    });
  });

  it('dit « demain » plutôt que de nommer le jour', () => {
    // Lundi soir : la prochaine ouverture est celle de mardi.
    expect(openingStatus([MARDI], ZONE, chez(1, '17:00'), FR, fr)?.label).toBe(
      'Fermé — ouvre demain à 09:00',
    );
  });

  it('nomme le jour au-delà de demain, et repart au lundi en fin de semaine', () => {
    // Mercredi : la prochaine ouverture est le samedi de la même semaine.
    expect(openingStatus([MARDI, SAMEDI], ZONE, chez(3, '09:00'), FR, fr)?.label).toBe(
      'Fermé — ouvre samedi à 10:00',
    );
    // Dimanche : il faut faire le tour de la semaine pour retomber sur mardi.
    expect(openingStatus([MARDI], ZONE, chez(7, '09:00'), FR, fr)?.label).toBe(
      'Fermé — ouvre mardi à 09:00',
    );
  });

  it('écrit les quatre branches dans la langue demandée', () => {
    // Les quatre phrases d'état viennent du catalogue et non du module : rendues
    // en anglais, elles portent la casse de la langue sur le nom du jour — « opens
    // Saturday » et non « opens samedi ».
    expect(openingStatus([MARDI], ZONE, chez(2, '09:00'), EN, en)?.label).toBe(
      'Open — closes at 19:00',
    );
    expect(openingStatus([MARDI], ZONE, chez(2, '04:00'), EN, en)?.label).toBe(
      'Closed — opens at 09:00',
    );
    expect(openingStatus([MARDI], ZONE, chez(1, '17:00'), EN, en)?.label).toBe(
      'Closed — opens tomorrow at 09:00',
    );
    expect(openingStatus([MARDI, SAMEDI], ZONE, chez(3, '09:00'), EN, en)?.label).toBe(
      'Closed — opens Saturday at 10:00',
    );
  });

  it('fait le tour complet de la semaine pour un salon qui n’ouvre qu’un jour', () => {
    // Mardi soir, et le salon n'ouvre que le mardi : la prochaine ouverture est
    // celle de mardi prochain. S'arrêter au sixième jour rendrait « Fermé » tout
    // court — une vitrine qui ne dit plus quand revenir.
    expect(openingStatus([MARDI], ZONE, chez(2, '17:00'), FR, fr)?.label).toBe(
      'Fermé — ouvre mardi à 09:00',
    );
  });

  it('tient le salon ouvert jusqu’à minuit pour une fermeture à 24:00', () => {
    // 20:30 UTC = 23:30 à Antananarivo, un samedi : `24:00` est la borne haute
    // que le contrat admet, et non une heure illisible à écarter.
    expect(openingStatus([SAMEDI], ZONE, chez(6, '20:30'), FR, fr)).toEqual({
      open: true,
      label: 'Ouvert — ferme à 24:00',
    });
  });

  it('se tait quand il n’y a rien à dire plutôt que d’annoncer « fermé »', () => {
    // Aucun horaire publié, ou un fuseau qu'`Intl` refuse : un salon annoncé
    // fermé à tort est une cliente qui n'appelle pas.
    expect(openingStatus([], ZONE, chez(2, '09:00'), FR, fr)).toBeNull();
    expect(openingStatus([MARDI], 'Pas/UnFuseau', chez(2, '09:00'), FR, fr)).toBeNull();
  });

  it('ignore une plage illisible au lieu de faire tomber la vitrine', () => {
    const cassee = { weekday: 2, opensAt: '99:99', closesAt: '19:00' } as unknown as OpeningHoursEntry;

    expect(openingStatus([cassee], ZONE, chez(2, '09:00'), FR, fr)).toEqual({
      open: false,
      label: 'Fermé',
    });
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
