/**
 * Constantes du contrat — statuts de rendez-vous, rôles, canaux de notification.
 *
 * Ces tests gardent des invariants qu'un ajout de valeur peut casser sans qu'une
 * seule ligne de code applicatif ne change : une transition qui rouvrirait un
 * statut terminal, un rôle qui casserait l'emboîtement, un statut bloquant qui
 * ne serait plus un statut connu.
 */

import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_TRANSITIONS,
  BLOCKING_APPOINTMENT_STATUSES,
  TERMINAL_APPOINTMENT_STATUSES,
  canTransitionAppointment,
  isAppointmentStatus,
  isBlockingAppointmentStatus,
} from '../constants/appointment';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  isNotificationChannel,
} from '../constants/notification';
import { CAPTURED_PAYMENT_STATUSES, PAYMENT_STATUSES, isPaymentStatus } from '../constants/payment';
import {
  STAFF_ROLES,
  USER_ROLES,
  USER_ROLE_RANK,
  hasAtLeastRole,
  isStaffRole,
  isUserRole,
} from '../constants/roles';

describe('statuts de rendez-vous', () => {
  it('déclare une transition pour chaque statut, et rien qui sorte de la liste', () => {
    for (const status of APPOINTMENT_STATUSES) {
      const targets = APPOINTMENT_STATUS_TRANSITIONS[status];

      expect(targets).toBeDefined();
      for (const target of targets) {
        expect(APPOINTMENT_STATUSES).toContain(target);
      }
    }
  });

  it('ne laisse aucune transition partir d’un statut terminal', () => {
    for (const status of TERMINAL_APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('refuse le raccourci pending → completed', () => {
    expect(canTransitionAppointment('pending', 'confirmed')).toBe(true);
    expect(canTransitionAppointment('pending', 'completed')).toBe(false);
    expect(canTransitionAppointment('confirmed', 'completed')).toBe(true);
  });

  it('refuse tout retour en arrière depuis un statut terminal', () => {
    expect(canTransitionAppointment('completed', 'confirmed')).toBe(false);
    expect(canTransitionAppointment('cancelled', 'pending')).toBe(false);
    expect(canTransitionAppointment('no_show', 'confirmed')).toBe(false);
  });

  it('ne considère bloquants que les statuts qui occupent réellement le créneau', () => {
    expect(isBlockingAppointmentStatus('pending')).toBe(true);
    expect(isBlockingAppointmentStatus('confirmed')).toBe(true);
    expect(isBlockingAppointmentStatus('cancelled')).toBe(false);
    expect(isBlockingAppointmentStatus('completed')).toBe(false);
    expect(isBlockingAppointmentStatus('no_show')).toBe(false);
  });

  it('n’a aucun statut à la fois bloquant et terminal', () => {
    for (const status of BLOCKING_APPOINTMENT_STATUSES) {
      expect(TERMINAL_APPOINTMENT_STATUSES).not.toContain(status);
    }
  });

  it('garde isAppointmentStatus contre une valeur inconnue', () => {
    expect(isAppointmentStatus('confirmed')).toBe(true);
    expect(isAppointmentStatus('CONFIRMED')).toBe(false);
    expect(isAppointmentStatus(undefined)).toBe(false);
  });
});

describe('rôles', () => {
  it('classe les quatre rôles dans un ordre strictement croissant', () => {
    const ranks = USER_ROLES.map((role) => USER_ROLE_RANK[role]);

    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(USER_ROLES.length);
  });

  it('donne à chaque rôle ce que peuvent les rôles inférieurs', () => {
    expect(hasAtLeastRole('admin', 'staff')).toBe(true);
    expect(hasAtLeastRole('manager', 'staff')).toBe(true);
    expect(hasAtLeastRole('staff', 'manager')).toBe(false);
    expect(hasAtLeastRole('client', 'staff')).toBe(false);
    expect(hasAtLeastRole('client', 'client')).toBe(true);
  });

  it('range tout sauf client parmi les rôles d’établissement', () => {
    expect(isStaffRole('client')).toBe(false);
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
    }
    expect(STAFF_ROLES.length).toBe(USER_ROLES.length - 1);
  });

  it('garde isUserRole contre la casse majuscule du stockage Prisma', () => {
    expect(isUserRole('manager')).toBe(true);
    expect(isUserRole('MANAGER')).toBe(false);
    expect(isUserRole('owner')).toBe(false);
  });
});

describe('notifications et paiements', () => {
  it('s’en tient aux deux canaux et trois messages du périmètre MVP', () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(['email', 'sms']);
    expect(NOTIFICATION_TYPES.length).toBe(3);
    expect(isNotificationChannel('email')).toBe(true);
    expect(isNotificationChannel('push')).toBe(false);
  });

  it('ne compte comme encaissés que des statuts de paiement connus', () => {
    for (const status of CAPTURED_PAYMENT_STATUSES) {
      expect(PAYMENT_STATUSES).toContain(status);
      expect(isPaymentStatus(status)).toBe(true);
    }
    expect(CAPTURED_PAYMENT_STATUSES).not.toContain('failed');
    expect(CAPTURED_PAYMENT_STATUSES).not.toContain('pending');
  });
});
