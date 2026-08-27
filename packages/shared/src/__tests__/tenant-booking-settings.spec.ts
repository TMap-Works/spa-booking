/**
 * Réglages de créneaux d'un établissement — #34.
 *
 * Ce que ces tests gardent n'est pas la forme du schéma, qui se relit, mais la
 * **correspondance entre trois endroits** qui doivent dire la même chose :
 * les constantes de `constants/limits.ts`, le schéma qui les applique, et la
 * contrainte `CHECK` de la migration `20260827180000_add_tenant_slot_settings`.
 * Une borne qui divergerait produirait un 500 sur une valeur que le contrat
 * annonce comme acceptable — le mode de défaillance que ces bornes existent
 * pour supprimer.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_MIN_BOOKING_NOTICE_MINUTES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  MAX_MIN_BOOKING_NOTICE_MINUTES,
  MAX_SLOT_INTERVAL_MINUTES,
  MIN_BOOKING_NOTICE_MINUTES_FLOOR,
  MIN_SLOT_INTERVAL_MINUTES,
} from '../constants/limits';
import { tenantBookingSettingsSchema } from '../schemas/tenant';

const MIGRATION = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'api',
  'prisma',
  'migrations',
  '20260827180000_add_tenant_slot_settings',
  'migration.sql',
);

function settings(overrides: Partial<{ slotIntervalMinutes: number; minBookingNoticeMinutes: number }> = {}): unknown {
  return {
    slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
    minBookingNoticeMinutes: DEFAULT_MIN_BOOKING_NOTICE_MINUTES,
    ...overrides,
  };
}

describe('réglages de créneaux', () => {
  it('accepte les valeurs par défaut de la colonne', () => {
    expect(tenantBookingSettingsSchema.safeParse(settings()).success).toBe(true);
  });

  it('accepte les deux bornes, et refuse ce qui les dépasse', () => {
    expect(
      tenantBookingSettingsSchema.safeParse(
        settings({
          slotIntervalMinutes: MIN_SLOT_INTERVAL_MINUTES,
          minBookingNoticeMinutes: MIN_BOOKING_NOTICE_MINUTES_FLOOR,
        }),
      ).success,
    ).toBe(true);
    expect(
      tenantBookingSettingsSchema.safeParse(
        settings({
          slotIntervalMinutes: MAX_SLOT_INTERVAL_MINUTES,
          minBookingNoticeMinutes: MAX_MIN_BOOKING_NOTICE_MINUTES,
        }),
      ).success,
    ).toBe(true);

    for (const invalid of [
      { slotIntervalMinutes: MIN_SLOT_INTERVAL_MINUTES - 1 },
      { slotIntervalMinutes: MAX_SLOT_INTERVAL_MINUTES + 1 },
      { minBookingNoticeMinutes: MIN_BOOKING_NOTICE_MINUTES_FLOOR - 1 },
      { minBookingNoticeMinutes: MAX_MIN_BOOKING_NOTICE_MINUTES + 1 },
    ]) {
      expect(tenantBookingSettingsSchema.safeParse(settings(invalid)).success).toBe(false);
    }
  });

  it('refuse un pas fractionnaire — une grille se compte en minutes entières', () => {
    expect(tenantBookingSettingsSchema.safeParse(settings({ slotIntervalMinutes: 7.5 })).success).toBe(
      false,
    );
  });

  it('refuse un champ non déclaré', () => {
    expect(
      tenantBookingSettingsSchema.safeParse({ ...(settings() as object), tenantId: 'x' }).success,
    ).toBe(false);
  });
});

describe('accord avec la contrainte de la base', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('le pas de créneau y porte les mêmes bornes', () => {
    expect(sql).toContain(
      `CHECK ("slot_interval_minutes" >= ${String(MIN_SLOT_INTERVAL_MINUTES)} AND "slot_interval_minutes" <= ${String(MAX_SLOT_INTERVAL_MINUTES)})`,
    );
  });

  it('le délai minimum de réservation y porte les mêmes bornes', () => {
    expect(sql).toContain(
      `CHECK ("min_booking_notice_minutes" >= ${String(MIN_BOOKING_NOTICE_MINUTES_FLOOR)} AND "min_booking_notice_minutes" <= ${String(MAX_MIN_BOOKING_NOTICE_MINUTES)})`,
    );
  });

  it('les valeurs par défaut de la colonne sont celles du contrat', () => {
    expect(sql).toContain(
      `"slot_interval_minutes" INTEGER NOT NULL DEFAULT ${String(DEFAULT_SLOT_INTERVAL_MINUTES)}`,
    );
    expect(sql).toContain(
      `"min_booking_notice_minutes" INTEGER NOT NULL DEFAULT ${String(DEFAULT_MIN_BOOKING_NOTICE_MINUTES)}`,
    );
  });
});
