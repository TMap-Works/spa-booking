import type { OpeningHoursEntry } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  formatOpeningRange,
  groupOpeningHoursByDay,
  openingStatus,
  weekSchedule,
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

/**
 * La semaine de la carte « Horaires » (#1046, BM-VITRINE-03).
 *
 * Ce que ces cas verrouillent est la **frontière** entre les deux lectures du
 * même tableau : `groupOpeningHoursByDay` n'affirme que ce qui a été publié —
 * c'est elle qui alimente les données structurées —, tandis que `weekSchedule`
 * écrit « Fermé » sur les jours manquants, et n'y est autorisée que parce
 * qu'une semaine vide la fait renoncer d'un bloc.
 */
describe('la semaine entière', () => {
  const MARDI: OpeningHoursEntry = { weekday: 2, opensAt: '09:00', closesAt: '19:00' };

  it('rend les sept jours dès qu’une plage est publiée, fermetures comprises', () => {
    const week = weekSchedule([MARDI]);

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

  it('ne fabrique aucune semaine quand le salon n’a rien publié', () => {
    // Sans quoi la carte annoncerait un salon fermé sept jours sur sept, là où
    // l'API dit seulement que personne n'a saisi d'horaires.
    expect(weekSchedule([])).toEqual([]);
  });

  it('réunit les plages d’une même journée, dans l’ordre reçu', () => {
    const matin: OpeningHoursEntry = { weekday: 2, opensAt: '09:00', closesAt: '12:00' };
    const apresMidi: OpeningHoursEntry = { weekday: 2, opensAt: '14:00', closesAt: '19:00' };

    expect(weekSchedule([matin, apresMidi])[1]?.ranges).toEqual([matin, apresMidi]);
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
    expect(openingStatus([MARDI], ZONE, chez(2, '09:00'))).toEqual({
      open: true,
      label: 'Ouvert — ferme à 19:00',
    });
  });

  it('se lit dans le fuseau du salon, et non dans celui du serveur', () => {
    // 17:00 UTC = 20:00 à Antananarivo : fermé, alors qu'un calcul en UTC — ou à
    // Paris — aurait conclu que le salon est encore ouvert.
    expect(openingStatus([MARDI], ZONE, chez(2, '17:00'))?.open).toBe(false);
  });

  it('annonce la prochaine ouverture du jour quand elle n’est pas encore venue', () => {
    // 04:00 UTC = 07:00 à Antananarivo, avant l'ouverture de 09:00.
    expect(openingStatus([MARDI], ZONE, chez(2, '04:00'))).toEqual({
      open: false,
      label: 'Fermé — ouvre à 09:00',
    });
  });

  it('dit « demain » plutôt que de nommer le jour', () => {
    // Lundi soir : la prochaine ouverture est celle de mardi.
    expect(openingStatus([MARDI], ZONE, chez(1, '17:00'))?.label).toBe(
      'Fermé — ouvre demain à 09:00',
    );
  });

  it('nomme le jour au-delà de demain, et repart au lundi en fin de semaine', () => {
    // Mercredi : la prochaine ouverture est le samedi de la même semaine.
    expect(openingStatus([MARDI, SAMEDI], ZONE, chez(3, '09:00'))?.label).toBe(
      'Fermé — ouvre samedi à 10:00',
    );
    // Dimanche : il faut faire le tour de la semaine pour retomber sur mardi.
    expect(openingStatus([MARDI], ZONE, chez(7, '09:00'))?.label).toBe(
      'Fermé — ouvre mardi à 09:00',
    );
  });

  it('fait le tour complet de la semaine pour un salon qui n’ouvre qu’un jour', () => {
    // Mardi soir, et le salon n'ouvre que le mardi : la prochaine ouverture est
    // celle de mardi prochain. S'arrêter au sixième jour rendrait « Fermé » tout
    // court — une vitrine qui ne dit plus quand revenir.
    expect(openingStatus([MARDI], ZONE, chez(2, '17:00'))?.label).toBe(
      'Fermé — ouvre mardi à 09:00',
    );
  });

  it('tient le salon ouvert jusqu’à minuit pour une fermeture à 24:00', () => {
    // 20:30 UTC = 23:30 à Antananarivo, un samedi : `24:00` est la borne haute
    // que le contrat admet, et non une heure illisible à écarter.
    expect(openingStatus([SAMEDI], ZONE, chez(6, '20:30'))).toEqual({
      open: true,
      label: 'Ouvert — ferme à 24:00',
    });
  });

  it('se tait quand il n’y a rien à dire plutôt que d’annoncer « fermé »', () => {
    // Aucun horaire publié, ou un fuseau qu'`Intl` refuse : un salon annoncé
    // fermé à tort est une cliente qui n'appelle pas.
    expect(openingStatus([], ZONE, chez(2, '09:00'))).toBeNull();
    expect(openingStatus([MARDI], 'Pas/UnFuseau', chez(2, '09:00'))).toBeNull();
  });

  it('ignore une plage illisible au lieu de faire tomber la vitrine', () => {
    const cassee = { weekday: 2, opensAt: '99:99', closesAt: '19:00' } as unknown as OpeningHoursEntry;

    expect(openingStatus([cassee], ZONE, chez(2, '09:00'))).toEqual({ open: false, label: 'Fermé' });
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
