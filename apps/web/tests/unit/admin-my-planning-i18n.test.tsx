import { DEFAULT_LOCALE, type Locale, type MyStaffSchedule } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nextIntlFixe } from '../support/langue-figee';

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
 * `loadMessages` que le serveur. Elle vient de
 * `tests/support/langue-figee.ts` (#1287), où elle est écrite une fois pour
 * toutes les suites anglaises.
 */

vi.mock('next-intl', () => nextIntlFixe('en'));

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
  type WorkingDay,
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
      // 14:00 UTC = 16:00 à Paris : une heure prise dans la plage de l'après-midi,
      // qui reste donc travaillée (#1408).
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      startsAt: '2026-09-18T14:00:00.000Z',
      endsAt: '2026-09-18T15:00:00.000Z',
      reason: 'Formation',
    },
    {
      id: 'eeeeeeee-0000-4000-8000-000000000005',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      // Du samedi 19 minuit (22:00 UTC la veille, Paris étant à UTC+2 en
      // septembre) jusqu'au 25 : le samedi est couvert entier.
      startsAt: '2026-09-18T22:00:00.000Z',
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

/** Le samedi 19, que l'absence couvre de minuit à minuit. */
function saturday(display: { readonly locale: Locale; readonly countryCode?: string }) {
  const bounds = dayBoundsInTimeZone('2026-09-19', TZ);

  return workingDay(SCHEDULE, '2026-09-19', bounds.start, bounds.end, display);
}

/** Les plages encore travaillées d'une journée, dans l'ordre. */
function hoursOf(day: WorkingDay): readonly string[] {
  return day.lines.filter((line) => !line.timeOff).map((line) => line.text);
}

/** Ses absences, dans l'ordre. */
function absencesOf(day: WorkingDay): readonly string[] {
  return day.lines.filter((line) => line.timeOff).map((line) => line.text);
}

afterEach(() => {
  cleanup();
  markStatus.mockReset();
  refresh.mockReset();
  // L'horloge que certains cas figent (#1210).
  vi.restoreAllMocks();
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

  it('retombe sur DEFAULT_LOCALE, et non sur le français (#1297)', () => {
    // Le repli transitoire de l'épique #843 est éteint : un appelant muet reçoit
    // la langue par défaut du produit, et non plus du français. Le cas se compare
    // au repli plutôt qu'à « Jour », pour qu'il dise la règle et non sa valeur du
    // jour.
    expect(myPlanningViewLabels().jour).toBe(myPlanningViewLabels(DEFAULT_LOCALE).jour);
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

  it('dit l’interrupteur des annulés dans les deux sens et les deux langues', () => {
    // #1410. Le libellé **dit l'état où il mène**, et c'est ce qui lui sert de
    // nom accessible : un lien ne porte pas d'`aria-pressed`, et « Afficher »
    // contre « Masquer » suffit à dire de quel côté on est. Le nombre est entre
    // parenthèses et non au pluriel : ce qui se lit, c'est le verbe.
    expect(planning('fr')('toolbar.showCancelled', { count: 4 })).toBe(
      'Afficher les annulés (4)',
    );
    expect(planning('fr')('toolbar.hideCancelled', { count: 1 })).toBe(
      'Masquer les annulés (1)',
    );
    expect(planning('en')('toolbar.showCancelled', { count: 4 })).toBe('Show canceled (4)');
    expect(planning('en')('toolbar.hideCancelled', { count: 1 })).toBe('Hide canceled (1)');
  });

  it('nomme le prochain rendez-vous dans les deux langues', () => {
    expect(planning('fr')('appointment.next')).toBe('Prochain');
    expect(planning('en')('appointment.next')).toBe('Next');
  });
});

describe('la journée de travail, écrite hors de React', () => {
  it('dit « minuit » dans la langue, pour une plage qui va jusqu’à la fin du jour', () => {
    expect(hoursOf(friday({ locale: 'fr', countryCode: 'FR' }))).toEqual([
      '09:00 – 12:00',
      '14:00 – minuit',
    ]);
    expect(hoursOf(friday({ locale: 'en', countryCode: 'US' }))).toEqual([
      '9:00\u00a0AM – 12:00\u00a0PM',
      '2:00\u00a0PM – midnight',
    ]);
  });

  /**
   * Les plages de travail suivent la convention du pays du salon — #1345.
   *
   * Le constat se lisait dans cette suite même : la journée du salon américain
   * annonçait « 09:00 – 12:00 » pour sa plage de travail et « 4:00 PM – 5:00 PM »
   * pour l'absence juste en dessous, deux natures d'heure à trois centimètres
   * l'une de l'autre. Les quatre combinaisons du troisième critère sont couvertes,
   * et seule la dernière bascule.
   */
  it('n’écrit ses plages en 12 heures que pour un salon américain lu en anglais', () => {
    expect(hoursOf(friday({ locale: 'fr', countryCode: 'FR' }))[0]).toBe('09:00 – 12:00');
    expect(hoursOf(friday({ locale: 'en', countryCode: 'FR' }))[0]).toBe('09:00 – 12:00');
    expect(hoursOf(friday({ locale: 'fr', countryCode: 'US' }))[0]).toBe('09:00 – 12:00');
    expect(hoursOf(friday({ locale: 'en', countryCode: 'US' }))[0]).toBe('9:00\u00a0AM – 12:00\u00a0PM');
  });

  it('écrit ses plages et ses absences dans la même convention', () => {
    // Ce que le ticket corrige, dit en une assertion : les deux lignes d'une même
    // journée ne peuvent plus diverger, puisque les bornes murales passent par le
    // même point d'écriture que les instants (`timeStyle: 'short'`).
    const jour = friday({ locale: 'en', countryCode: 'US' });

    expect(hoursOf(jour)[1]).toContain('2:00\u00a0PM');
    expect(absencesOf(jour)[0]).toContain('4:00 PM');
  });

  it('dit une absence qui couvre le jour entier dans la langue', () => {
    // Le samedi, que l'absence couvre de minuit à minuit. Elle n'a pas de motif,
    // et « Toute la journée » reste alors le seul mot qui apprenne quelque chose
    // — avec un motif, c'est lui qui se lit, et l'écran dit « Absente — … » (#1408).
    expect(absencesOf(saturday({ locale: 'fr', countryCode: 'FR' }))).toEqual(['Toute la journée']);
    expect(absencesOf(saturday({ locale: 'en', countryCode: 'US' }))).toEqual(['All day']);
    expect(saturday({ locale: 'fr', countryCode: 'FR' }).away).toBe(true);
  });

  it('borne une absence aux heures du salon, que la langue ne déplace pas', () => {
    // 14:00 UTC = 16:00 à Paris. La notation change avec la langue, l'instant non.
    expect(absencesOf(friday({ locale: 'fr', countryCode: 'FR' }))[0]).toBe(
      '16:00 – 17:00 · Formation',
    );
    expect(absencesOf(friday({ locale: 'en', countryCode: 'US' }))[0]).toBe(
      '4:00 PM – 5:00 PM · Formation',
    );
  });

  it('retombe sur DEFAULT_LOCALE pour les appelants pas encore branchés (#1297)', () => {
    // Le paramètre reste facultatif — tous les appelants du front ne passent pas
    // encore leur langue —, mais il ne promet plus du français à qui l'oublie.
    const bounds = dayBoundsInTimeZone('2026-09-18', TZ);

    expect(workingDay(SCHEDULE, '2026-09-18', bounds.start, bounds.end).lines).toEqual(
      friday({ locale: DEFAULT_LOCALE }).lines,
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

  it('distingue l’absence qui coupe une plage de celle qui emporte la journée', () => {
    // Deux phrases et non une : l'une s'ajoute aux horaires, l'autre les remplace
    // — c'est tout l'objet de #1408.
    expect(planning('fr')('day.absence', { span: '16:00 – 17:00 · Formation' })).toBe(
      'Absence : 16:00 – 17:00 · Formation',
    );
    expect(planning('fr')('day.away', { span: 'Formation' })).toBe('Absente — Formation');
    expect(planning('en')('day.away', { span: 'Training' })).toBe('Away — Training');
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

  it('traduit le geste offert à qui gère le personnel du salon', () => {
    // Le second message de cet état vide, et son action — #1411. Les deux
    // langues le portent, et le texte du rang gérant ne redit pas « demandez à
    // la gérance », ce qui est tout l'objet du ticket.
    expect(planning('fr')('noProfile.createRecord')).toBe('Créer ma fiche praticien');
    expect(planning('en')('noProfile.createRecord')).toBe('Create my practitioner record');
    expect(planning('fr')('noProfile.managerBody')).toContain('gérez le personnel');
    expect(planning('fr')('noProfile.managerBody')).not.toContain('Demandez à la gérance');
    expect(planning('en')('noProfile.managerBody')).toContain('manage this salon’s staff');
    expect(planning('en')('noProfile.managerBody')).not.toContain('Ask the salon management');
  });
});

/**
 * L'heure du soin et l'instant du rendu — la graine de l'horloge du composant,
 * qui vient du serveur dans le navigateur (#1210). Fixée ici pour que ces cas
 * ne dépendent pas de l'heure à laquelle la suite tourne.
 */
const DEBUT_DU_SOIN = '2026-09-18T14:00:00.000Z';
const SOIN_COMMENCE = '2026-09-18T14:05:00.000Z';
const AVANT_LE_SOIN = '2026-09-18T13:45:00.000Z';

/**
 * Fige l'horloge du navigateur : la graine ne vaut que pour le premier rendu,
 * l'horloge du composant prend la main juste après (`useAppointmentClock`).
 */
function figerLHorloge(instant: string): void {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(instant));
}

/**
 * Les gestes de la ligne, rendus comme la page serveur les rend — cliente et
 * heure comprises, que la question d'un constat définitif nomme (#1409).
 */
function gestes(props: {
  readonly status: Parameters<typeof MyAppointmentActions>[0]['status'];
  readonly renderedAt: string;
}) {
  return (
    <MyAppointmentActions
      appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
      clientName="Rina Andriamena"
      renderedAt={props.renderedAt}
      startsAt={DEBUT_DU_SOIN}
      status={props.status}
      tenantSlug="maison-lotus"
      // L'heure telle que la page l'écrit en anglais américain — c'est elle que
      // la question cite, et non une recomposition dans le navigateur.
      timeLabel="4:00 PM"
    />
  );
}

/**
 * Les noms accessibles des quatre gestes, en anglais — #1406.
 *
 * Ils portent la cliente et l'heure là où le libellé visible reste court, et le
 * **nom contient le libellé tel quel** (WCAG 2.5.3) : « Mark completed » d'un
 * seul tenant, et non « Mark Rina Andriamena's appointment completed », où une
 * commande vocale ne trouverait plus rien.
 */
const nom = {
  completed: 'Mark completed — Rina Andriamena’s 4:00 PM appointment',
  noShow: 'Mark no-show — Rina Andriamena’s 4:00 PM appointment',
  confirm: 'Confirm the appointment for Rina Andriamena at 4:00 PM',
  back: 'Go back — Rina Andriamena’s 4:00 PM appointment',
} as const;

describe('les gestes de la praticienne, rendus en anglais', () => {
  it('nomme la confirmation comme un acte, et le reste comme un constat', () => {
    render(gestes({ renderedAt: SOIN_COMMENCE, status: 'pending' }));

    // « Confirm the appointment » nomme le geste que le praticien pose ;
    // « Mark completed » constate ce qui a eu lieu au salon (#917).
    expect(screen.getByRole('button', { name: nom.confirm })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirmer/u })).toBeNull();
  });

  it('compose « Marquer honoré » avec le statut du module de vocabulaire', () => {
    render(gestes({ renderedAt: SOIN_COMMENCE, status: 'confirmed' }));

    expect(screen.getByRole('button', { name: nom.completed })).toBeDefined();
    expect(screen.getByRole('button', { name: nom.noShow })).toBeDefined();
  });

  /**
   * Le nom nomme le rendez-vous, le libellé visible reste court — #1406, en
   * anglais comme en français.
   *
   * Les deux catalogues sont tenus par la même contrainte : le nom accessible
   * **contient** le libellé visible tel quel (WCAG 2.5.3), et la traduction qui
   * intercalerait la cliente au milieu du verbe la casserait sans rien casser de
   * visible.
   */
  it('porte la cliente et l’heure dans le nom accessible, pas dans le libellé visible', () => {
    render(gestes({ renderedAt: SOIN_COMMENCE, status: 'confirmed' }));

    const constat = screen.getByRole('button', { name: nom.completed });

    expect(constat.textContent).toBe('Mark completed');
    expect(nom.completed).toContain('Mark completed');
    expect(nom.confirm).toContain('Confirm the appointment');
    expect(nom.back).toContain('Go back');
  });

  /**
   * La question d'un constat définitif parle anglais elle aussi — #1409.
   *
   * Elle compose trois sources : le verbe et la tournure viennent du catalogue de
   * l'écran, le statut de `lib/appointment-status.ts` — seul endroit du front où
   * ce vocabulaire s'écrit —, et l'heure de la page serveur, qui seule tient le
   * fuseau de l'établissement.
   */
  it('pose la question du constat en anglais, cliente et heure nommées', async () => {
    render(gestes({ renderedAt: SOIN_COMMENCE, status: 'confirmed' }));

    await userEvent.click(screen.getByRole('button', { name: nom.noShow }));

    expect(markStatus).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Mark Rina Andriamena’s 4:00 PM appointment as no-show? This choice is final.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: nom.back })).toBeDefined();
  });

  /** Le motif du refus se dit dans la langue courante, lui aussi — #1210. */
  it('dit en anglais pourquoi les deux constats sont éteints', () => {
    figerLHorloge(AVANT_LE_SOIN);
    render(gestes({ renderedAt: AVANT_LE_SOIN, status: 'confirmed' }));

    expect(screen.getByRole('button', { name: nom.completed })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen.getByText('This appointment hasn’t started: wait for its time before recording how it went.'),
    ).toBeDefined();
  });

  it('confirme le rendez-vous, puis relit l’écran', async () => {
    markStatus.mockResolvedValue({ ok: true, data: {} });
    render(gestes({ renderedAt: AVANT_LE_SOIN, status: 'pending' }));

    await userEvent.click(screen.getByRole('button', { name: nom.confirm }));

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
    render(gestes({ renderedAt: SOIN_COMMENCE, status: 'confirmed' }));

    // Deux appuis : le premier pose la question du constat, le second y répond
    // (#1409).
    await userEvent.click(screen.getByRole('button', { name: nom.completed }));
    await userEvent.click(screen.getByRole('button', { name: nom.completed }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The server is not answering. Try again in a moment.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
