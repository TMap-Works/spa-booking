import type { Appointment, OpeningHoursEntry } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextIntlFixe } from '../support/langue-figee';

/**
 * Le planning du back-office en français et en anglais — #848.
 *
 * ## Ce que cette suite protège, et pourquoi c'est ici que ça se prouve
 *
 * Trois choses que rien d'autre ne garde :
 *
 * 1. **Les mots viennent du catalogue**, dans les deux langues. Le planning met
 *    son vocabulaire dans des fonctions pures — `calendar-grid.ts`,
 *    `calendar-range.ts`, `calendar-start.ts` —, et c'est justement ce qui rend
 *    la traduction vérifiable sans monter un navigateur.
 * 2. **Le premier jour de la semaine suit la région de l'établissement**, jamais
 *    la langue de qui regarde. C'est le deuxième critère d'acceptation, et il se
 *    trompe silencieusement : une semaine ancrée sur le mauvais jour charge sept
 *    journées et en affiche sept autres.
 * 3. **La langue ne déplace aucun rendez-vous.** Le fuseau reste celui du salon,
 *    et le bloc de 11 h doit tomber à la même rangée en anglais qu'en français
 *    — c'est la règle de `CLAUDE.md`, et un rendez-vous mal fuseau-horairé est
 *    un bug de sévérité haute.
 *
 * Le rendu en anglais d'un composant demande de remplacer l'amorce de langue des
 * suites (`tests/support/next-intl.ts`), qui les fixe toutes en français : la
 * doublure ci-dessous lit le **vrai** catalogue anglais, par le même
 * `loadMessages` que le serveur. Elle vient de `tests/support/langue-figee.ts`
 * (#1287), où elle est écrite une fois pour toutes les suites anglaises.
 */

vi.mock('next-intl', () => nextIntlFixe('en'));

import { CalendarMoveConfirm } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-move-confirm';
import { planDeskMove } from '@/lib/admin/appointment-desk';
import { buildCalendarBoard } from '@/lib/admin/calendar-grid';
import {
  DEFAULT_WEEK_START,
  rangeLabel,
  rangeOf,
  startOfWeek,
  weekStartOf,
  weekdayLabel,
} from '@/lib/admin/calendar-range';
import { calendarPeriodEmptyState, calendarStartState } from '@/lib/admin/calendar-start';
import { calendarFailureMessage } from '@/lib/admin/calendar-failure';

/** Le fuseau du salon de référence : UTC+3, celui d'Antananarivo. */
const TIME_ZONE = 'Indian/Antananarivo';

/** Le 26 août 2026 est un mercredi — le repère de toute cette suite. */
const WEDNESDAY = '2026-08-26';

function rendezVous(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1111111-1111-4111-8111-111111111111',
    reference: 'RDV-8F3K-01',
    status: 'confirmed',
    // 08:00 UTC = 11:00 au salon.
    startsAt: `${WEDNESDAY}T08:00:00.000Z`,
    endsAt: `${WEDNESDAY}T09:00:00.000Z`,
    client: { id: 'c1', firstName: 'Alice', lastName: 'Martin' },
    staff: { id: 's1', displayName: 'Hanta R.' },
    service: { id: 'v1', name: 'Soin visage', durationMinutes: 60 },
    price: { amountMinor: 4500, currency: 'EUR' },
    ...overrides,
  } as Appointment;
}

afterEach(() => {
  cleanup();
});

describe('le premier jour de la semaine suit la région de l’établissement', () => {
  it('ouvre la semaine le lundi en France, le dimanche aux États-Unis', () => {
    expect(weekStartOf('FR')).toBe(1);
    expect(weekStartOf('US')).toBe(0);
    expect(weekStartOf('CA')).toBe(0);
    // Madagascar n'est pas dans la table : la semaine y commence le lundi.
    expect(weekStartOf('MG')).toBe(1);
  });

  it('retombe sur le lundi quand l’établissement n’a pas publié d’adresse', () => {
    // Ni le fuseau du serveur ni la langue de qui regarde n'entrent ici : le
    // repli est figé, comme celui des régions de `lib/format.ts`.
    expect(weekStartOf(null)).toBe(DEFAULT_WEEK_START);
    expect(weekStartOf(undefined)).toBe(DEFAULT_WEEK_START);
    expect(weekStartOf('pas-un-pays')).toBe(DEFAULT_WEEK_START);
  });

  it('ancre la semaine du mercredi 26 août sur le lundi 24, ou sur le dimanche 23', () => {
    expect(startOfWeek(WEDNESDAY, 1)).toBe('2026-08-24');
    expect(startOfWeek(WEDNESDAY, 0)).toBe('2026-08-23');
    // Le dimanche appartient à la semaine qui s'ouvre, pas à celle qui s'achève.
    expect(startOfWeek('2026-08-30', 0)).toBe('2026-08-30');
    expect(startOfWeek('2026-08-30', 1)).toBe('2026-08-24');
  });

  it('borne la plage sur sept journées, quel que soit le jour d’ouverture', () => {
    expect(rangeOf('semaine', WEDNESDAY, 0)).toEqual({
      from: '2026-08-23',
      to: '2026-08-29',
    });
    expect(rangeOf('semaine', WEDNESDAY, 1)).toEqual({
      from: '2026-08-24',
      to: '2026-08-30',
    });
  });

  it('ne fait pas dépendre le jour d’ouverture de la langue', () => {
    // Un salon parisien consulté en anglais garde sa semaine du lundi : c'est
    // `countryCode` qui décide, et il ne bouge pas avec la session.
    const paris = weekStartOf('FR');

    expect(startOfWeek(WEDNESDAY, paris)).toBe('2026-08-24');
    expect(rangeLabel('semaine', WEDNESDAY, { locale: 'en', countryCode: 'FR' }, paris)).toBe(
      '24 – 30 August 2026',
    );
  });
});

describe('les libellés de période suivent la langue et la région', () => {
  it('nomme la journée en toutes lettres dans les deux langues', () => {
    expect(rangeLabel('jour', WEDNESDAY, { locale: 'fr', countryCode: 'FR' })).toBe(
      'Mercredi 26 août 2026',
    );
    expect(rangeLabel('jour', WEDNESDAY, { locale: 'en', countryCode: 'US' })).toBe(
      'Wednesday, August 26, 2026',
    );
  });

  it('nomme une colonne de la vue semaine par son jour, dans l’ordre de la langue', () => {
    // `{ weekday: 'short', day: 'numeric' }` rend « 24 Mon » en `en-US` : les
    // deux morceaux sont donc mis en forme séparément puis joints.
    expect(weekdayLabel('2026-08-24', { locale: 'fr', countryCode: 'FR' })).toMatch(/^Lun/);
    expect(weekdayLabel('2026-08-24', { locale: 'en', countryCode: 'US' })).toBe('Mon 24');
  });
});

describe('la grille rend ses mots dans la langue demandée', () => {
  // Le mercredi ouvre de 09 h à 12 h puis de 14 h à 19 h : de quoi obtenir les
  // trois fonds inactifs — hors horaires avant et après, pause entre les deux.
  const openingHours: readonly OpeningHoursEntry[] = [
    { weekday: 3, opensAt: '09:00', closesAt: '12:00' },
    { weekday: 3, opensAt: '14:00', closesAt: '19:00' },
  ];

  function tableau(locale: 'fr' | 'en') {
    return buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', WEDNESDAY),
      appointments: [rendezVous()],
      staff: [{ id: 's1', displayName: 'Hanta R.' }],
      openingHours,
      timeZone: TIME_ZONE,
      display: { locale, countryCode: locale === 'fr' ? 'FR' : 'US' },
    });
  }

  it('nomme les fonds inactifs et le compte de rendez-vous dans les deux langues', () => {
    const fr = tableau('fr');
    const en = tableau('en');

    const fondsDe = (board: ReturnType<typeof tableau>): string[] =>
      (board.columns[0]?.cells ?? [])
        .filter((cell) => cell.kind === 'closed')
        .map((cell) => (cell.kind === 'closed' ? cell.label : ''));

    expect(fondsDe(fr)).toContain('Hors horaires');
    expect(fondsDe(fr)).toContain('Pause');
    expect(fondsDe(en)).toContain('Outside opening hours');
    expect(fondsDe(en)).toContain('Break');

    expect(fr.columns[0]?.meta).toBe('1 RDV');
    expect(en.columns[0]?.meta).toBe('1 appt');
  });

  it('ne déplace aucun rendez-vous en changeant de langue', () => {
    // Le fuseau du salon décide seul de la rangée : 08:00 UTC = 11:00 au salon,
    // c'est-à-dire la sixième demi-heure après 08 h. Le vérifier est ce qui
    // garde le ticket du seul défaut qui coûterait cher ici (`CLAUDE.md`).
    const bloc = (locale: 'fr' | 'en'): unknown =>
      (tableau(locale).columns[0]?.cells ?? []).find((cell) => cell.kind === 'event');

    expect(bloc('fr')).toMatchObject({ slot: 6, span: 2, timeLabel: '11:00 – 12:00' });
    expect(bloc('en')).toMatchObject({ slot: 6, span: 2, timeLabel: '11:00 – 12:00' });
  });

  it('écrit l’heure d’un créneau libre selon la langue, sans changer l’heure', () => {
    const libre = (locale: 'fr' | 'en'): unknown =>
      (tableau(locale).columns[0]?.cells ?? []).find(
        (cell) => cell.kind === 'free' && cell.time === '14:30',
      );

    expect(libre('fr')).toMatchObject({ timeLabel: '14 h 30', time: '14:30' });
    expect(libre('en')).toMatchObject({ timeLabel: '14:30', time: '14:30' });
  });

  it('gradue la gouttière dans la langue de la session', () => {
    expect(tableau('fr').hours).toContain('09 h');
    expect(tableau('en').hours).toContain('09:00');
  });
});

describe('les états vides et les refus parlent la langue de la session', () => {
  const paths = { catalog: '/salon/admin/catalogue', staff: '/salon/admin/personnel' };

  it('diagnostique un salon neuf dans les deux langues', () => {
    expect(calendarStartState({ serviceCount: 0, staffCount: 0 }, paths, 'fr').title).toBe(
      'Ce salon n’est pas encore installé',
    );
    expect(calendarStartState({ serviceCount: 0, staffCount: 0 }, paths, 'en')).toMatchObject({
      title: 'This salon is not set up yet',
      links: [
        { key: 'catalogue', label: 'Open the service catalogue' },
        { key: 'personnel', label: 'Open the staff list' },
      ],
    });
  });

  it('garde l’énoncé neutre d’une période creuse', () => {
    expect(calendarPeriodEmptyState('en').title).toBe('No appointments in this period');
  });

  it('dit l’agenda non servi dans la langue, et laisse passer le message de l’API', () => {
    expect(calendarFailureMessage('NOT_FOUND', 'Cannot GET /api/v1/appointments', 'en')).toMatch(
      /not served by the API yet/,
    );
    // Tout autre code garde le message que l'API a rendu : c'est elle qui nomme
    // le refus, et le traduire ici reviendrait à le réécrire.
    expect(calendarFailureMessage('SLOT_NO_LONGER_AVAILABLE', 'Déjà pris', 'en')).toBe(
      'Déjà pris',
    );
  });
});

describe('la confirmation de changement de praticien, rendue en anglais', () => {
  it('pose la question et ses deux réponses dans la langue de la session', () => {
    const move = planDeskMove(
      rendezVous(),
      { day: WEDNESDAY, time: '15:00', staff: { id: 's2', displayName: 'Tiana B.' } },
      TIME_ZONE,
    );

    expect(move).not.toBeNull();

    render(
      <CalendarMoveConfirm
        display={{ locale: 'en', countryCode: 'US' }}
        move={move as NonNullable<typeof move>}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        timeZone={TIME_ZONE}
      />,
    );

    expect(screen.getByRole('alertdialog').textContent).toContain('Change practitioner?');
    expect(screen.getByRole('alertdialog').textContent).toContain('Hanta R.');
    expect(screen.getByRole('alertdialog').textContent).toContain('Tiana B.');
    expect(screen.getByRole('button', { name: 'Confirm the change' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  });

  it('écrit la date insérée dans la question en anglais, à l’heure du salon', () => {
    // La date est un **paramètre** de la question traduite : la laisser en
    // français mêlerait les deux langues dans la même phrase. L'heure, elle, ne
    // bouge pas — 15:00 est l'heure civile du salon dans les deux langues.
    const move = planDeskMove(
      rendezVous(),
      { day: WEDNESDAY, time: '15:00', staff: { id: 's2', displayName: 'Tiana B.' } },
      TIME_ZONE,
    );

    render(
      <CalendarMoveConfirm
        display={{ locale: 'en', countryCode: 'US' }}
        move={move as NonNullable<typeof move>}
        onCancel={() => undefined}
        onConfirm={() => undefined}
        timeZone={TIME_ZONE}
      />,
    );

    const question = screen.getByRole('alertdialog').textContent ?? '';

    expect(question).toContain('Wednesday');
    expect(question).toContain('August 26');
    expect(question).toContain('at 15:00');
    expect(question).not.toContain('mercredi');
  });
});
