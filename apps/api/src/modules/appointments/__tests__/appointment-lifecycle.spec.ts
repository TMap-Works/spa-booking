import { InvalidStateTransitionError } from '../../../common/errors';
import { ALLOWED_TRANSITIONS, AppointmentLifecycleService } from '../appointment-lifecycle.service';
import {
  APPOINTMENT_STATUSES,
  OCCUPYING_STATUSES,
  OUTCOME_STATUSES,
} from '../appointment-status';
import { AppointmentNotStartedError } from '../appointments.errors';

/**
 * Le cycle de vie du rendez-vous — et le **témoin** qui l'attache à la
 * contrainte d'exclusion.
 *
 * Ce que cette suite protège n'est pas la table : c'est le fait qu'elle dise la
 * même chose que la base. Une divergence entre « ce que le cycle de vie autorise
 * à annuler » et « ce qui occupe l'agenda » est silencieuse et coûte des deux
 * côtés :
 *
 * - trop large, le service accepterait d'annuler un `COMPLETED`, l'`UPDATE`
 *   conditionnel du repository mettrait à jour zéro ligne, et la cliente
 *   recevrait un 409 « rechargez » sur un rendez-vous qui n'a jamais été
 *   annulable ;
 * - trop étroite, un créneau resterait bloqué par une ligne que la contrainte
 *   compte encore et que plus personne ne peut annuler.
 */

const lifecycle = new AppointmentLifecycleService();

/** L'heure du soin, et deux instants qui l'encadrent. */
const STARTS_AT = new Date('2026-10-14T08:00:00.000Z');
const AVANT = new Date('2026-10-14T07:59:59.999Z');
const APRES = new Date('2026-10-14T08:30:00.000Z');

/** Un rendez-vous déjà commencé : le cas où la table seule décide. */
const COMMENCE = { startsAt: STARTS_AT, now: APRES } as const;

/** Le même, encore à venir. */
const A_VENIR = { startsAt: STARTS_AT, now: AVANT } as const;

describe('appointment-lifecycle — table des transitions', () => {
  it('décrit les cinq statuts, terminaux compris', () => {
    // Écrire les listes vides plutôt que d'omettre les clés est ce qui fait
    // qu'un sixième statut ajouté au vocabulaire ne compile pas tant qu'il n'a
    // pas été rangé ici.
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });

  it('mène `PENDING` vers la confirmation ou l’annulation, et nulle part ailleurs', () => {
    expect(ALLOWED_TRANSITIONS.PENDING).toEqual(['CONFIRMED', 'CANCELLED']);
  });

  it('mène `CONFIRMED` vers l’honoré, l’annulé ou le no-show', () => {
    expect(ALLOWED_TRANSITIONS.CONFIRMED).toEqual(['COMPLETED', 'CANCELLED', 'NO_SHOW']);
  });

  it('interdit tout retour en arrière depuis un statut terminal', () => {
    // « Tout retour en arrière depuis `completed` » est interdit
    // (booking-engine §5) — et un rendez-vous annulé ou no-show ne se rouvre pas
    // davantage : on en reprend un neuf.
    for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      for (const target of APPOINTMENT_STATUSES) {
        expect(lifecycle.canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('interdit le passage direct de `PENDING` à `COMPLETED`', () => {
    // Un soin ne peut pas être honoré sans avoir été confirmé : sauter la
    // confirmation priverait la chaîne de notifications de son point d'accroche.
    expect(lifecycle.canTransition('PENDING', 'COMPLETED')).toBe(false);
  });

  it('n’autorise aucun statut à se transiter vers lui-même', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(lifecycle.canTransition(status, status)).toBe(false);
    }
  });
});

describe('appointment-lifecycle — le refus', () => {
  it('laisse passer une transition autorisée sans rien lever', () => {
    expect(() => {
      lifecycle.requireTransition('PENDING', 'CANCELLED', A_VENIR);
    }).not.toThrow();
    expect(() => {
      lifecycle.requireTransition('CONFIRMED', 'CANCELLED', A_VENIR);
    }).not.toThrow();
  });

  it('refuse une transition interdite en 422, en nommant les deux statuts', () => {
    // 422 et non 409 : la requête est bien formée et l'état du monde n'a pas
    // changé sous elle — c'est la demande elle-même qui n'a pas de sens.
    let thrown: unknown;
    try {
      lifecycle.requireTransition('COMPLETED', 'CANCELLED', COMMENCE);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidStateTransitionError);
    const error = thrown as InvalidStateTransitionError;
    expect(error.status).toBe(422);
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.details).toMatchObject({ from: 'COMPLETED', to: 'CANCELLED' });
  });
});

/**
 * La seconde règle — #1137.
 *
 * Ce qu'elle protège n'est pas le cycle de vie, c'est le **chiffre** : `COMPLETED`
 * et `NO_SHOW` sont terminaux et libèrent le créneau, si bien qu'une écriture
 * prématurée ne se reprend pas. Le taux de no-show du CDC §1.4 comptait des
 * absences à des soins qui n'avaient pas encore eu lieu, et le CRM affichait une
 * dernière visite dans le futur.
 */
describe('appointment-lifecycle — le constat ne précède pas le fait', () => {
  it.each(OUTCOME_STATUSES)('refuse %s tant que le rendez-vous n’a pas commencé', (outcome) => {
    let thrown: unknown;
    try {
      lifecycle.requireTransition('CONFIRMED', outcome, A_VENIR);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppointmentNotStartedError);
    const error = thrown as AppointmentNotStartedError;
    // Même code et même statut que la transition interdite : le front branche
    // sur `code`, et c'est bien le cycle de vie qui refuse. Ce qui distingue ce
    // refus-ci est `details.notStarted`, sur quoi un écran peut proposer
    // « attendre l'heure » plutôt que « recharger ».
    expect(error.status).toBe(422);
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.details).toMatchObject({
      from: 'CONFIRMED',
      to: outcome,
      startsAt: STARTS_AT.toISOString(),
      now: AVANT.toISOString(),
      notStarted: true,
    });
    // Le message dit *pourquoi*, et non seulement que c'est interdit.
    expect(error.message).toContain('n’a pas commencé');
  });

  it.each(OUTCOME_STATUSES)('accepte %s dès que le rendez-vous a commencé', (outcome) => {
    expect(() => {
      lifecycle.requireTransition('CONFIRMED', outcome, COMMENCE);
    }).not.toThrow();
  });

  it.each(OUTCOME_STATUSES)('compte l’instant exact du début comme commencé (%s)', (outcome) => {
    // L'égalité penche du côté qui autorise : à l'heure pile, le rendez-vous a
    // lieu, et la cliente qui n'est pas là est déjà absente.
    expect(() => {
      lifecycle.requireTransition('CONFIRMED', outcome, { startsAt: STARTS_AT, now: STARTS_AT });
    }).not.toThrow();
  });

  it('n’empêche pas d’annuler un rendez-vous à venir — annuler est une décision', () => {
    // C'est même le cas normal : on annule *avant*. Étendre la règle à
    // `CANCELLED` aurait supprimé l'annulation du salon.
    expect(() => {
      lifecycle.requireTransition('CONFIRMED', 'CANCELLED', A_VENIR);
    }).not.toThrow();
    expect(() => {
      lifecycle.requireTransition('PENDING', 'CANCELLED', A_VENIR);
    }).not.toThrow();
  });

  it('n’empêche pas de confirmer un rendez-vous à venir', () => {
    // La confirmation est ce qui précède toujours le soin : la règle ne doit pas
    // la toucher, sans quoi plus aucun rendez-vous ne serait confirmable.
    expect(() => {
      lifecycle.requireTransition('PENDING', 'CONFIRMED', A_VENIR);
    }).not.toThrow();
  });

  it('dit « interdit » plutôt que « pas commencé » quand la table refuse déjà', () => {
    // `PENDING → COMPLETED` est interdit par nature, même sur un rendez-vous
    // passé : l'ordre des deux règles est ce qui garde ce refus-là lisible.
    let thrown: unknown;
    try {
      lifecycle.requireTransition('PENDING', 'COMPLETED', A_VENIR);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidStateTransitionError);
    expect(thrown).not.toBeInstanceOf(AppointmentNotStartedError);
    expect((thrown as InvalidStateTransitionError).details).not.toHaveProperty('notStarted');
  });

  it('expose le prédicat d’horloge, borne incluse', () => {
    expect(lifecycle.hasStarted(A_VENIR)).toBe(false);
    expect(lifecycle.hasStarted(COMMENCE)).toBe(true);
    expect(lifecycle.hasStarted({ startsAt: STARTS_AT, now: STARTS_AT })).toBe(true);
  });
});

describe('appointment-lifecycle — le témoin de la contrainte d’exclusion', () => {
  it('dit « annulable » exactement là où `OCCUPYING_STATUSES` dit « occupe »', () => {
    // Les deux listes vivent dans deux fichiers, pour deux raisons différentes :
    // l'une décrit le cycle de vie, l'autre le filtre partiel de
    // `appointments_no_overlap`. Elles doivent malgré tout coïncider, et c'est
    // cette assertion — et elle seule — qui l'impose.
    expect([...lifecycle.statusesLeadingTo('CANCELLED')].sort()).toEqual(
      [...OCCUPYING_STATUSES].sort(),
    );
  });

  it('ne mène à `COMPLETED` que depuis un statut qui occupait le créneau', () => {
    // Honorer un rendez-vous que personne n'occupait n'a pas de sens : le
    // reporting compterait un soin rendu sur un créneau que le salon avait
    // libéré.
    for (const from of lifecycle.statusesLeadingTo('COMPLETED')) {
      expect(OCCUPYING_STATUSES as readonly string[]).toContain(from);
    }
  });

  it('dit « issue » exactement des statuts terminaux qui ne sont pas l’annulation', () => {
    // La liste de #1137 n'est pas un troisième vocabulaire : c'est la partie
    // *constatée* du cycle de vie. La dériver ici plutôt que de la recopier est
    // ce qui fait qu'un sixième statut terminal ajouté demain sans être rangé
    // dans `OUTCOME_STATUSES` — ou l'inverse — rougit avant de partir en
    // production.
    const terminaux = APPOINTMENT_STATUSES.filter(
      (status) => ALLOWED_TRANSITIONS[status].length === 0 && status !== 'CANCELLED',
    );

    expect([...OUTCOME_STATUSES].sort()).toEqual([...terminaux].sort());
  });

  it('ne compte aucune issue parmi les statuts qui occupent le créneau', () => {
    // Un constat libère le créneau (booking-engine §5) : les deux listes sont
    // disjointes par construction, et c'est ce qui rend l'invalidation de cache
    // de `changeStatus` correcte.
    for (const outcome of OUTCOME_STATUSES) {
      expect(OCCUPYING_STATUSES as readonly string[]).not.toContain(outcome);
    }
  });
});
