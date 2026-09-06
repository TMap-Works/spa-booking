import type { StaffMember } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  inviteStaffAccountRequestSchema,
  isStaffRole,
  staffAccountStateSchema,
  staffInvitationSchema,
  toApiRole,
} from '@/lib/admin/staff-contract';
import { sortStaffMembers, staffInitials } from '@/lib/admin/staff-directory';

/**
 * L'annuaire du personnel et les formes que l'API en attend (#53).
 *
 * Deux fautes sont couvertes ici, et chacune se solde par un refus que rien
 * n'expliquerait à l'écran : un rôle envoyé en minuscules là où l'API lit une
 * énumération PostgreSQL, et un compte `client` proposé à des actions qui
 * supposent un rôle interne.
 */

function member(id: string, displayName: string, isActive: boolean): StaffMember {
  return { id, displayName, isActive };
}

describe('la pastille de la liste', () => {
  it('prend l’initiale de deux mots au plus', () => {
    expect(staffInitials('Hasina Rakoto')).toBe('HR');
    expect(staffInitials('Marie Claire Andria')).toBe('MC');
  });

  it('rend une seule lettre pour un nom d’un seul mot', () => {
    // « Ha » se lit comme un mot tronqué ; « H » se lit comme une initiale.
    expect(staffInitials('Hasina')).toBe('H');
  });

  it('ne trébuche pas sur les espaces multiples ni sur un nom vide', () => {
    expect(staffInitials('  Njara   Be  ')).toBe('NB');
    expect(staffInitials('   ')).toBe('');
  });
});

describe('l’ordre de la liste', () => {
  it('range les fiches actives d’abord, puis par nom', () => {
    // Le back-office garde les fiches suspendues — on y vient pour en réactiver
    // une — mais la liste sert d'abord à ouvrir l'agenda de qui travaille.
    const sorted = sortStaffMembers([
      member('1', 'Zoé', true),
      member('2', 'Njara', false),
      member('3', 'Émilie', true),
    ]);

    expect(sorted.map((entry) => entry.displayName)).toEqual(['Émilie', 'Zoé', 'Njara']);
  });

  it('ne modifie pas le tableau reçu', () => {
    const members = [member('1', 'Zoé', true), member('2', 'Émilie', true)];

    sortStaffMembers(members);

    expect(members.map((entry) => entry.displayName)).toEqual(['Zoé', 'Émilie']);
  });
});

describe('le rôle, de part et d’autre de la frontière', () => {
  it('part en majuscules — la casse que l’énumération PostgreSQL écrit', () => {
    // `role: 'manager'` posté tel quel se ferait refuser en 400 par le `@IsIn`
    // du DTO, sur un rôle pourtant parfaitement licite.
    expect(toApiRole('manager')).toBe('MANAGER');
    expect(toApiRole('staff')).toBe('STAFF');
  });

  it('ne reconnaît pas `client` comme un rôle du personnel', () => {
    expect(isStaffRole('client')).toBe(false);
    expect(isStaffRole('admin')).toBe(true);
  });

  it('refuse d’inviter une cliente', () => {
    // Un compte `client` créé ici serait aussitôt invisible : la liste du
    // personnel ne le rend pas.
    const parsed = inviteStaffAccountRequestSchema.safeParse({
      email: 'cliente@salon-des-lilas.test',
      role: 'client',
      firstName: 'Alice',
      lastName: 'Durand',
    });

    expect(parsed.success).toBe(false);
  });

  it('accepte une invitation sans téléphone', () => {
    const parsed = inviteStaffAccountRequestSchema.safeParse({
      email: 'praticienne@salon-des-lilas.test',
      role: 'staff',
      firstName: 'Alice',
      lastName: 'Durand',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuse un mot de passe glissé dans le corps', () => {
    // Le champ n'existe pas, et son absence est la décision principale de ce
    // formulaire : le compte naît sans secret.
    const parsed = inviteStaffAccountRequestSchema.safeParse({
      email: 'praticienne@salon-des-lilas.test',
      role: 'staff',
      firstName: 'Alice',
      lastName: 'Durand',
      password: 'motdepasse',
    });

    expect(parsed.success).toBe(false);
  });
});

describe('les réponses que l’API rend', () => {
  it('lit un compte dont le rôle arrive en majuscules', () => {
    // L'API émet `STAFF` là où le contrat partagé nomme `staff` : la conversion
    // se fait à la frontière, et nulle part ailleurs.
    const parsed = staffAccountStateSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'hasina@salon-des-lilas.test',
      role: 'MANAGER',
      firstName: 'Hasina',
      lastName: 'Rakoto',
      phone: null,
      isActive: false,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.role).toBe('manager');
      expect(parsed.data.isActive).toBe(false);
    }
  });

  it('lit une invitation avec son jeton et sa durée', () => {
    const parsed = staffInvitationSchema.safeParse({
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'hasina@salon-des-lilas.test',
        role: 'STAFF',
        firstName: 'Hasina',
        lastName: 'Rakoto',
        phone: null,
      },
      invitationToken: 'jeton-opaque',
      expiresIn: 604_800,
    });

    expect(parsed.success).toBe(true);
  });
});
