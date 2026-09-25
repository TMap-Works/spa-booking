import type { Appointment, AppointmentStatus, Service } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  deskMoment,
  deskSlotOptions,
  deskStatusActions,
  isCancellable,
  isReschedulable,
  isSlotConflict,
  minutesOfClock,
  nearestDeskSlot,
  offsetDateTimeInTenant,
  offsetInTenant,
  planDeskMove,
  summarize,
  tenantFields,
} from '@/lib/admin/appointment-desk';
import { planningWords } from '@/lib/admin/calendar-messages';

/**
 * La logique du comptoir (#50), sans DOM ni réseau.
 *
 * Le cas qui compte est le **fuseau** : c'est le seul endroit du ticket où une
 * erreur ne se voit pas à l'écran et coûte un rendez-vous posé une heure à côté.
 * Les cas d'un fuseau sans changement d'heure (Antananarivo) et d'un fuseau qui
 * en a un (Paris) sont donc exercés tous les deux, de part et d'autre de la
 * bascule.
 *
 * ## Ce fichier n'importe plus une seule phrase du module (#1187)
 *
 * Il en importait douze, et c'est ce qui les maintenait en vie : le module en
 * gardait une copie française que plus aucun écran ne rendait depuis #848, et
 * ces assertions lui servaient d'oracle. Corriger une faute de frappe dans
 * `messages/{fr,en}/admin-planning.json` aurait laissé la copie morte intacte,
 * et cette suite verte. Ce qui reste ici est ce que le module **calcule** ; ce
 * que le produit **dit** se lit dans le catalogue, par `planningWords`, comme
 * tous les autres modules de planning le font.
 */

const ANTANANARIVO = 'Indian/Antananarivo';
const PARIS = 'Europe/Paris';

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    assignedStaffCount: 1,
    activeAssignedStaffCount: 1,
    ...overrides,
  };
}

describe('le fuseau du salon, et lui seul', () => {
  it('mesure le décalage d’un fuseau sans changement d’heure', () => {
    expect(offsetInTenant(new Date('2026-08-26T11:30:00.000Z'), ANTANANARIVO)).toBe(180);
    expect(offsetInTenant(new Date('2026-01-15T11:30:00.000Z'), ANTANANARIVO)).toBe(180);
  });

  it('suit le changement d’heure là où il existe', () => {
    // Paris : +02:00 en août, +01:00 en janvier. Une table figée aurait faux la
    // moitié de l'année.
    expect(offsetInTenant(new Date('2026-08-26T11:30:00.000Z'), PARIS)).toBe(120);
    expect(offsetInTenant(new Date('2026-01-15T11:30:00.000Z'), PARIS)).toBe(60);
  });

  it('écrit une saisie civile avec l’offset de l’établissement', () => {
    expect(offsetDateTimeInTenant('2026-08-26', '14:30', ANTANANARIVO)).toBe(
      '2026-08-26T14:30:00+03:00',
    );
    expect(offsetDateTimeInTenant('2026-08-26', '14:30', PARIS)).toBe('2026-08-26T14:30:00+02:00');
    expect(offsetDateTimeInTenant('2026-01-15', '14:30', PARIS)).toBe('2026-01-15T14:30:00+01:00');
  });

  it('produit un instant que l’on relit à la même heure civile', () => {
    // La seule propriété qui compte vraiment : ce que l'opérateur a tapé est ce
    // que le planning réaffichera. Le trajet passe par UTC, et il doit revenir.
    for (const timeZone of [ANTANANARIVO, PARIS] as const) {
      const written = offsetDateTimeInTenant('2026-08-26', '14:30', timeZone);
      const back = tenantFields(new Date(written).toISOString(), timeZone);

      expect(back).toEqual({ date: '2026-08-26', time: '14:30' });
    }
  });

  it('ramène un instant UTC aux champs des contrôles date et heure', () => {
    // 11 h 30 UTC = 14 h 30 au salon d'Antananarivo.
    expect(tenantFields('2026-08-26T11:30:00.000Z', ANTANANARIVO)).toEqual({
      date: '2026-08-26',
      time: '14:30',
    });
    // Et le passage de minuit se fait dans le calendrier du salon, pas dans UTC.
    expect(tenantFields('2026-08-25T22:00:00.000Z', ANTANANARIVO)).toEqual({
      date: '2026-08-26',
      time: '01:00',
    });
  });
});

describe('le récapitulatif calculé', () => {
  it('dérive la fin et l’heure de libération de la prestation', () => {
    expect(summarize(service(), '14:30')).toEqual({
      startTime: '14:30',
      endTime: '15:30',
      bufferMinutes: 15,
      freeAtTime: '15:45',
      durationMinutes: 60,
    });
  });

  it('n’invente rien d’une heure illisible', () => {
    expect(summarize(service(), '')).toBeNull();
    expect(summarize(service(), '25:00')).toBeNull();
    expect(minutesOfClock('14:30')).toBe(870);
    expect(minutesOfClock('14h30')).toBeNull();
  });

  it('replie sur la journée un soin qui déborde de minuit', () => {
    const late = summarize(service({ durationMinutes: 120, bufferAfterMinutes: 0 }), '23:30');

    expect(late?.endTime).toBe('01:30');
  });
});

describe('ce que le pied du tiroir propose', () => {
  it('n’offre le solde que depuis un rendez-vous confirmé', () => {
    expect(deskStatusActions('confirmed').map((action) => action.status)).toEqual([
      'completed',
      'no_show',
    ]);
    // `pending → completed` n'est pas dans la table du contrat : un bouton qui y
    // mènerait ne rendrait qu'un 422. La seule marche offerte depuis `pending`
    // est donc la confirmation (#973).
    expect(deskStatusActions('pending').map((action) => action.status)).toEqual(['confirmed']);
    expect(deskStatusActions('completed')).toEqual([]);
    expect(deskStatusActions('no_show')).toEqual([]);
    expect(deskStatusActions('cancelled')).toEqual([]);
  });

  it('offre la confirmation sur un rendez-vous en attente — #973', () => {
    // Le constat de l'audit `d20260917-2` : un rendez-vous « À confirmer »
    // n'avait, dans tout le back-office, aucun bouton pour le confirmer, et ne
    // pouvait donc jamais atteindre `completed` ni `no_show`.
    // Sans `label` : le libellé se compose dans l'écran qui le rend, depuis le
    // catalogue et dans la langue de la session (#1187). Ce que la table porte
    // est la transition offerte et l'allure de son bouton.
    expect(deskStatusActions('pending')).toEqual([{ status: 'confirmed', variant: 'neutral' }]);
  });

  it('ne double jamais l’annulation, qui a sa propre route', () => {
    // `cancelled` est dans `APPOINTMENT_STATUS_TRANSITIONS` depuis `pending` et
    // depuis `confirmed`, mais il n'a pas d'entrée dans la table des libellés :
    // l'annulation passe par `POST /appointments/:id/cancel` et sa confirmation
    // en deux temps (#754), jamais par la route de statut.
    for (const status of ['pending', 'confirmed'] as const) {
      expect(deskStatusActions(status).map((action) => action.status)).not.toContain('cancelled');
    }
  });

  it('ne laisse déplacer que ce qui n’est pas soldé', () => {
    expect(isReschedulable('pending')).toBe(true);
    expect(isReschedulable('confirmed')).toBe(true);
    expect(isReschedulable('completed')).toBe(false);
    expect(isReschedulable('cancelled')).toBe(false);
  });

  it('n’offre l’annulation que sur un état que le cycle de vie laisse annuler (#754)', () => {
    expect(isCancellable('pending')).toBe(true);
    expect(isCancellable('confirmed')).toBe(true);
    // Terminaux : l'API les refuserait en `INVALID_STATE_TRANSITION`, et un
    // bouton qui mène à un 422 est un bouton qui ment.
    expect(isCancellable('completed')).toBe(false);
    expect(isCancellable('no_show')).toBe(false);
    expect(isCancellable('cancelled')).toBe(false);
  });
});

describe('les refus, et ce que le module en dit encore', () => {
  /**
   * Le module ne rend plus aucune phrase de refus — il rend un **verdict**, et
   * les deux écrans qui l'appellent en tirent la leur dans le catalogue
   * (#1187). Ce qui se vérifie ici est donc ce verdict, et lui seul ; les
   * phrases elles-mêmes sont exercées à l'écran par
   * `admin-appointment-panel.test.tsx`, qui rend le tiroir et le planning.
   */
  it('reconnaît le créneau perdu sous concurrence, et rien d’autre', () => {
    expect(isSlotConflict('SLOT_NO_LONGER_AVAILABLE')).toBe(true);
    // Le 409 d'une annulation, ce sont deux postes qui annulent à la fois : le
    // tiroir le lit comme passager lui aussi (#754).
    expect(isSlotConflict('CONFLICT')).toBe(true);
    // Un 404 ne l'est pas : le rendez-vous a disparu, et réessayer ne le rendra
    // pas. Ni un refus que l'API a su formuler.
    expect(isSlotConflict('NOT_FOUND')).toBe(false);
    expect(isSlotConflict('HTTP_404')).toBe(false);
    expect(isSlotConflict('SLOT_OUTSIDE_WORKING_HOURS')).toBe(false);
    expect(isSlotConflict('INVALID_STATE_TRANSITION')).toBe(false);
  });
});

/**
 * Le report par glisser-déposer (#51), côté calcul.
 *
 * Ce qui se joue ici et nulle part ailleurs : le lâcher est une **journée civile
 * et une heure civile du salon**, l'API attend un instant à offset explicite, et
 * l'écran doit afficher le bloc à sa nouvelle place sans attendre la réponse.
 * Trois conversions à ne pas rater, dont deux qui ne se verraient pas à l'œil.
 */
describe('le report par glisser-déposer', () => {
  const HASINA = { id: 'staff-hasina', displayName: 'Hasina' };
  const TIANA = { id: 'staff-tiana', displayName: 'Tiana' };

  /** 09:00 – 10:00 au salon d'Antananarivo, le mercredi 26 août 2026. */
  function moved(status: AppointmentStatus = 'confirmed'): Appointment {
    return {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      reference: 'RDV-8F3K-27',
      status,
      client: { id: 'client-1', firstName: 'Rina', lastName: 'Andriamana' },
      staff: HASINA,
      service: {
        id: 'service-1',
        name: 'Massage suédois',
        durationMinutes: 60,
        price: { amountMinor: 3500, currency: 'EUR' },
      },
      startsAt: '2026-08-26T06:00:00.000Z',
      endsAt: '2026-08-26T07:00:00.000Z',
      price: { amountMinor: 3500, currency: 'EUR' },
      createdAt: '2026-08-01T08:00:00.000Z',
    };
  }

  it('convertit le créneau visé avec le fuseau du salon, jamais celui du navigateur', () => {
    const move = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );

    // Le corps part en ISO 8601 avec l'offset de l'établissement, comme
    // `offsetDateTimeSchema` l'exige.
    expect(move?.request.startsAt).toBe('2026-08-26T14:30:00+03:00');
    expect(move?.request.staffId).toBe(HASINA.id);
    // Et l'état optimiste est stocké en UTC, comme tout instant du produit.
    expect(move?.optimistic.startsAt).toBe('2026-08-26T11:30:00.000Z');
  });

  it('conserve la durée du rendez-vous déplacé', () => {
    const move = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );

    // Un report ne change pas la prestation, donc ne change pas sa durée : une
    // heure avant, une heure après.
    expect(move?.optimistic.endsAt).toBe('2026-08-26T12:30:00.000Z');
    expect(move?.optimistic.id).toBe(moved().id);
  });

  it('signale le changement de praticien, et lui seul', () => {
    const sameStaff = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: HASINA },
      ANTANANARIVO,
    );
    const otherStaff = planDeskMove(
      moved(),
      { day: '2026-08-26', time: '14:30', staff: TIANA },
      ANTANANARIVO,
    );

    expect(sameStaff?.changesStaff).toBe(false);
    expect(otherStaff?.changesStaff).toBe(true);
    expect(otherStaff?.optimistic.staff).toEqual(TIANA);
  });

  it('garde le praticien du rendez-vous quand la colonne n’en désigne aucun', () => {
    // Vue semaine : une colonne est une journée de toute l'équipe. Rien à
    // confirmer, et rien à envoyer — le serveur garde le praticien d'origine.
    const move = planDeskMove(
      moved(),
      { day: '2026-08-28', time: '09:00', staff: null },
      ANTANANARIVO,
    );

    expect(move?.changesStaff).toBe(false);
    expect(move?.optimistic.staff).toEqual(HASINA);
    expect(move?.request).toEqual({ startsAt: '2026-08-28T09:00:00+03:00' });
  });

  it('ne déplace pas ce qui est soldé', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      expect(
        planDeskMove(
          moved(status),
          { day: '2026-08-26', time: '14:30', staff: HASINA },
          ANTANANARIVO,
        ),
      ).toBeNull();
    }
  });

  it('ne rend rien d’un lâcher qui ne déplace rien', () => {
    // Même praticien, même heure : envoyer le report réécrirait l'agenda —
    // identifiant neuf, avis de déplacement — pour un geste sans effet.
    expect(
      planDeskMove(moved(), { day: '2026-08-26', time: '09:00', staff: HASINA }, ANTANANARIVO),
    ).toBeNull();
  });
});

/**
 * L'heure d'origine, telle que la bannière de retour arrière la cite.
 *
 * La bannière elle-même est assemblée dans `calendar-board.tsx` et vérifiée à
 * l'écran (#1187) ; ce qui se joue ici est le seul morceau que le composant ne
 * sait pas produire — une date dite à l'heure du salon et dans la langue de la
 * session.
 */
describe('l’instant d’un rendez-vous, dit à l’opérateur', () => {
  const previous: Appointment = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    client: { id: 'client-1', firstName: 'Rina', lastName: 'Andriamana' },
    staff: { id: 'staff-hasina', displayName: 'Hasina' },
    service: {
      id: 'service-1',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: '2026-08-26T06:00:00.000Z',
    endsAt: '2026-08-26T07:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-08-01T08:00:00.000Z',
  };

  it('dit l’heure d’origine à l’heure du salon', () => {
    expect(deskMoment(previous.startsAt, ANTANANARIVO)).toBe('mercredi 26 août à 09:00');
  });

  it('suit la langue de la session pour le jour et le joint', () => {
    // Ce libellé est inséré dans des phrases traduites — la question du
    // changement de praticien et la bannière de retour arrière (#848) : une date
    // française au milieu d'une phrase anglaise se lit comme un défaut
    // d'affichage. Le fuseau, lui, décide de l'heure et jamais de son écriture.
    expect(deskMoment(previous.startsAt, ANTANANARIVO, { locale: 'en' })).toBe(
      'Wednesday, August 26 at 09:00',
    );
  });
});

/**
 * Les créneaux réellement proposables (#611).
 *
 * Le moteur aligne ses créneaux sur le début de plage du praticien, au pas de
 * quinze minutes ; le planning trace des rangées de trente minutes depuis
 * minuit. Ces deux fonctions sont le pont entre les deux — et la seule chose qui
 * empêche l'écran de proposer une heure que l'API refusera.
 */
describe('les créneaux du moteur, ramenés au sélecteur du tiroir', () => {
  /** 07:10, 07:25, 07:40 au salon d'Antananarivo — UTC+3 toute l'année. */
  const JOURNEE = [
    { startsAt: '2026-08-26T04:10:00.000Z' },
    { startsAt: '2026-08-26T04:25:00.000Z' },
    { startsAt: '2026-08-26T04:40:00.000Z' },
  ];

  it('rend les heures civiles du salon, ordonnées', () => {
    const options = deskSlotOptions(JOURNEE, ANTANANARIVO);

    expect(options.map((option) => option.time)).toEqual(['07:10', '07:25', '07:40']);
    // L'instant est conservé tel quel : c'est lui qui repart à l'API, et
    // l'égalité qu'elle exige porte sur cette chaîne.
    expect(options[0]?.startsAt).toBe('2026-08-26T04:10:00.000Z');
  });

  it('dédoublonne les créneaux que plusieurs praticiens offrent à la même heure', () => {
    const options = deskSlotOptions(
      [...JOURNEE, { startsAt: '2026-08-26T04:25:00.000Z' }],
      ANTANANARIVO,
    );

    // Sans praticien désigné, le moteur rend un créneau par praticien libre :
    // le sélecteur afficherait trois fois « 07:25 » sans rien pour les
    // distinguer, et c'est le serveur qui affecte de toute façon.
    expect(options).toHaveLength(3);
  });

  it('préselectionne le premier créneau à partir de l’heure visée', () => {
    const options = deskSlotOptions(JOURNEE, ANTANANARIVO);

    // On a cliqué la rangée de 07:00 : ce qu'on veut, c'est le premier créneau
    // à partir de là — jamais l'heure ronde elle-même, qui n'existe pas.
    expect(nearestDeskSlot(options, '07:00')?.time).toBe('07:10');
    // Et jamais un créneau **avant** la rangée montrée du doigt, même s'il est
    // plus proche : la case annonce « à partir de cette heure ».
    expect(nearestDeskSlot(options, '07:30')?.time).toBe('07:40');
  });

  it('retombe sur le dernier créneau quand la rangée visée est après la journée', () => {
    const options = deskSlotOptions(JOURNEE, ANTANANARIVO);

    expect(nearestDeskSlot(options, '19:00')?.time).toBe('07:40');
  });

  it('ne rend rien sur une journée sans créneau', () => {
    expect(nearestDeskSlot([], '10:00')).toBeNull();
    expect(deskSlotOptions([], ANTANANARIVO)).toEqual([]);
  });
});

/**
 * La rédaction d'un créneau refusé, dans les deux langues — #611.
 *
 * Le 409 couvre cinq refus — pris entre l'affichage et la validation, hors des
 * heures du praticien, congé, préavis, praticien qui ne tient pas ce soin — et
 * n'en distingue aucun : `details` ne rend que le `staffId` et le `startsAt` que
 * l'appelant vient d'envoyer. Les messages l'affirmaient pourtant, et envoyaient
 * l'opératrice chercher une collègue qui n'avait rien réservé.
 *
 * L'invariant se vérifiait jusqu'ici sur deux constantes du module que plus
 * aucun écran ne rendait. Il porte désormais sur le **catalogue** lui-même, donc
 * sur ce que le produit dit vraiment, et sur les **deux langues** — l'anglais
 * n'était couvert par rien (#1187). La règle est écrite à l'en-tête du
 * namespace, `messages/admin-planning.d.ts`.
 */
describe('un créneau refusé n’annonce pas une cause que l’API ne donne pas', () => {
  /**
   * `affirmation` est une **expression**, et non la phrase exacte d'autrefois.
   *
   * L'ancienne rédaction française se cite telle quelle — c'est elle qu'on
   * interdit de revenir. L'anglaise, elle, n'a jamais existé : le catalogue en
   * est né corrigé, et une chaîne inventée ne serait jamais retrouvée, quelle
   * que soit la retraduction. Ce qui se refuse ici est donc la **forme
   * affirmative** — « has been taken », « was taken » —, que « may have been
   * taken » ne satisfait pas.
   */
  const ATTENDU = {
    fr: {
      prudence: 'n’est pas — ou n’est plus — réservable',
      affirmation: /vient d’être pris depuis un autre poste|a été pris depuis un autre poste/,
      titre: 'Créneau indisponible',
    },
    en: {
      prudence: 'is not — or is no longer — bookable',
      affirmation: /\b(has|had|was|is) (just )?been taken from another workstation/,
      titre: 'Slot unavailable',
    },
  } as const;

  for (const locale of ['fr', 'en'] as const) {
    it(`énumère les causes sans en désigner une — ${locale}`, () => {
      const words = planningWords(locale);
      const { prudence, affirmation } = ATTENDU[locale];

      // Le tiroir et le glisser-déposer ont deux phrases distinctes — l'une
      // promet que les saisies sont conservées, l'autre renvoie au tiroir —,
      // mais la même retenue les tient toutes les deux.
      for (const body of [words.desk.conflictBody, words.move.conflictBody]) {
        expect(body).toContain(prudence);
        expect(body).not.toMatch(affirmation);
      }
    });

    it(`garde ce doute dans les deux titres qui les coiffent — ${locale}`, () => {
      // « Indisponible » et non « déjà pris » : le titre est la première chose
      // que l'opératrice lit, et c'est là que l'ancienne version affirmait le
      // plus fort. Le tiroir a le sien (`desk.conflictTitle`, rendu par la
      // bannière de refus d'écriture) et le report le sien : les oublier l'un
      // ou l'autre laisserait le doute à moitié tenu.
      const words = planningWords(locale);

      for (const title of [words.desk.conflictTitle, words.move.conflictTitle]) {
        expect(title).toContain(ATTENDU[locale].titre);
      }
    });
  }
});
