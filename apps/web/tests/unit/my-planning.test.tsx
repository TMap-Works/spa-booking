import {
  errorMessage,
  type CalendarDate,
  type MyStaffAppointment,
  type MyStaffSchedule,
  type StaffTimeOff,
} from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MyAppointmentActions } from '@/app/(admin)/[tenantSlug]/admin/components/my-planning-client';
import {
  agendaDate,
  appointmentsByDay,
  bookedCount,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  mondayOfDate,
  nextAppointment,
  parseMyPlanningView,
  planningRange,
  shiftPlanningAnchor,
  showsToday,
  upcomingOnly,
  workingDay,
} from '@/lib/admin/my-planning';

/**
 * « Mon planning » (#813) — les fenêtres demandées à l'API, les horaires d'une
 * journée, les rendez-vous rangés, et les gestes offerts à la praticienne.
 */

const markStatus = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  markDeskAppointmentStatusAction: (...args: unknown[]) => markStatus(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  markStatus.mockReset();
  refresh.mockReset();
  // L'horloge que certains cas figent (#1210) : sans cela, le cas suivant
  // hériterait d'un `Date.now()` bloqué au jour du précédent.
  vi.restoreAllMocks();
});

const TZ = 'Europe/Paris';

function appointment(overrides: Partial<MyStaffAppointment> = {}): MyStaffAppointment {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    reference: 'RDV-JJH5-96',
    status: 'confirmed',
    startsAt: '2026-09-18T08:00:00.000Z',
    endsAt: '2026-09-18T09:00:00.000Z',
    utcOffsetMinutes: 120,
    service: { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Massage suédois', durationMinutes: 60 },
    client: {
      id: 'ffffffff-0000-4000-8000-000000000006',
      firstName: 'Rina',
      lastName: 'Andriamena',
      phone: '+33 6 00 00 00 02',
      internalNote: 'Allergie aux huiles essentielles d’agrumes.',
    },
    ...overrides,
  };
}

const SCHEDULE: MyStaffSchedule = {
  staffId: 'cccccccc-0000-4000-8000-000000000003',
  timezone: TZ,
  from: '2026-09-14',
  to: '2026-09-20',
  entries: [
    { weekday: 5, startsAt: '14:00', endsAt: '19:00' },
    { weekday: 5, startsAt: '09:00', endsAt: '12:00' },
  ],
  timeOff: [
    {
      id: 'dddddddd-0000-4000-8000-000000000004',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      // 14:00 UTC = 16:00 à Paris : au milieu de la plage de l'après-midi.
      startsAt: '2026-09-18T14:00:00.000Z',
      endsAt: '2026-09-18T15:00:00.000Z',
      reason: 'Formation',
    },
  ],
  closedWeekdays: [7],
};

/** Une absence posée sur la praticienne — bornes en instants, comme l'API. */
function timeOff(startsAt: string, endsAt: string, reason: string | null = null): StaffTimeOff {
  return {
    id: 'eeeeeeee-0000-4000-8000-000000000005',
    staffId: SCHEDULE.staffId,
    startsAt,
    endsAt,
    reason,
  };
}

/** Le même planning, avec les absences que le cas veut éprouver. */
function scheduleWith(...absences: readonly StaffTimeOff[]): MyStaffSchedule {
  return { ...SCHEDULE, timeOff: [...absences] };
}

/** La journée du salon, telle que l'écran la compose. */
function dayOf(schedule: MyStaffSchedule, day: CalendarDate) {
  const bounds = dayBoundsInTimeZone(day, TZ);

  // La langue est dite à l'appel — « Toute la journée » est un libellé, pas une
  // donnée, et le repli vaut l'anglais depuis #1297.
  return workingDay(schedule, day, bounds.start, bounds.end, { locale: 'fr' });
}

describe('les vues et leurs fenêtres', () => {
  it('ouvre sur la journée, et ignore une vue inconnue', () => {
    expect(parseMyPlanningView(undefined)).toBe('jour');
    expect(parseMyPlanningView('mois')).toBe('jour');
    expect(parseMyPlanningView('a-venir')).toBe('a-venir');
  });

  it('demande un jour, une semaine du lundi au dimanche, ou 31 jours à venir', () => {
    expect(planningRange('jour', '2026-09-18', '2026-09-18')).toEqual({
      from: '2026-09-18',
      to: '2026-09-18',
    });
    expect(planningRange('semaine', '2026-09-18', '2026-09-18')).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
    });
    expect(planningRange('a-venir', '2026-09-01', '2026-09-18')).toEqual({
      from: '2026-09-18',
      to: '2026-10-18',
    });
  });

  it('avance d’un jour ou d’une semaine', () => {
    expect(shiftPlanningAnchor('jour', '2026-09-18', 1)).toBe('2026-09-19');
    expect(shiftPlanningAnchor('semaine', '2026-09-18', -1)).toBe('2026-09-11');
    expect(mondayOfDate('2026-09-20')).toBe('2026-09-14');
    expect(daysOf('2026-09-14', '2026-09-16')).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });
});

describe('les rendez-vous', () => {
  it('se rangent par journée du salon, dans l’ordre de l’heure', () => {
    const late = appointment({ id: 'aaaaaaaa-0000-4000-8000-000000000009', startsAt: '2026-09-18T15:00:00.000Z', endsAt: '2026-09-18T16:00:00.000Z' });
    // 23:30 UTC le 18 est déjà le 19 à Paris.
    const night = appointment({ id: 'aaaaaaaa-0000-4000-8000-000000000010', startsAt: '2026-09-18T23:30:00.000Z', endsAt: '2026-09-19T00:30:00.000Z' });
    const byDay = appointmentsByDay([late, appointment(), night], TZ);

    expect(byDay.get('2026-09-18')?.map((item) => item.startsAt)).toEqual([
      '2026-09-18T08:00:00.000Z',
      '2026-09-18T15:00:00.000Z',
    ]);
    expect(byDay.get('2026-09-19')).toHaveLength(1);
  });

  it('« À venir » écarte les annulés et ce qui est déjà terminé', () => {
    const now = new Date('2026-09-18T10:00:00.000Z');
    const kept = upcomingOnly(
      [
        appointment(),
        appointment({ id: 'x2', startsAt: '2026-09-19T08:00:00.000Z', endsAt: '2026-09-19T09:00:00.000Z' }),
        appointment({ id: 'x3', status: 'cancelled', startsAt: '2026-09-20T08:00:00.000Z', endsAt: '2026-09-20T09:00:00.000Z' }),
      ],
      now,
    );

    expect(kept.map((item) => item.id)).toEqual(['x2']);
  });

  /*
   * Le nom **entier** depuis #1404 : « Rina A. » obligeait la praticienne à
   * ouvrir « Clients » pour savoir qui elle reçoit, alors qu'elle y lisait déjà
   * ce nom avec le même jeton.
   */
  it('nomme la cliente par son nom entier', () => {
    expect(clientLabel(appointment())).toBe('Rina Andriamena');
  });

  it('désigne le prochain encore attendu, et non le premier de la liste', () => {
    const now = new Date('2026-09-18T10:00:00.000Z');
    // Le 8 h est terminé, le 20 est annulé : c'est le 19 que la praticienne
    // doit voir marqué, même si la liste s'ouvre sur un rendez-vous plus ancien.
    const soonest = nextAppointment(
      [
        appointment(),
        appointment({
          id: 'x3',
          status: 'cancelled',
          startsAt: '2026-09-20T08:00:00.000Z',
          endsAt: '2026-09-20T09:00:00.000Z',
        }),
        appointment({
          id: 'x2',
          startsAt: '2026-09-19T08:00:00.000Z',
          endsAt: '2026-09-19T09:00:00.000Z',
        }),
      ],
      now,
    );

    expect(soonest?.id).toBe('x2');
    expect(nextAppointment([appointment()], new Date('2026-09-30T00:00:00.000Z'))).toBeNull();
  });

  it('ne compte pas les annulés dans la charge d’une période', () => {
    expect(bookedCount([])).toBe(0);
    expect(
      bookedCount([
        appointment(),
        appointment({ id: 'x2', status: 'no_show' }),
        appointment({ id: 'x3', status: 'cancelled' }),
      ]),
    ).toBe(2);
  });
});

describe('la colonne de date de l’agenda', () => {
  it('découpe la journée en jour, quantième et mois, sans l’année', () => {
    // Trois morceaux pour que le quantième se peigne plus gros que le reste, et
    // pour tenir une colonne de neuf rem : « mercredi 23 septembre 2026 » y
    // prenait trois lignes. L'année est portée par la barre de période.
    expect(agendaDate('2026-09-23', { locale: 'fr', countryCode: 'FR' })).toEqual({
      weekday: 'mer.',
      number: '23',
      month: 'sept.',
    });
    expect(agendaDate('2026-09-23', { locale: 'en', countryCode: 'US' })).toEqual({
      weekday: 'Wed',
      number: '23',
      month: 'Sep',
    });
  });

  it('lit la date civile en UTC, pour qu’aucun fuseau ne la décale d’un jour', () => {
    // Le piège de `formatCalendarDate`, repris ici : une date civile est déjà
    // celle de l'établissement. Reprojetée, le 1er septembre lu à Auckland
    // serait déjà le 2, et la colonne annoncerait un jour de plus que les
    // rendez-vous qu'elle coiffe.
    expect(agendaDate('2026-09-01', { locale: 'fr' }).number).toBe('1');
    expect(agendaDate('2026-12-31', { locale: 'fr' })).toEqual({
      weekday: 'jeu.',
      number: '31',
      month: 'déc.',
    });
  });
});

describe('le retour au jour courant', () => {
  it('ne s’offre que si la période affichée ne contient pas déjà aujourd’hui', () => {
    // Le défaut relevé en prenant l'écran en main : ouvert sur aujourd'hui — son
    // état par défaut —, le bouton « Aujourd'hui » pointait la page où l'on
    // était déjà, et le premier clic ne produisait rien.
    expect(showsToday('2026-09-18', '2026-09-18', '2026-09-18')).toBe(true);
    expect(showsToday('2026-09-14', '2026-09-20', '2026-09-18')).toBe(true);
    expect(showsToday('2026-09-14', '2026-09-20', '2026-09-21')).toBe(false);
    expect(showsToday('2026-09-19', '2026-09-19', '2026-09-18')).toBe(false);
  });
});

describe('la journée de travail', () => {
  it('dit ses plages dans l’ordre, et l’absence après la seule plage qu’elle coupe', () => {
    // Une absence partielle ne retire pas la plage : la praticienne travaille
    // l'après-midi, moins une heure. Elle se lit **après** la plage qu'elle
    // ampute, et non sous la journée entière (#1408).
    const day = dayOf(SCHEDULE, '2026-09-18');

    expect(day.closed).toBe(false);
    expect(day.away).toBe(false);
    expect(day.lines).toEqual([
      { text: '09:00 – 12:00', timeOff: false },
      { text: '14:00 – 19:00', timeOff: false },
      { text: '16:00 – 17:00 · Formation', timeOff: true },
    ]);
  });

  it('remplace les horaires par l’absence quand celle-ci couvre la journée', () => {
    // Le défaut de #1408 : le vendredi annonçait « 09:00 – 12:00 / 14:00 – 19:00 »
    // puis « Absence : Toute la journée · Formation » en dessous — on lisait
    // d'abord qu'elle travaillait. L'absence déborde de part et d'autre de la
    // journée du salon : bornée à celle-ci, elle la couvre entière, et ne dit
    // plus que son motif.
    const day = dayOf(
      scheduleWith(timeOff('2026-09-17T10:00:00.000Z', '2026-09-19T10:00:00.000Z', 'Formation')),
      '2026-09-18',
    );

    expect(day.closed).toBe(false);
    expect(day.away).toBe(true);
    expect(day.lines).toEqual([{ text: 'Formation', timeOff: true }]);
  });

  it('ne laisse que la fermeture un dimanche, sans l’absence posée dessus', () => {
    // « Salon fermé » et « Absence : Toute la journée » se disaient ensemble : la
    // seconde n'apprenait rien, le salon n'ouvrant pour personne (#1408).
    const day = dayOf(
      scheduleWith(timeOff('2026-09-19T22:00:00.000Z', '2026-09-20T22:00:00.000Z', 'Formation')),
      '2026-09-20',
    );

    expect(day.closed).toBe(true);
    expect(day.away).toBe(false);
    expect(day.lines).toEqual([]);
  });

  it('emporte une plage que deux absences bout à bout couvrent à elles deux', () => {
    // Ni l'une ni l'autre ne couvre la matinée seule — fondues, elles l'emportent.
    const day = dayOf(
      scheduleWith(
        timeOff('2026-09-18T07:00:00.000Z', '2026-09-18T08:00:00.000Z', 'Formation'),
        timeOff('2026-09-18T08:00:00.000Z', '2026-09-18T10:00:00.000Z', 'Réunion'),
      ),
      '2026-09-18',
    );

    expect(day.away).toBe(false);
    expect(day.lines).toEqual([
      { text: '09:00 – 10:00 · Formation', timeOff: true },
      { text: '10:00 – 12:00 · Réunion', timeOff: true },
      { text: '14:00 – 19:00', timeOff: false },
    ]);
  });

  /**
   * Les deux journées de changement d'heure de 2026 à Paris — le dernier dimanche
   * de mars et celui d'octobre. Elles durent 23 et 25 heures : compter l'absence
   * en minutes **écoulées** depuis minuit la décalait d'une heure entière, la
   * plage qu'elle couvre exactement n'était plus vue comme couverte, et l'écran
   * réaffichait côte à côte les horaires et l'absence (#1408).
   */
  it.each(['2026-03-29', '2026-10-25'] as const)(
    'emporte la plage que l’absence couvre, même un %s de changement d’heure',
    (sunday) => {
      // Dimanche ouvert, deux plages, et une absence de 14 h à 19 h à l'horloge
      // du salon — l'heure murale de part et d'autre du basculement de la nuit.
      const open: MyStaffSchedule = {
        ...SCHEDULE,
        entries: [
          { weekday: 7, startsAt: '09:00', endsAt: '12:00' },
          { weekday: 7, startsAt: '14:00', endsAt: '19:00' },
        ],
        closedWeekdays: [],
        timeOff: [
          timeOff(
            `${sunday}T${sunday === '2026-03-29' ? '12' : '13'}:00:00.000Z`,
            `${sunday}T${sunday === '2026-03-29' ? '17' : '18'}:00:00.000Z`,
            'Formation',
          ),
        ],
      };

      expect(dayOf(open, sunday).lines).toEqual([
        { text: '09:00 – 12:00', timeOff: false },
        { text: '14:00 – 19:00 · Formation', timeOff: true },
      ]);
    },
  );

  it('borne la journée de minuit à minuit dans le fuseau du salon', () => {
    const bounds = dayBoundsInTimeZone('2026-09-18', TZ);

    expect(bounds.start.toISOString()).toBe('2026-09-17T22:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-09-18T22:00:00.000Z');
  });
});

/**
 * L'heure du soin, et deux instants de part et d'autre — #1210.
 *
 * `renderedAt` est la graine de l'horloge du composant — celle que la page
 * serveur lui passe —, mais elle ne vaut que pour le **premier** rendu :
 * l'horloge prend ensuite la main avec `Date.now()`, et c'est bien ce qu'on veut
 * d'elle, un tiroir ou un planning restant ouverts pendant que l'heure tourne.
 * Ces cas fixent donc les deux, la graine *et* `Date.now`.
 */
const DEBUT = '2026-09-18T14:00:00.000Z';
const AVANT = '2026-09-18T13:45:00.000Z';
const APRES = '2026-09-18T14:05:00.000Z';

/** Fige l'horloge du navigateur pour la durée du cas. */
function figerLHorloge(instant: string): void {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(instant));
}

/**
 * Les gestes de la ligne, rendus comme la page serveur les rend.
 *
 * La cliente et l'heure **écrite** en font partie depuis #1409 : c'est ce que la
 * question d'un constat définitif nomme, et la page les compose — le nom par
 * `clientLabel`, l'heure par le formateur du fuseau de l'établissement.
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
      startsAt={DEBUT}
      status={props.status}
      tenantSlug="maison-lotus"
      timeLabel="16:00"
    />
  );
}

describe('les gestes de la praticienne sur son rendez-vous', () => {
  it('offre « honoré » inerte, avec son motif, tant que le rendez-vous n’a pas commencé', () => {
    figerLHorloge(AVANT);
    render(gestes({ renderedAt: AVANT, status: 'confirmed' }));

    // Inerte plutôt qu'absent : un bouton qui disparaît ne dit pas pourquoi.
    const honore = screen.getByRole('button', { name: 'Marquer honoré' });
    expect(honore).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Marquer non honoré' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/attendez l’heure du rendez-vous/i)).toBeDefined();
  });

  /**
   * Confirmer est une **décision**, pas un constat : elle se prend précisément
   * avant l'heure, et l'horloge ne la borne pas.
   */
  it('laisse confirmer un rendez-vous à venir', async () => {
    figerLHorloge(AVANT);
    markStatus.mockResolvedValue({ ok: true, data: {} });
    render(gestes({ renderedAt: AVANT, status: 'pending' }));

    const confirmer = screen.getByRole('button', { name: 'Confirmer le rendez-vous' });
    expect(confirmer).toHaveProperty('disabled', false);

    // Et il part au **premier** appui : `confirmed` n'est pas terminal, le cycle
    // de vie laisse encore annuler, déplacer et constater après lui. Questionner
    // un geste réversible apprendrait à expédier les questions (#1409).
    await userEvent.click(confirmer);

    await waitFor(() => {
      expect(markStatus).toHaveBeenCalledWith(
        'maison-lotus',
        'aaaaaaaa-0000-4000-8000-000000000001',
        { status: 'confirmed' },
      );
    });
  });

  /**
   * L'horloge suit le **serveur**, pas la pendule du poste.
   *
   * Un poste de comptoir dont l'horloge avance d'un jour ouvrirait sinon
   * « Marquer non honoré » sur le rendez-vous de demain — un geste terminal et
   * sans retour, sur la foi d'un réglage local. L'écran n'avance que de l'écart
   * écoulé depuis son montage, ajouté à l'instant que le serveur a rendu.
   */
  it('ne s’ouvre pas sur une pendule de poste en avance', () => {
    figerLHorloge('2026-09-19T14:05:00.000Z');
    render(gestes({ renderedAt: AVANT, status: 'confirmed' }));

    expect(screen.getByRole('button', { name: 'Marquer honoré' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/attendez l’heure du rendez-vous/i)).toBeDefined();
  });

  /**
   * Le premier appui ne marque rien — #1409.
   *
   * Les deux constats sont terminaux : une cliente honorée marquée absente ne se
   * rattrape pas, l'annulation elle-même étant refusée depuis un état terminal.
   * La question nomme donc la cliente et l'heure, faute de quoi trois rendez-vous
   * dépliés poseraient trois questions indiscernables.
   */
  it('ne marque rien au premier appui : il pose la question, cliente et heure nommées', async () => {
    figerLHorloge(APRES);
    render(gestes({ renderedAt: APRES, status: 'confirmed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Marquer non honoré' }));

    expect(markStatus).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Marquer le rendez-vous de Rina Andriamena à 16:00 non honoré ? Ce choix est définitif.',
      ),
    ).toBeDefined();
    // Les deux gestes ont cédé la place aux deux réponses : laisser « Marquer
    // honoré » à portée pendant qu'on répond sur l'autre est ce qui fait cliquer
    // à côté.
    expect(screen.queryByRole('button', { name: 'Marquer honoré' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revenir' })).toBeDefined();
  });

  it('revient de la question sans rien écrire, et rend les deux gestes', async () => {
    figerLHorloge(APRES);
    render(gestes({ renderedAt: APRES, status: 'confirmed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Marquer non honoré' }));
    await userEvent.click(screen.getByRole('button', { name: 'Revenir' }));

    expect(markStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Marquer honoré' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Revenir' })).toBeNull();
  });

  it('marque le rendez-vous honoré une fois la question confirmée, puis relit l’écran', async () => {
    figerLHorloge(APRES);
    markStatus.mockResolvedValue({ ok: true, data: {} });
    render(gestes({ renderedAt: APRES, status: 'confirmed' }));

    // Deux appuis, et le second porte le même libellé que le premier : la réponse
    // dit ce qu'elle fait (#1409).
    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));
    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(markStatus).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith('maison-lotus', 'aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'completed',
    });
  });

  it('dit le refus de l’API sans rien relire', async () => {
    figerLHorloge(APRES);
    markStatus.mockResolvedValue({
      ok: false,
      code: 'FORBIDDEN',
      message: 'Ce rendez-vous n’est pas le vôtre.',
    });
    render(gestes({ renderedAt: APRES, status: 'confirmed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));
    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));

    // La phrase vient du **code** et non du `message` de l'action (#1354) : ce
    // dernier vaut déjà `errorMessage(code, locale)` depuis #1234, et le garder
    // en état l'aurait figé dans la langue du refus. La phrase attendue est lue
    // dans la table du contrat partagé, jamais recopiée.
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      errorMessage('FORBIDDEN', 'fr'),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * Le cas de course : l'écran a ouvert le geste, et l'API le refuse quand même
   * — l'heure passe entre le rendu et le clic, et c'est l'horloge du serveur qui
   * tranche. Le refus dit alors d'attendre, et non de recommencer (#1210).
   */
  it('traduit le 422 « pas commencé » en « attendez l’heure du rendez-vous »', async () => {
    figerLHorloge(APRES);
    markStatus.mockResolvedValue({
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      message: 'Un rendez-vous qui n’a pas commencé ne peut pas être marqué « honoré ».',
      details: { notStarted: true, startsAt: DEBUT, now: AVANT },
    });
    render(gestes({ renderedAt: APRES, status: 'confirmed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));
    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Ce rendez-vous n’a pas commencé : attendez l’heure du rendez-vous pour dire s’il a été honoré.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
