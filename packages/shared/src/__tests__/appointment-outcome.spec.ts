/**
 * « On ne constate pas ce qui n'a pas eu lieu » — la règle du contrat, #1210.
 *
 * Elle existe parce que trois endroits en avaient besoin et qu'aucun ne
 * l'écrivait pareil : le cycle de vie du serveur la fait respecter (#1137), le
 * tiroir du comptoir ne la connaissait pas, et « Mon planning » la recopiait sur
 * place. Ces cas gardent l'écriture unique, bornes comprises — c'est sur les
 * bornes que deux écritures divergent.
 */

import {
  APPOINTMENT_STATUSES,
  OUTCOME_APPOINTMENT_STATUSES,
  TERMINAL_APPOINTMENT_STATUSES,
  canRecordAppointmentOutcome,
  hasAppointmentStarted,
  isOutcomeAppointmentStatus,
} from '../constants/appointment';

/** L'heure du soin, et deux instants de part et d'autre. */
const DEBUT = '2026-09-24T09:00:00.000Z';
const AVANT = Date.parse('2026-09-24T08:59:59.999Z');
const PILE = Date.parse(DEBUT);
const APRES = Date.parse('2026-09-24T09:00:00.001Z');

describe('les constats du rendez-vous', () => {
  it('ne retient que « honoré » et « non présenté », et ce sont des statuts connus', () => {
    expect([...OUTCOME_APPOINTMENT_STATUSES]).toEqual(['completed', 'no_show']);

    for (const status of OUTCOME_APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUSES).toContain(status);
      expect(isOutcomeAppointmentStatus(status)).toBe(true);
    }
  });

  /**
   * `cancelled` est terminal, et n'est pourtant pas un constat : annuler est une
   * **décision**, et elle se prend précisément avant l'heure du soin. Les
   * confondre aurait fermé l'annulation d'un rendez-vous à venir — c'est-à-dire
   * la seule qui ait un sens.
   */
  it('écarte l’annulation, qui est terminale sans rien constater', () => {
    expect(TERMINAL_APPOINTMENT_STATUSES).toContain('cancelled');
    expect(isOutcomeAppointmentStatus('cancelled')).toBe(false);
    expect(isOutcomeAppointmentStatus('pending')).toBe(false);
    expect(isOutcomeAppointmentStatus('confirmed')).toBe(false);
  });
});

describe('hasAppointmentStarted', () => {
  it('tranche à la milliseconde, et l’égalité autorise', () => {
    expect(hasAppointmentStarted(DEBUT, AVANT)).toBe(false);
    expect(hasAppointmentStarted(DEBUT, PILE)).toBe(true);
    expect(hasAppointmentStarted(DEBUT, APRES)).toBe(true);
  });

  it('lit indifféremment une chaîne ISO ou une Date, des deux côtés', () => {
    expect(hasAppointmentStarted(new Date(DEBUT), new Date(APRES))).toBe(true);
    expect(hasAppointmentStarted(new Date(DEBUT), new Date(AVANT))).toBe(false);
    expect(hasAppointmentStarted(DEBUT, new Date(PILE))).toBe(true);
  });

  /**
   * Faute de savoir, on n'ouvre pas un geste **terminal et sans retour** : une
   * heure absente ou illisible vaut « pas commencé ». L'inverse aurait fait
   * d'une donnée manquante une autorisation.
   */
  it('refuse de conclure sur une heure absente ou illisible', () => {
    expect(hasAppointmentStarted(null, APRES)).toBe(false);
    expect(hasAppointmentStarted(undefined, APRES)).toBe(false);
    expect(hasAppointmentStarted('', APRES)).toBe(false);
    expect(hasAppointmentStarted('pas-une-heure', APRES)).toBe(false);
    expect(hasAppointmentStarted(new Date('pas-une-heure'), APRES)).toBe(false);
  });
});

describe('canRecordAppointmentOutcome', () => {
  it('refuse les deux constats tant que le soin n’a pas commencé', () => {
    expect(canRecordAppointmentOutcome('completed', DEBUT, AVANT)).toBe(false);
    expect(canRecordAppointmentOutcome('no_show', DEBUT, AVANT)).toBe(false);
  });

  it('les ouvre dès l’heure du soin', () => {
    expect(canRecordAppointmentOutcome('completed', DEBUT, PILE)).toBe(true);
    expect(canRecordAppointmentOutcome('no_show', DEBUT, APRES)).toBe(true);
  });

  /**
   * L'horloge ne borne que les constats. Confirmer et annoter un renoncement
   * sont des décisions, et un rendez-vous à venir est exactement celui sur
   * lequel on les prend.
   */
  it('ne borne ni la confirmation ni l’annulation', () => {
    expect(canRecordAppointmentOutcome('confirmed', DEBUT, AVANT)).toBe(true);
    expect(canRecordAppointmentOutcome('cancelled', DEBUT, AVANT)).toBe(true);
    expect(canRecordAppointmentOutcome('pending', DEBUT, AVANT)).toBe(true);
  });

  it('refuse un constat dont l’heure est introuvable, quel que soit l’instant', () => {
    expect(canRecordAppointmentOutcome('no_show', null, APRES)).toBe(false);
    expect(canRecordAppointmentOutcome('completed', 'pas-une-heure', APRES)).toBe(false);
  });
});
