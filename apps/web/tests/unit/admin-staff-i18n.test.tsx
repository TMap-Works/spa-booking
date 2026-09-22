import type { StaffTimeOff } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Le personnel du back-office en français et en anglais — #848.
 *
 * ## Ce que cette suite protège
 *
 * - **Les jours de la semaine de travail** se nomment dans la langue, et
 *   s'ordonnent selon la **région de l'établissement** : la grille d'un salon
 *   de Boston ouvre le dimanche, y compris saisie en français.
 * - **Les deux formes d'un nom de jour** — « Lundi » en tête de ligne,
 *   « lundi » au fil d'une phrase — ne se déduisent pas l'une de l'autre :
 *   l'anglais garde sa capitale dans les deux cas, et une mise en bas de casse
 *   aurait écrit « the monday range ».
 * - **Les refus de saisie** viennent du catalogue et non du contrat partagé,
 *   dont les messages sont des littéraux français.
 * - **Une absence s'écrit dans la langue**, sans changer de journée : les bornes
 *   restent celles du fuseau du salon.
 *
 * Le rendu d'un composant en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : la
 * doublure ci-dessous lit le **vrai** catalogue anglais.
 */

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');
  const messages = loadMessages('en');
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => 'en',
    useTranslations: (namespace?: string) => {
      const key = namespace ?? '';
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const made = translator(
        namespace === undefined
          ? { locale: 'en', messages }
          : { locale: 'en', messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  assignStaffServiceAction: vi.fn(),
  removeStaffServiceAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/personnel',
}));

import { StaffServicesPanel } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-services-panel';
import {
  validateScheduleRows,
  weekdayLabel,
  weekdayLabelInSentence,
  weekdaysForRegion,
  type ScheduleRow,
} from '@/lib/admin/staff-schedule';
import { formatTimeOff, validateTimeOffDraft } from '@/lib/admin/staff-time-off';
import { sortStaffMembers, staffInitials } from '@/lib/admin/staff-directory';

/** UTC+3 : le fuseau du salon de référence de ces suites. */
const TIME_ZONE = 'Indian/Antananarivo';

function lignes(...entries: readonly Omit<ScheduleRow, 'id'>[]): ScheduleRow[] {
  return entries.map((entry, index) => ({ ...entry, id: `ligne-${String(index)}` }));
}

afterEach(() => {
  cleanup();
});

describe('les jours de la semaine de travail', () => {
  it('se nomment dans la langue de la session', () => {
    expect(weekdayLabel(1, 'fr')).toBe('Lundi');
    expect(weekdayLabel(7, 'fr')).toBe('Dimanche');
    expect(weekdayLabel(1, 'en')).toBe('Monday');
    expect(weekdayLabel(7, 'en')).toBe('Sunday');
  });

  it('gardent leur capitale en anglais au fil d’une phrase, jamais en français', () => {
    // « la plage du lundi » contre « the Monday range » : une mise en bas de
    // casse unique se serait trompée sur l'une des deux langues.
    expect(weekdayLabelInSentence(1, 'fr')).toBe('lundi');
    expect(weekdayLabelInSentence(1, 'en')).toBe('Monday');
  });

  it('ne rendent jamais un jour sans nom, même hors bornes', () => {
    expect(weekdayLabel(0 as unknown as 1, 'fr')).toBe('Jour 0');
    expect(weekdayLabel(0 as unknown as 1, 'en')).toBe('Day 0');
  });

  it('s’ordonnent selon la région de l’établissement, pas selon la langue', () => {
    expect(weekdaysForRegion('FR')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdaysForRegion('US')).toEqual([7, 1, 2, 3, 4, 5, 6]);
    // Sans adresse publiée, la semaine ISO — celle d'avant le ticket.
    expect(weekdaysForRegion(null)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Les **numéros** ne bougent pas : dimanche reste `7`, si bien qu'une plage
    // enregistrée de ce côté-ci du comptoir se relit de l'autre.
    expect(weekdaysForRegion('US')[0]).toBe(7);
  });
});

describe('le verdict rendu sur la grille d’horaires', () => {
  it('dit le recouvrement dans la langue de la session, et non dans celle du contrat', () => {
    const recouvrement = lignes(
      { weekday: 1, startsAt: '09:00', endsAt: '13:00' },
      { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
    );

    const fr = validateScheduleRows(recouvrement, 'fr');
    const en = validateScheduleRows(recouvrement, 'en');

    expect(fr.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!fr.ok && !en.ok) {
      // La faute porte sur la paire : aucune des deux lignes n'est désignée.
      expect(fr.rowId).toBeNull();
      expect(en.rowId).toBeNull();
      expect(fr.message).toMatch(/recouvrent/i);
      expect(en.message).toBe('two ranges on the same day overlap');
    }
  });

  it('désigne la ligne restée à demi remplie, dans les deux langues', () => {
    const fr = validateScheduleRows(lignes({ weekday: 4, startsAt: '09:00', endsAt: '' }), 'fr');
    const en = validateScheduleRows(lignes({ weekday: 4, startsAt: '09:00', endsAt: '' }), 'en');

    expect(fr.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!fr.ok && !en.ok) {
      expect(fr.rowId).toBe('ligne-0');
      expect(en.rowId).toBe('ligne-0');
      expect(en.message).toBe('Fill in both ends of the range, or remove it.');
    }
  });

  it('distingue une plage inversée d’un recouvrement, dans les deux langues', () => {
    // Une fin antérieure à son début se lit comme un recouvrement pour qui
    // compare des bornes sans regarder laquelle précède l'autre : c'est au
    // schéma du contrat de trancher, et à l'écran de nommer **sa** faute.
    const inversee = lignes({ weekday: 2, startsAt: '12:00', endsAt: '10:00' });

    const fr = validateScheduleRows(inversee, 'fr');
    const en = validateScheduleRows(inversee, 'en');

    expect(fr.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!fr.ok && !en.ok) {
      // La faute porte sur **une** ligne : c'est elle qui est désignée.
      expect(fr.rowId).toBe('ligne-0');
      expect(en.rowId).toBe('ligne-0');
      expect(fr.message).toMatch(/doit suivre son début/);
      expect(en.message).toBe('A range must end after it starts.');
    }
  });

  it('laisse passer une semaine que le contrat accepte', () => {
    expect(
      validateScheduleRows(
        lignes(
          { weekday: 1, startsAt: '09:00', endsAt: '12:00' },
          { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
        ),
        'en',
      ).ok,
    ).toBe(true);
  });
});

describe('une absence s’écrit dans la langue, sans changer de journée', () => {
  /** Du 2 au 16 septembre, bornes à minuit **local** — donc un congé. */
  const conge: StaffTimeOff = {
    id: 'b1111111-1111-4111-8111-111111111111',
    staffId: 's1',
    startsAt: '2026-09-01T21:00:00.000Z',
    endsAt: '2026-09-16T21:00:00.000Z',
    reason: 'Congés',
  } as StaffTimeOff;

  it('nomme les mêmes deux journées dans les deux langues', () => {
    // La borne haute est exclue : le congé se termine à minuit du 17, et la
    // dernière journée annoncée est le 16.
    expect(formatTimeOff(conge, TIME_ZONE, { locale: 'fr', countryCode: 'FR' })).toContain(
      '2 sept. 2026',
    );
    expect(formatTimeOff(conge, TIME_ZONE, { locale: 'fr', countryCode: 'FR' })).toContain(
      '16 sept. 2026',
    );

    const anglais = formatTimeOff(conge, TIME_ZONE, { locale: 'en', countryCode: 'US' });

    expect(anglais).toContain('Sep 2, 2026');
    expect(anglais).toContain('Sep 16, 2026');
  });

  it('dit la fenêtre refusée dans la langue de la session, sous le champ fautif', () => {
    // Deux `<input type="date">` que rien ne contraint l'un par rapport à
    // l'autre : la reprise avant le départ est la faute la plus facile à faire,
    // et « l'absence saisie est invalide » ne dirait pas quoi corriger.
    const brouillon = {
      staffId: 'a1111111-1111-4111-8111-111111111111',
      fromDate: '2026-09-16',
      fromTime: '',
      toDate: '2026-09-02',
      toTime: '',
      reason: '',
    };

    const fr = validateTimeOffDraft(brouillon, TIME_ZONE, 'fr');
    const en = validateTimeOffDraft(brouillon, TIME_ZONE, 'en');

    expect(fr.ok).toBe(false);
    expect(en.ok).toBe(false);
    if (!fr.ok && !en.ok) {
      expect(fr.field).toBe('toDate');
      expect(en.field).toBe('toDate');
      expect(fr.message).toMatch(/jour de reprise/);
      expect(en.message).toMatch(/^The day back at work must come after the first day off/);
      // Le plafond du contrat est **inséré**, jamais recopié dans la phrase.
      expect(en.message).not.toContain('{max}');
    }
  });
});

describe('le classement du répertoire suit la langue', () => {
  it('range « Émilie » avant « Zoé », et les fiches suspendues en dernier', () => {
    const fiches = [
      { id: '1', displayName: 'Zoé', isActive: true },
      { id: '2', displayName: 'Émilie', isActive: true },
      { id: '3', displayName: 'Alice', isActive: false },
    ] as Parameters<typeof sortStaffMembers>[0];

    expect(
      sortStaffMembers(fiches, { locale: 'en', countryCode: 'US' }).map(
        (member) => member.displayName,
      ),
    ).toEqual(['Émilie', 'Zoé', 'Alice']);
  });

  it('met les initiales en capitale selon la langue', () => {
    expect(staffInitials('hanta rakoto', { locale: 'en', countryCode: 'US' })).toBe('HR');
    expect(staffInitials('hanta', { locale: 'fr', countryCode: 'FR' })).toBe('H');
  });
});

describe('le panneau des prestations, rendu en anglais', () => {
  it('nomme ses états et ses bascules dans la langue de la session', () => {
    render(
      <StaffServicesPanel
        services={[
          { id: 'v1', name: 'Facial', isActive: true, assigned: true },
          { id: 'v2', name: 'Massage', isActive: false, assigned: false },
        ]}
        staffId="s1"
        tenantSlug="salon-lotus"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Services performed' })).toBeDefined();
    expect(screen.getByText('Assigned')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Remove Facial' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Assign Massage' })).toBeDefined();
  });

  it('dit le catalogue vide plutôt que de rendre une liste sans ligne', () => {
    render(<StaffServicesPanel services={[]} staffId="s1" tenantSlug="salon-lotus" />);

    expect(screen.getByText('Empty catalogue')).toBeDefined();
  });
});
