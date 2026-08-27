import { Injectable } from '@nestjs/common';

import {
  AmbiguousLocalTimeError,
  NonExistentLocalTimeError,
  UnknownTimeZoneError,
} from './availability.errors';
import {
  UtcRange,
  ZonedResolution,
  ZonedWallTime,
  formatOffsetDateTime,
  isKnownTimeZone,
  offsetMinutesAt,
  resolveZonedWallTime,
  utcToZonedWallTime,
  zonedDateTimeToUtc,
  zonedDayLengthMinutes,
  zonedDayRange,
} from './availability.time';

/**
 * L'horloge d'un établissement — la façade métier du moteur de conversion (#41).
 *
 * `availability.time.ts` est un jeu de fonctions pures qui ignorent le domaine :
 * elles rendent des `RangeError` sur une entrée mal formée et ne savent rien du
 * contrat d'erreur de l'API. Ce service met les deux au même niveau :
 *
 * - il **valide le fuseau** une fois, en `UnknownTimeZoneError`, plutôt que de
 *   laisser une `RangeError` d'`Intl` remonter en 500 depuis trois couches plus
 *   bas ;
 * - il traduit les deux anomalies de changement d'heure en erreurs de domaine,
 *   là où l'appelant refuse qu'on tranche à sa place.
 *
 * Il ne connaît **ni Prisma ni le tenant courant** : le fuseau lui est passé en
 * argument. C'est ce qui le rend utilisable aussi bien depuis une requête HTTP
 * scopée que depuis un traitement planifié qui balaie plusieurs établissements
 * (rappels J-1), sans jamais avoir à ouvrir un contexte tenant pour lire une
 * heure.
 *
 * ### Ce que ce service n'implémente pas
 *
 * Le modèle d'horaires récurrents du personnel — `staff_schedules`, jour de
 * semaine + heure murale — relève de **#32** et n'existe pas encore en base.
 * Le critère « les horaires du personnel sont saisis en heure locale et
 * convertis à la volée » est ici satisfait par la **conversion** elle-même
 * (`instantAt`, `requireExactInstant`), que #32 consommera telle quelle : il n'y
 * aura pas de second endroit où convertir.
 */
@Injectable()
export class TenantClockService {
  /**
   * Vérifie une fois pour toutes que le fuseau existe.
   *
   * Toutes les méthodes publiques passent par là. Le garde interroge le
   * formateur **mémoïsé** du moteur (`isKnownTimeZone`) et non un
   * `Intl.DateTimeFormat` jetable : construire ce dernier coûte une dizaine de
   * fois une lecture d'heure murale, et le faire à chaque appel rendrait le
   * garde plus cher que la conversion qu'il protège — sur le chemin chaud du
   * calcul de créneaux, précisément ce que le cache existe pour éviter. Le
   * bénéfice reste le même : aucune `RangeError` d'`Intl` n'atteint le filtre
   * d'exception sous la forme d'un 500.
   */
  private assertKnownTimeZone(timeZone: string): void {
    if (!isKnownTimeZone(timeZone)) {
      throw new UnknownTimeZoneError(timeZone);
    }
  }

  /** Décalage du fuseau **à cet instant** — jamais mémorisé, toujours recalculé. */
  public offsetMinutesAt(instant: Date, timeZone: string): number {
    this.assertKnownTimeZone(timeZone);

    return offsetMinutesAt(instant, timeZone);
  }

  /** Heure murale d'un instant — le sens « UTC → ce que montre l'horloge du salon ». */
  public wallTimeOf(instant: Date, timeZone: string): ZonedWallTime {
    this.assertKnownTimeZone(timeZone);

    return utcToZonedWallTime(instant, timeZone);
  }

  /**
   * Heure murale → instant, anomalie **nommée** plutôt que tranchée en silence.
   *
   * Rend la résolution complète : `exact`, `skipped` (heure inexistante) ou
   * `ambiguous` (heure vécue deux fois). L'appelant qui n'a pas d'opinion lit
   * `.instant` ; celui qui en a une branche sur `.kind`.
   */
  public instantAt(calendarDate: string, localTime: string, timeZone: string): ZonedResolution {
    this.assertKnownTimeZone(timeZone);

    return zonedDateTimeToUtc(calendarDate, localTime, timeZone);
  }

  /**
   * Heure murale → instant, en **refusant** les deux anomalies.
   *
   * C'est la porte d'entrée de tout ce qui crée un rendez-vous à partir d'une
   * heure saisie localement. Une heure qui n'existe pas ou qui existe deux fois
   * n'est pas une heure de rendez-vous : la deviner ferait arriver quelqu'un une
   * heure trop tôt ou trop tard, sans qu'aucune trace n'explique pourquoi.
   *
   * Les calculs internes — bornes d'une fenêtre de travail, découpage d'un
   * calendrier — utilisent `instantAt`, où la politique par défaut suffit.
   */
  public requireExactInstant(calendarDate: string, localTime: string, timeZone: string): Date {
    const resolved = this.instantAt(calendarDate, localTime, timeZone);
    const localDateTime = `${calendarDate}T${localTime}`;

    if (resolved.kind === 'skipped') {
      throw new NonExistentLocalTimeError(
        localDateTime,
        timeZone,
        formatOffsetDateTime(resolved.instant, timeZone),
        resolved.gapMinutes,
      );
    }

    if (resolved.kind === 'ambiguous') {
      throw new AmbiguousLocalTimeError(
        localDateTime,
        timeZone,
        formatOffsetDateTime(resolved.instant, timeZone),
        formatOffsetDateTime(resolved.alternative, timeZone),
      );
    }

    return resolved.instant;
  }

  /**
   * Bornes UTC d'une journée civile du tenant, borne haute exclue.
   *
   * La journée dure 23 h, 24 h ou 25 h selon la date : c'est la borne haute qui
   * le sait, jamais une addition de 24 heures.
   */
  public dayRange(calendarDate: string, timeZone: string): UtcRange {
    this.assertKnownTimeZone(timeZone);

    return zonedDayRange(calendarDate, timeZone);
  }

  /** Durée réelle d'une journée civile du tenant, en minutes. */
  public dayLengthMinutes(calendarDate: string, timeZone: string): number {
    this.assertKnownTimeZone(timeZone);

    return zonedDayLengthMinutes(calendarDate, timeZone);
  }

  /**
   * Rend un instant en ISO 8601 avec offset explicite, dans le fuseau du tenant.
   *
   * Destiné à l'affichage et aux notifications, pas au corps des réponses : le
   * contrat d'API n'émet que des instants UTC suffixés `Z`.
   */
  public formatInTenantTime(instant: Date, timeZone: string): string {
    this.assertKnownTimeZone(timeZone);

    return formatOffsetDateTime(instant, timeZone);
  }

  /**
   * Heure murale brute → instant, sans passer par le couple date + `HH:MM`.
   *
   * Utile aux calculs qui construisent leurs composants au lieu de les lire —
   * le découpage d'une fenêtre de travail, par exemple.
   */
  public resolveWallTime(wall: ZonedWallTime, timeZone: string): ZonedResolution {
    this.assertKnownTimeZone(timeZone);

    return resolveZonedWallTime(wall, timeZone);
  }
}
