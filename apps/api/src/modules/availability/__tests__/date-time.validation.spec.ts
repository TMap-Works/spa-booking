/**
 * Validation des dates qui traversent l'API (#41).
 *
 * Le critère d'acceptation porte sur ce qui **entre** : « les dates traversant
 * l'API sont en ISO 8601 avec offset explicite ». Il ne se démontre pas en
 * relisant une expression régulière — il se démontre en faisant passer un corps
 * de requête par le `ValidationPipe` réellement configuré dans `app.module.ts`,
 * avec `whitelist` et `forbidNonWhitelisted`, et en constatant le refus.
 *
 * Le DTO ci-dessous n'est monté que pour ce test : #41 n'ouvre aucune route.
 * C'est bien le **couple décorateur + pipe** qui est sous test, pas une route.
 */

import { ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, ValidateNested } from 'class-validator';

import {
  IsAfterLocalTime,
  IsLocalTime,
  IsOffsetDateTime,
  IsScheduleEndTime,
  ToUtcInstant,
  isOffsetDateTime,
} from '../dto/validation';

/** Un DTO représentatif de ce que #31 et #32 déclareront. */
class BookingWindowDto {
  @IsOffsetDateTime()
  @ToUtcInstant()
  public startsAt!: string;

  @IsInt()
  public durationMinutes!: number;
}

class StaffScheduleDto {
  @IsLocalTime()
  public opensAt!: string;

  @IsLocalTime()
  public closesAt!: string;
}

/** Les deux bornes d'une plage de travail, telles que #32 les déclare. */
class ScheduleRangeDto {
  @IsLocalTime()
  public startsAt!: string;

  @IsScheduleEndTime()
  @IsAfterLocalTime('startsAt')
  public endsAt!: string;
}

class NestedDto {
  @ValidateNested()
  @Type(() => BookingWindowDto)
  public window!: BookingWindowDto;
}

/** Le pipe tel qu'`app.module.ts` le monte pour toute l'application. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

async function run<T>(type: new () => T, value: unknown): Promise<T> {
  return (await pipe.transform(value, { type: 'body', metatype: type })) as T;
}

async function reasonFor(type: new () => unknown, value: unknown): Promise<string> {
  try {
    await run(type, value);

    return '';
  } catch (error) {
    return JSON.stringify((error as { getResponse: () => unknown }).getResponse());
  }
}

describe('date-heure entrante', () => {
  it('accepte un instant UTC suffixé Z', async () => {
    const parsed = await run(BookingWindowDto, {
      startsAt: '2026-03-29T01:30:00Z',
      durationMinutes: 60,
    });

    expect(parsed.startsAt).toBe('2026-03-29T01:30:00.000Z');
  });

  it('accepte un offset explicite et le normalise en UTC sur-le-champ', async () => {
    // Le même instant que ci-dessus, exprimé en heure de Paris ce jour-là.
    const parsed = await run(BookingWindowDto, {
      startsAt: '2026-03-29T03:30:00+02:00',
      durationMinutes: 60,
    });

    expect(parsed.startsAt).toBe('2026-03-29T01:30:00.000Z');
  });

  it('accepte un offset négatif et une fraction de seconde', async () => {
    const parsed = await run(BookingWindowDto, {
      startsAt: '2026-03-28T15:30:00.500-10:00',
      durationMinutes: 60,
    });

    expect(parsed.startsAt).toBe('2026-03-29T01:30:00.500Z');
  });

  it('refuse une date-heure nue — le serveur n’a pas à deviner le fuseau', async () => {
    const reason = await reasonFor(BookingWindowDto, {
      startsAt: '2026-03-29T03:30:00',
      durationMinutes: 60,
    });

    expect(reason).toContain('offset explicite');
  });

  it('refuse une date civile seule, un horodatage epoch, une chaîne libre', async () => {
    for (const startsAt of ['2026-03-29', '1774743000', 'demain matin', '']) {
      expect(await reasonFor(BookingWindowDto, { startsAt, durationMinutes: 60 })).toContain(
        'offset explicite',
      );
    }
  });

  it('refuse une date bien formée mais inexistante au calendrier', async () => {
    // `Date.parse` la ramènerait au 3 mars sans rien signaler : un rendez-vous
    // déplacé de deux jours par une faute de frappe.
    expect(isOffsetDateTime('2026-02-31T10:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-02-29T10:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2028-02-29T10:00:00Z')).toBe(true);
  });

  it('refuse une heure hors de la journée plutôt que de la reporter au lendemain', async () => {
    // `24:00` n'est pas du RFC 3339, et `new Date` le ramènerait au 30 mars : un
    // rendez-vous déplacé d'un jour sans qu'aucune erreur ne le dise.
    expect(isOffsetDateTime('2026-03-29T24:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T19:60:00Z')).toBe(false);
    expect(await reasonFor(BookingWindowDto, { startsAt: '2026-03-29T24:00:00Z', durationMinutes: 60 })).toContain(
      'offset explicite',
    );
  });

  it('refuse un offset syntaxiquement faux', async () => {
    for (const startsAt of [
      '2026-03-29T03:30:00+2:00',
      '2026-03-29T03:30:00+0200',
      '2026-03-29T03:30:00z',
      '2026-03-29 03:30:00Z',
      '2026-03-29T03:30:00+24:00',
    ]) {
      expect(await reasonFor(BookingWindowDto, { startsAt, durationMinutes: 60 })).toContain(
        'offset explicite',
      );
    }
  });

  it('valide aussi dans un objet imbriqué', async () => {
    expect(
      await reasonFor(NestedDto, { window: { startsAt: '2026-03-29T03:30:00', durationMinutes: 60 } }),
    ).toContain('offset explicite');
  });

  it('refuse toujours un champ non déclaré, tenantId compris', async () => {
    // tenant-isolation §2 : le tenant vient du jeton, jamais du corps. La règle
    // est celle du pipe global ; l'ajout d'un champ date ne l'affaiblit pas.
    const reason = await reasonFor(BookingWindowDto, {
      startsAt: '2026-03-29T01:30:00Z',
      durationMinutes: 60,
      tenantId: '11111111-1111-4111-8111-111111111111',
    });

    expect(reason).toContain('tenantId');
  });
});

describe('heure murale entrante', () => {
  it('accepte HH:MM sur les vingt-quatre heures', async () => {
    const parsed = await run(StaffScheduleDto, { opensAt: '00:00', closesAt: '23:59' });

    expect(parsed).toMatchObject({ opensAt: '00:00', closesAt: '23:59' });
  });

  it('refuse une heure non zéro-préfixée, une heure impossible, une heure datée', async () => {
    for (const opensAt of ['9:00', '24:00', '09:60', '09:00:00', '2026-07-15T09:00:00Z']) {
      expect(await reasonFor(StaffScheduleDto, { opensAt, closesAt: '18:00' })).toContain(
        'HH:MM',
      );
    }
  });
});

/**
 * L'ordre des deux bornes d'une plage (#32).
 *
 * La règle est portée en base par `staff_schedules_minutes_check`, mais une
 * violation de contrainte ressort en `INTERNAL_ERROR` : 500 sur une saisie
 * fautive. Le contrôle au DTO est ce qui la nomme en 400 — la recette de #32 a
 * trouvé le trou, ces cas le referment.
 */
describe('ordre des bornes d’une plage', () => {
  it('accepte une plage dont la fin suit le début, `24:00` compris', async () => {
    for (const [startsAt, endsAt] of [
      ['09:00', '12:00'],
      ['18:00', '24:00'],
      ['00:00', '00:01'],
    ]) {
      await expect(run(ScheduleRangeDto, { startsAt, endsAt })).resolves.toMatchObject({
        startsAt,
        endsAt,
      });
    }
  });

  it('refuse une fin antérieure ou égale au début', async () => {
    for (const [startsAt, endsAt] of [
      ['12:00', '09:00'],
      ['09:00', '09:00'],
      ['24:00', '24:00'],
    ]) {
      expect(await reasonFor(ScheduleRangeDto, { startsAt, endsAt })).toContain('endsAt');
    }
  });

  it('ne redouble pas le refus de format quand une borne est illisible', async () => {
    // `startsAt` est déjà refusé pour sa forme : ajouter « fin > début » ferait
    // rendre deux messages pour une seule faute.
    const reason = await reasonFor(ScheduleRangeDto, { startsAt: '25:00', endsAt: '09:00' });

    expect(reason).toContain('HH:MM');
    expect(reason).not.toContain('strictement postérieure');
  });
});
