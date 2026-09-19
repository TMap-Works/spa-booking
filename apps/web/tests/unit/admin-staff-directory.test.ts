import {
  DISPLAY_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  displayNameSchema,
  type StaffMember,
} from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  inviteStaffAccountRequestSchema,
  isStaffRole,
  staffInvitationSchema,
  toApiRole,
} from '@/lib/admin/staff-contract';
import {
  sortStaffMembers,
  staffInitials,
  suggestedStaffDisplayName,
} from '@/lib/admin/staff-directory';

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

describe('le nom proposé à la création d’une fiche', () => {
  it('reprend le prénom et le nom du compte', () => {
    expect(suggestedStaffDisplayName({ firstName: 'Léa', lastName: 'Praticienne' })).toBe(
      'Léa Praticienne',
    );
  });

  it('ne laisse pas d’espace en bout quand une moitié manque', () => {
    // L'espace se verrait à la sélection, et partirait tel quel dans le corps.
    expect(suggestedStaffDisplayName({ firstName: 'Léa', lastName: '' })).toBe('Léa');
    expect(suggestedStaffDisplayName({ firstName: '', lastName: 'Rakoto' })).toBe('Rakoto');
  });

  /*
   * Deux moitiés extrêmes (#714).
   *
   * Chaque moitié tient dans `NAME_MAX_LENGTH` = 80, leur somme espacée fait 161,
   * et `DISPLAY_NAME_MAX_LENGTH` vaut 160 : le formulaire préremplissait donc le
   * champ avec une valeur que sa propre soumission refusait. Le cas est le seul
   * que les deux bornes rendent atteignable, et c'est exactement celui-là qu'on
   * fige ici.
   */
  it('se replie sur le prénom seul quand le nom complet ne tient pas', () => {
    const firstName = 'Andrianampoinimerina'.padEnd(NAME_MAX_LENGTH, 'a');
    const lastName = 'Rakotoarisoa'.padEnd(NAME_MAX_LENGTH, 'o');

    expect(`${firstName} ${lastName}`).toHaveLength(DISPLAY_NAME_MAX_LENGTH + 1);
    // Le prénom entier, pas un patronyme tranché au milieu d'un mot : une
    // proposition est faite pour être lue et corrigée.
    expect(suggestedStaffDisplayName({ firstName, lastName })).toBe(firstName);
  });

  it('ne propose jamais plus long que ce que le contrat accepte', () => {
    // La promesse de la fonction, éprouvée contre le schéma lui-même plutôt que
    // contre un nombre recopié : c'est ce refus-là qui tombait à la soumission.
    // Seul le plafond est en jeu — un compte sans aucun nom rendrait la chaîne
    // vide, et c'est le champ obligatoire du formulaire qui s'en charge.
    const cases = [
      { firstName: 'Léa', lastName: 'Praticienne' },
      { firstName: 'a'.repeat(NAME_MAX_LENGTH), lastName: 'b'.repeat(NAME_MAX_LENGTH) },
      // Hors d'atteinte par `nameSchema`, mais la fonction ne s'appuie sur
      // aucune borne posée ailleurs : le dernier filet tronque.
      { firstName: '', lastName: 'z'.repeat(DISPLAY_NAME_MAX_LENGTH + 40) },
    ];

    for (const account of cases) {
      const suggestion = suggestedStaffDisplayName(account);

      expect(suggestion.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
      expect(displayNameSchema.safeParse(suggestion).success).toBe(true);
    }
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

/*
 * Le compte **avec** son état d'activation ne se lit plus ici : il est
 * `staffAccountStateSchema` de `@spa/shared` depuis #695, et
 * `packages/shared/src/__tests__/schemas.spec.ts` le couvre déjà — casse du rôle
 * ramenée au vocabulaire du contrat, et `isActive` exigé. Le rejouer depuis
 * `apps/web` n'éprouverait rien du front : ce fichier garde les formes que
 * `lib/admin/staff-contract.ts` déclare pour de bon.
 */
describe('les réponses que l’API rend', () => {
  it('lit une invitation avec son jeton et sa durée', () => {
    const parsed = staffInvitationSchema.safeParse({
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'hasina@salon-des-lilas.test',
        role: 'STAFF',
        firstName: 'Hasina',
        lastName: 'Rakoto',
        phone: null,
        // Toujours émise depuis #844, et `null` ici : l'administrateur qui
        // invite ne connaît pas la langue de la personne invitée.
        locale: null,
      },
      invitationToken: 'jeton-opaque',
      expiresIn: 604_800,
    });

    expect(parsed.success).toBe(true);
  });
});
