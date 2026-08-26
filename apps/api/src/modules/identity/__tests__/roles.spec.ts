import { UserRole as PrismaUserRole } from '@prisma/client';

import {
  hasAtLeastRole,
  isPersistableUserRole,
  isStaffRole,
  isUserRole,
  PERSISTABLE_STAFF_ROLES,
  PERSISTABLE_USER_ROLES,
  rolesAtLeast,
  STAFF_ROLES,
  USER_ROLE_RANK,
  USER_ROLES,
} from '../roles';

/**
 * L'énumération telle que Prisma la génère — le témoin de l'écart entre ce que
 * l'autorisation nomme et ce que la colonne sait écrire.
 *
 * Elle est importée **ici** et non dans `roles.ts` : ce dernier est chargé par la
 * garde, donc par tous les contrôleurs, et api-module §2 réserve l'import du
 * client Prisma à la couche repository.
 */
const PRISMA_USER_ROLE_VALUES: readonly string[] = Object.values(PrismaUserRole);

/**
 * Vocabulaire des rôles et hiérarchie — le socle sur lequel la garde décide.
 *
 * Une erreur d'un cran dans le rang n'échoue nulle part : elle autorise
 * simplement le rôle en dessous de celui annoncé, et rien ne le signale. C'est
 * pourquoi ces propriétés sont testées séparément de la garde, où elles se
 * confondraient avec le câblage HTTP.
 */
describe('roles — vocabulaire et hiérarchie', () => {
  it('énumère les quatre rôles du CDC §1.4, du moins au plus capable', () => {
    expect(USER_ROLES).toEqual(['CLIENT', 'STAFF', 'MANAGER', 'ADMIN']);
  });

  it('dérive un rang strictement croissant, sans doublon ni trou', () => {
    const ranks = USER_ROLES.map((role) => USER_ROLE_RANK[role]);
    expect(ranks).toEqual([0, 1, 2, 3]);
  });

  describe('hasAtLeastRole', () => {
    it('rend vrai pour un rôle égal ou supérieur au seuil', () => {
      expect(hasAtLeastRole('ADMIN', 'STAFF')).toBe(true);
      expect(hasAtLeastRole('MANAGER', 'STAFF')).toBe(true);
      expect(hasAtLeastRole('STAFF', 'STAFF')).toBe(true);
    });

    it('rend faux pour un rôle inférieur au seuil', () => {
      expect(hasAtLeastRole('CLIENT', 'STAFF')).toBe(false);
      expect(hasAtLeastRole('STAFF', 'MANAGER')).toBe(false);
      expect(hasAtLeastRole('MANAGER', 'ADMIN')).toBe(false);
    });

    it('est réflexive et transitive sur les quatre rôles', () => {
      for (const role of USER_ROLES) {
        expect(hasAtLeastRole(role, role)).toBe(true);
      }
      // Emboîtement strict : ce que la garde suppose en comparant des rangs.
      expect(hasAtLeastRole('ADMIN', 'MANAGER')).toBe(true);
      expect(hasAtLeastRole('MANAGER', 'STAFF')).toBe(true);
      expect(hasAtLeastRole('ADMIN', 'CLIENT')).toBe(true);
    });
  });

  describe('rolesAtLeast', () => {
    it('rend le seuil et tout ce qui est au-dessus, dans l’ordre du rang', () => {
      expect(rolesAtLeast('CLIENT')).toEqual(['CLIENT', 'STAFF', 'MANAGER', 'ADMIN']);
      expect(rolesAtLeast('STAFF')).toEqual(['STAFF', 'MANAGER', 'ADMIN']);
      expect(rolesAtLeast('MANAGER')).toEqual(['MANAGER', 'ADMIN']);
      expect(rolesAtLeast('ADMIN')).toEqual(['ADMIN']);
    });

    it('coïncide avec `hasAtLeastRole`, rôle par rôle', () => {
      for (const minimum of USER_ROLES) {
        const expected = USER_ROLES.filter((role) => hasAtLeastRole(role, minimum));
        expect(rolesAtLeast(minimum)).toEqual(expected);
      }
    });
  });

  describe('isUserRole', () => {
    it('reconnaît les quatre libellés', () => {
      for (const role of USER_ROLES) {
        expect(isUserRole(role)).toBe(true);
      }
    });

    it('refuse tout le reste — c’est le filtre des revendications de jeton', () => {
      for (const value of ['admin', 'ADMIN ', 'SUPERADMIN', '', 0, null, undefined, {}, ['ADMIN']]) {
        expect(isUserRole(value)).toBe(false);
      }
    });
  });

  describe('rôles internes à l’établissement', () => {
    it('`STAFF_ROLES` est exactement « tout sauf CLIENT »', () => {
      expect(STAFF_ROLES).toEqual(USER_ROLES.filter((role) => role !== 'CLIENT'));
    });

    it('`isStaffRole` accorde à tout rôle non client', () => {
      expect(isStaffRole('CLIENT')).toBe(false);
      expect(isStaffRole('STAFF')).toBe(true);
      expect(isStaffRole('MANAGER')).toBe(true);
      expect(isStaffRole('ADMIN')).toBe(true);
    });
  });

  describe('frontière entre ce que l’autorisation nomme et ce que la base écrit', () => {
    it('tout rôle stockable est un rôle connu', () => {
      for (const role of PERSISTABLE_USER_ROLES) {
        expect(isUserRole(role)).toBe(true);
      }
    });

    it('`PERSISTABLE_USER_ROLES` reflète l’énumération réellement générée par Prisma', () => {
      // Le témoin annoncé par `roles.ts` : le jour où la migration additive
      // `ALTER TYPE "UserRole" ADD VALUE 'MANAGER'` passera, cette assertion
      // rougira — et la correction tiendra en une ligne, déplacer `MANAGER` dans
      // `PERSISTABLE_USER_ROLES`. Sans ce test, le rôle deviendrait stockable
      // pendant que le DTO continuerait de le refuser en 400, sans que rien ne
      // le dise.
      expect([...PERSISTABLE_USER_ROLES].sort()).toEqual([...PRISMA_USER_ROLE_VALUES].sort());
    });

    it('`PERSISTABLE_USER_ROLES` suit l’ordre de déclaration de l’énumération PostgreSQL', () => {
      // Ce n'est pas une coquetterie : PostgreSQL ordonne un `enum` par son ordre
      // de **déclaration**, et c'est cet ordre que rend `orderBy: { role: 'asc' }`
      // dans `listStaffAccounts`. Le double de test trie sur `USER_ROLE_RANK`,
      // qui dérive de `USER_ROLES` ; si les deux ordres divergeaient, le double
      // rendrait une liste que l'endpoint réel ne rend pas, et les assertions
      // d'ordre passeraient au vert sur le mauvais résultat.
      expect(PERSISTABLE_USER_ROLES).toEqual(PRISMA_USER_ROLE_VALUES);

      const ranks = PRISMA_USER_ROLE_VALUES.filter(isUserRole).map((role) => USER_ROLE_RANK[role]);
      expect(ranks).toHaveLength(PRISMA_USER_ROLE_VALUES.length);
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    });

    it('`MANAGER` est aujourd’hui nommable mais pas stockable', () => {
      expect(isUserRole('MANAGER')).toBe(true);
      expect(isPersistableUserRole('MANAGER')).toBe(false);
    });

    it('`PERSISTABLE_STAFF_ROLES` est dérivé, jamais recopié', () => {
      // Une liste écrite à la main qui citerait `MANAGER` ferait échouer le
      // `WHERE role IN (…)` sur la totalité des tenants — PostgreSQL rejette une
      // comparaison à un libellé absent de l'énumération.
      expect(PERSISTABLE_STAFF_ROLES).toEqual(STAFF_ROLES.filter(isPersistableUserRole));
      for (const role of PERSISTABLE_STAFF_ROLES) {
        expect(PRISMA_USER_ROLE_VALUES).toContain(role);
      }
    });
  });
});
