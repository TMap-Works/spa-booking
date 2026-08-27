/**
 * `TenantClockService` — la façade métier du moteur de conversion (#41).
 *
 * Ce qui se vérifie ici, et que les fonctions pures ne peuvent pas montrer :
 * qu'aucune `RangeError` d'`Intl` ne s'échappe du service. Une exception qui
 * n'est pas une `DomainError` sort en **500** du filtre global, sans code ni
 * détail exploitable — et un fuseau mal saisi à la création d'un établissement
 * suffirait à produire ce 500 sur la première requête de disponibilité.
 */

import { DomainError } from '../../../common/errors';
import { UnknownTimeZoneError } from '../availability.errors';
import { TenantClockService } from '../tenant-clock.service';

const PARIS = 'Europe/Paris';
const ANTANANARIVO = 'Indian/Antananarivo';

describe('TenantClockService', () => {
  let clock: TenantClockService;

  beforeEach(() => {
    clock = new TenantClockService();
  });

  describe('fuseau inconnu', () => {
    /**
     * Toutes les portes du service, sans exception : il suffit qu'une seule
     * laisse passer la `RangeError` pour que le 500 revienne par là.
     */
    const doors: ReadonlyArray<readonly [string, (timeZone: string) => unknown]> = [
      ['offsetMinutesAt', (tz) => clock.offsetMinutesAt(new Date(), tz)],
      ['wallTimeOf', (tz) => clock.wallTimeOf(new Date(), tz)],
      ['instantAt', (tz) => clock.instantAt('2026-07-15', '09:00', tz)],
      ['requireExactInstant', (tz) => clock.requireExactInstant('2026-07-15', '09:00', tz)],
      ['dayRange', (tz) => clock.dayRange('2026-07-15', tz)],
      ['dayLengthMinutes', (tz) => clock.dayLengthMinutes('2026-07-15', tz)],
      ['formatInTenantTime', (tz) => clock.formatInTenantTime(new Date(), tz)],
      [
        'resolveWallTime',
        (tz) => clock.resolveWallTime({ year: 2026, month: 7, day: 15, hour: 9, minute: 0, second: 0 }, tz),
      ],
    ];

    it.each(doors)('%s refuse « Europe/Atlantis » en erreur de domaine', (_name, call) => {
      expect(() => call('Europe/Atlantis')).toThrow(UnknownTimeZoneError);
    });

    it('sort en 422 avec un code exploitable, jamais en 500', () => {
      try {
        clock.dayRange('2026-07-15', 'Europe/Atlantis');
        throw new Error('le fuseau inconnu aurait dû être refusé');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);

        const refusal = error as UnknownTimeZoneError;

        expect(refusal.code).toBe('UNKNOWN_TIME_ZONE');
        expect(refusal.status).toBe(422);
        expect(refusal.details).toEqual({ timeZone: 'Europe/Atlantis' });
      }
    });

    it('ne révèle rien d’un autre établissement dans ses détails', () => {
      // tenant-isolation §4 : le détail ne porte que ce que l'appelant a envoyé.
      const refusal = new UnknownTimeZoneError('Europe/Atlantis');

      expect(Object.keys(refusal.details)).toEqual(['timeZone']);
    });
  });

  describe('conversion à la volée', () => {
    it('convertit une heure murale d’ouverture en instant', () => {
      expect(clock.requireExactInstant('2026-07-15', '09:00', PARIS).toISOString()).toBe(
        '2026-07-15T07:00:00.000Z',
      );
    });

    it('rend le fuseau du tenant, pas celui de la machine qui exécute', () => {
      // Deux établissements, la même heure murale, deux instants distincts.
      const paris = clock.requireExactInstant('2026-07-15', '09:00', PARIS);
      const antananarivo = clock.requireExactInstant('2026-07-15', '09:00', ANTANANARIVO);

      expect(paris.toISOString()).toBe('2026-07-15T07:00:00.000Z');
      expect(antananarivo.toISOString()).toBe('2026-07-15T06:00:00.000Z');
    });

    it('rend une résolution qualifiée quand l’appelant veut décider lui-même', () => {
      expect(clock.instantAt('2026-03-29', '02:30', PARIS).kind).toBe('skipped');
      expect(clock.instantAt('2026-10-25', '02:30', PARIS).kind).toBe('ambiguous');
      expect(clock.instantAt('2026-07-15', '09:00', PARIS).kind).toBe('exact');
    });

    it('affiche un instant en heure de l’établissement, offset compris', () => {
      expect(clock.formatInTenantTime(new Date('2026-07-15T07:00:00Z'), PARIS)).toBe(
        '2026-07-15T09:00:00+02:00',
      );
      expect(clock.formatInTenantTime(new Date('2026-07-15T07:00:00Z'), ANTANANARIVO)).toBe(
        '2026-07-15T10:00:00+03:00',
      );
    });
  });

  describe('journée civile de l’établissement', () => {
    it('borne la journée dans le fuseau du tenant', () => {
      expect(clock.dayRange('2026-07-15', ANTANANARIVO)).toEqual({
        startsAt: new Date('2026-07-14T21:00:00Z'),
        endsAt: new Date('2026-07-15T21:00:00Z'),
      });
    });

    it('rend 23, 24 ou 25 heures selon la date', () => {
      expect(clock.dayLengthMinutes('2026-03-29', PARIS)).toBe(1380);
      expect(clock.dayLengthMinutes('2026-07-15', PARIS)).toBe(1440);
      expect(clock.dayLengthMinutes('2026-10-25', PARIS)).toBe(1500);
    });
  });
});
