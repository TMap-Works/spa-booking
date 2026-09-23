import type { Locale, MyStaffSchedule } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * « Mon planning » en français et en anglais — #1104.
 *
 * ## Ce que cette suite protège
 *
 * - **Les onglets et les en-têtes de période** viennent du catalogue, dans les
 *   deux langues — alors que la **clé** de vue reste française, parce que c'est un
 *   segment d'URL (`?vue=semaine`) et non un mot.
 * - **La journée de travail parle la langue** : « minuit », « Toute la journée »
 *   et les bornes d'une absence. Ces trois-là se composent au milieu d'un calcul
 *   d'heures, hors de React — c'est le cas que `useTranslations` ne couvre pas.
 * - **Le praticien confirme son rendez-vous dans la langue courante.** C'est le
 *   quatrième critère d'acceptation, et il porte sur un Client Component : le
 *   verbe vient de `admin-my-planning`, le statut de `lib/appointment-status.ts`,
 *   seul endroit du front où ce vocabulaire s'écrit.
 * - **La langue ne déplace aucune heure** : les bornes d'une absence restent
 *   celles du fuseau du salon, quelle que soit la langue qui les écrit.
 *
 * Le rendu d'un composant en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : la
 * doublure ci-dessous lit le **vrai** catalogue anglais, par le même
 * `loadMessages` que le serveur.
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

const markStatus = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  markDeskAppointmentStatusAction: (...args: unknown[]) => markStatus(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

import { createTranslator } from 'next-intl';

import { MyAppointmentActions } from '@/app/(admin)/[tenantSlug]/admin/components/my-planning-client';
import { loadMessages } from '@/i18n/messages';
import { rangeLabel } from '@/lib/admin/calendar-range';
import frCatalog from '@/messages/fr/admin-my-planning.json';
import {
  dayBoundsInTimeZone,
  myPlanningViewLabels,
  workingDay,
  UPCOMING_DAYS,
} from '@/lib/admin/my-planning';

/** Le traducteur du namespace de l'écran, dans la langue demandée. */
function planning(locale: Locale): (key: string, values?: Record<string, unknown>) => string {
  const make = createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace: string;
  }) => (key: string, values?: Record<string, unknown>) => string;

  return make({ locale, messages: loadMessages(locale), namespace: 'admin-my-planning' });
}

/** Le fuseau du salon de référence de cette suite. */
const TZ = 'Europe/Paris';

const SCHEDULE: MyStaffSchedule = {
  staffId: 'cccccccc-0000-4000-8000-000000000003',
  timezone: TZ,
  from: '2026-09-14',
  to: '2026-09-20',
  entries: [
    { weekday: 5, startsAt: '09:00', endsAt: '12:00' },
    { weekday: 5, startsAt: '14:00', endsAt: '24:00' },
  ],
  timeOff: [
    {
      id: 'dddddddd-0000-4000-8000-000000000004',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      startsAt: '2026-09-18T14:00:00.000Z',
      endsAt: '2026-09-18T15:00:00.000Z',
      reason: 'Formation',
    },
    {
      id: 'eeeeeeee-0000-4000-8000-000000000005',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      startsAt: '2026-09-15T10:00:00.000Z',
      endsAt: '2026-09-25T10:00:00.000Z',
      reason: null,
    },
  ],
  closedWeekdays: [7],
};

/** Le vendredi 18 septembre 2026, dans le fuseau du salon. */
function friday(display: { readonly locale: Locale; readonly countryCode?: string }) {
  const bounds = dayBoundsInTimeZone('2026-09-18', TZ);

  return workingDay(SCHEDULE, '2026-09-18', bounds.start, bounds.end, display);
}

afterEach(() => {
  cleanup();
  markStatus.mockReset();
  refresh.mockReset();
});

describe('les onglets de vue', () => {
  it('nomme les trois vues dans les deux langues', () => {
    expect(myPlanningViewLabels('fr')).toMatchObject({
      jour: 'Jour',
      semaine: 'Semaine',
      'a-venir': 'À venir',
    });
    expect(myPlanningViewLabels('en')).toMatchObject({
      jour: 'Day',
      semaine: 'Week',
      'a-venir': 'Upcoming',
    });
  });

  it('retombe sur le français quand l’appelant ne dit pas sa langue', () => {
    expect(myPlanningViewLabels().jour).toBe('Jour');
  });

  it('garde la clé de vue française, parce que c’est une adresse et non un mot', () => {
    // Traduire `?vue=semaine` en `?view=week` changerait les adresses d'un salon
    // anglophone sans rien lui apprendre — et casserait tout lien partagé.
    expect(Object.keys(myPlanningViewLabels('en'))).toEqual(['jour', 'semaine', 'a-venir']);
  });

  it('donne un nom accessible aux onglets dans les deux langues', () => {
    expect(planning('fr')('tabsLabel')).toBe('Vue du planning');
    expect(planning('en')('tabsLabel')).toBe('Schedule view');
  });
});

describe('les en-têtes de période et la navigation', () => {
  it('emprunte le libellé daté du back-office plutôt que d’en écrire un second', () => {
    // La semaine ne s'écrit plus dans ce catalogue : c'est `rangeLabel` — celui
    // du planning du salon et de l'encaissement — qui la dit, en `Intl` et dans
    // la région de l'établissement. Deux écritures d'une même période auraient
    // fini par diverger, et la seconde tenait sur trois lignes à 360 px.
    expect(rangeLabel('semaine', '2026-09-23', { locale: 'fr', countryCode: 'FR' })).toBe(
      '21 – 27 septembre 2026',
    );
    expect(rangeLabel('jour', '2026-09-23', { locale: 'en', countryCode: 'US' })).toBe(
      'Wednesday, September 23, 2026',
    );
    // Et la clé a bien disparu du catalogue : une phrase orpheline serait
    // retraduite au prochain passage sans que rien ne l'affiche.
    expect(Object.keys(frCatalog.period)).toEqual(['upcoming']);
  });

  it('dit l’horizon de la vue « À venir » avec le nombre de jours que l’API borne', () => {
    // Le nombre est un paramètre et non un mot : il vient de `UPCOMING_DAYS`, la
    // borne de `GET /me/appointments`, et non d'un « 31 » recopié dans la phrase.
    expect(planning('fr')('period.upcoming', { days: UPCOMING_DAYS })).toBe(
      'Les 31 prochains jours',
    );
    expect(planning('en')('period.upcoming', { days: UPCOMING_DAYS })).toBe('The next 31 days');
  });

  it('nomme les gestes de période pour le lecteur d’écran, dans les deux langues', () => {
    expect(planning('fr')('nav.previousWeek')).toBe('Semaine précédente');
    expect(planning('en')('nav.previousWeek')).toBe('Previous week');
    expect(planning('fr')('nav.nextDay')).toBe('Jour suivant');
    expect(planning('en')('nav.nextDay')).toBe('Next day');
  });

  it('compte la charge d’une période au pluriel de la langue', () => {
    // Le retour au jour courant n'est plus écrit ici : la barre de période est
    // celle du planning du salon (`PeriodNav`), et le mot vient de son
    // namespace — il n'y a qu'une écriture d'« Aujourd'hui » dans le
    // back-office. Ce que cet écran écrit, c'est ce que la période pèse.
    expect(planning('fr')('toolbar.load', { count: 0 })).toBe('Aucun rendez-vous');
    expect(planning('fr')('toolbar.load', { count: 1 })).toBe('1 rendez-vous');
    expect(planning('fr')('toolbar.load', { count: 3 })).toBe('3 rendez-vous');
    expect(planning('en')('toolbar.load', { count: 0 })).toBe('No appointments');
    expect(planning('en')('toolbar.load', { count: 1 })).toBe('1 appointment');
    expect(planning('en')('toolbar.load', { count: 3 })).toBe('3 appointments');
  });

  it('nomme le prochain rendez-vous dans les deux langues', () => {
    expect(planning('fr')('appointment.next')).toBe('Prochain');
    expect(planning('en')('appointment.next')).toBe('Next');
  });
});

describe('la journée de travail, écrite hors de React', () => {
  it('dit « minuit » dans la langue, pour une plage qui va jusqu’à la fin du jour', () => {
    expect(friday({ locale: 'fr', countryCode: 'FR' }).hours).toEqual([
      '09:00 – 12:00',
      '14:00 – minuit',
    ]);
    expect(friday({ locale: 'en', countryCode: 'US' }).hours).toEqual([
      '09:00 – 12:00',
      '14:00 – midnight',
    ]);
  });

  it('dit une absence qui couvre le jour entier dans la langue', () => {
    expect(friday({ locale: 'fr', countryCode: 'FR' }).absences).toContain('Toute la journée');
    expect(friday({ locale: 'en', countryCode: 'US' }).absences).toContain('All day');
  });

  it('borne une absence aux heures du salon, que la langue ne déplace pas', () => {
    // 14:00 UTC = 16:00 à Paris. La notation change avec la langue, l'instant non.
    expect(friday({ locale: 'fr', countryCode: 'FR' }).absences[0]).toBe(
      '16:00 – 17:00 · Formation',
    );
    expect(friday({ locale: 'en', countryCode: 'US' }).absences[0]).toBe(
      '4:00 PM – 5:00 PM · Formation',
    );
  });

  it('garde le français par défaut, pour les appelants pas encore branchés', () => {
    const bounds = dayBoundsInTimeZone('2026-09-18', TZ);

    expect(workingDay(SCHEDULE, '2026-09-18', bounds.start, bounds.end).absences).toContain(
      'Toute la journée',
    );
  });
});

describe('le détail d’un rendez-vous et ses états vides', () => {
  it('nomme la référence et les notes dans les deux langues', () => {
    expect(planning('fr')('appointment.reference')).toBe('Référence');
    expect(planning('en')('appointment.reference')).toBe('Reference');
    expect(planning('fr')('appointment.noNote')).toBe('Aucune');
    expect(planning('en')('appointment.noNote')).toBe('None');
  });

  it('traduit la journée sans rendez-vous, le salon fermé et l’absence de plage', () => {
    expect(planning('fr')('day.empty')).toBe('Aucun rendez-vous.');
    expect(planning('en')('day.empty')).toBe('No appointments.');
    expect(planning('fr')('day.closed')).toBe('Salon fermé');
    expect(planning('en')('day.closed')).toBe('Salon closed');
    expect(planning('en')('day.noShift')).toBe('No working hours');
  });

  it('traduit l’état vide de « À venir » et le compte anonyme de son horizon', () => {
    expect(planning('en')('empty.title')).toBe('Nothing planned for now');
    expect(planning('en')('empty.body', { days: UPCOMING_DAYS })).toContain('next 31 days');
    expect(planning('fr')('empty.body', { days: UPCOMING_DAYS })).toContain('31 prochains jours');
  });

  it('traduit la sortie d’un compte sans fiche praticien', () => {
    // Le seul état vide de l'écran qui propose une sortie — et seulement à qui a
    // l'agenda du salon.
    expect(planning('fr')('noProfile.openCalendar')).toBe('Ouvrir le planning du salon');
    expect(planning('en')('noProfile.openCalendar')).toBe('Open the salon schedule');
  });
});

describe('les gestes de la praticienne, rendus en anglais', () => {
  it('nomme la confirmation comme un acte, et le reste comme un constat', () => {
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started
        status="pending"
        tenantSlug="maison-lotus"
      />,
    );

    // « Confirm the appointment » nomme le geste que le praticien pose ;
    // « Mark completed » constate ce qui a eu lieu au salon (#917).
    expect(screen.getByRole('button', { name: 'Confirm the appointment' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirmer/u })).toBeNull();
  });

  it('compose « Marquer honoré » avec le statut du module de vocabulaire', () => {
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started
        status="confirmed"
        tenantSlug="maison-lotus"
      />,
    );

    expect(screen.getByRole('button', { name: 'Mark completed' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mark no show' })).toBeDefined();
  });

  it('confirme le rendez-vous, puis relit l’écran', async () => {
    markStatus.mockResolvedValue({ ok: true, data: {} });
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started={false}
        status="pending"
        tenantSlug="maison-lotus"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Confirm the appointment' }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(markStatus).toHaveBeenCalledWith(
      'maison-lotus',
      'aaaaaaaa-0000-4000-8000-000000000001',
      { status: 'confirmed' },
    );
  });

  it('dit en anglais que le serveur n’a pas répondu, sans rien relire', async () => {
    // Le refus **de l'API** garde le message que l'API a rendu : c'est elle qui
    // nomme le refus. Le silence du serveur, lui, n'a pas de message à reprendre —
    // c'est l'écran qui le dit, donc le catalogue.
    markStatus.mockRejectedValue(new Error('socket hang up'));
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started
        status="confirmed"
        tenantSlug="maison-lotus"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Mark completed' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The server is not answering. Try again in a moment.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
