import { UserRole as PrismaUserRole } from '@prisma/client';

// Le SQL de migration est lu par un module unique, partagé avec
// `prisma-schema.spec.ts` (#217). L'import traverse les dossiers, mais il ne
// franchit aucune frontière de module métier au sens d'api-module §3 :
// `infrastructure/database` est le seul endroit du dépôt qui connaisse le
// schéma, et ce lecteur n'existe que pour les suites de test.
import { readMigrationSql } from '../../../infrastructure/database/__tests__/migration-sql';
import {
  hasAtLeastRole,
  isStaffRole,
  isUserRole,
  rolesAtLeast,
  STAFF_ROLES,
  USER_ROLE_RANK,
  USER_ROLES,
} from '../roles';

/**
 * L'énumération telle que Prisma la génère — le témoin que le vocabulaire
 * d'autorisation et la colonne disent bien la même chose.
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

  describe('concordance entre ce que l’autorisation nomme et ce que la colonne écrit', () => {
    it('`USER_ROLES` est exactement l’énumération générée par Prisma, dans le même ordre', () => {
      // Le garde-fou hérité de #202 : le module a porté deux listes tant que
      // `enum UserRole` ignorait `MANAGER`, le temps que le DTO refuse en 400 un
      // rôle qui aurait produit une erreur Prisma en 500. La migration
      // `20260826100000_add_manager_user_role` a refermé l'écart ; ce test est ce
      // qui interdit qu'il se rouvre en silence. Un cinquième rôle ajouté à
      // l'autorisation sans sa migration rougit ici, et non à la première
      // écriture en production.
      //
      // L'ordre compte autant que le contenu : PostgreSQL ordonne un `enum` par
      // son ordre de déclaration, et c'est lui que rend `orderBy: { role: 'asc' }`
      // dans `listStaffAccounts`. Le double de test trie sur `USER_ROLE_RANK`,
      // qui dérive de `USER_ROLES` ; si les deux ordres divergeaient, le double
      // rendrait une liste que l'endpoint réel ne rend pas, et les assertions
      // d'ordre passeraient au vert sur le mauvais résultat.
      expect(USER_ROLES).toEqual(PRISMA_USER_ROLE_VALUES);
    });

    it('déclare `MANAGER` avant `ADMIN` dans le type PostgreSQL lui-même', () => {
      // `PRISMA_USER_ROLE_VALUES` vient de `schema.prisma` : il ne prouve que
      // l'ordre du client généré. L'ordre du type en base se joue dans le SQL —
      // un `ADD VALUE` sans voisin aurait placé `MANAGER` en queue, donc trié
      // *après* `ADMIN`, et la liste du personnel serait sortie dans un ordre
      // contredisant la hiérarchie sans qu'aucune assertion sur le double ne
      // puisse le voir.
      const sql = readMigrationSql();
      expect(sql).toMatch(/ADD VALUE (?:IF NOT EXISTS )?'MANAGER' BEFORE 'ADMIN'/);
    });

    it('`STAFF_ROLES` ne cite que des libellés que la colonne connaît', () => {
      // Un rôle cité dans un `WHERE role IN (…)` sans exister dans l'énumération
      // ferait échouer la requête — `invalid input value for enum "UserRole"` —
      // sur la totalité des tenants, en lecture comme en écriture.
      for (const role of STAFF_ROLES) {
        expect(PRISMA_USER_ROLE_VALUES).toContain(role);
      }
    });

    it('`MANAGER` est nommable *et* stockable', () => {
      // Le critère d'acceptation de #202, réduit à son noyau vérifiable sans
      // base : la garde le nomme, l'énumération générée le contient.
      expect(isUserRole('MANAGER')).toBe(true);
      expect(PRISMA_USER_ROLE_VALUES).toContain('MANAGER');
    });
  });
});
