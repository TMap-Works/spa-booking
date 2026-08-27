import { InvalidStateTransitionError } from '../../../common/errors';
import { ALLOWED_TRANSITIONS, AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { APPOINTMENT_STATUSES, OCCUPYING_STATUSES } from '../appointment-status';

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
      lifecycle.requireTransition('PENDING', 'CANCELLED');
    }).not.toThrow();
    expect(() => {
      lifecycle.requireTransition('CONFIRMED', 'CANCELLED');
    }).not.toThrow();
  });

  it('refuse une transition interdite en 422, en nommant les deux statuts', () => {
    // 422 et non 409 : la requête est bien formée et l'état du monde n'a pas
    // changé sous elle — c'est la demande elle-même qui n'a pas de sens.
    let thrown: unknown;
    try {
      lifecycle.requireTransition('COMPLETED', 'CANCELLED');
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
});
