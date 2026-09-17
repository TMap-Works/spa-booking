import { PERMISSIONS, type Permission } from '@spa/shared';

import { ROLE_PERMISSIONS, permissionsOf, roleHasAnyPermission, roleHasPermission } from '../permissions';
import { USER_ROLES, type UserRole } from '../roles';

/**
 * La matrice de permissions — **la table de l'ADR 0013, rendue exécutable**
 * (#812, premier critère).
 *
 * Ce que cette suite protège : que la matrice dise ce que l'arbitrage du PO du
 * 16/09 a tranché, et qu'elle continue de le dire. Une case retournée par
 * distraction — `agenda:read:all` glissée dans la ligne `STAFF` — rouvrirait
 * d'un coup le planning du salon à la praticienne, sans qu'aucune route ne
 * change de décorateur et sans qu'aucun autre test ne rougisse.
 *
 * Elle est **redondante avec le fichier**, et c'est le propos : une table de
 * droits est la seule sorte de code qu'on relit sans la comprendre, parce qu'une
 * ligne de plus y ressemble à toutes les autres.
 */

/**
 * La matrice attendue, **réécrite à la main** plutôt qu'importée.
 *
 * Importer `ROLE_PERMISSIONS` pour le comparer à lui-même n'aurait rien prouvé.
 * Ce tableau est la lecture indépendante de la table de l'ADR, et l'écart entre
 * les deux est exactement ce qu'on cherche à voir.
 */
const EXPECTED: Readonly<Record<UserRole, readonly Permission[]>> = {
  CLIENT: [],
  STAFF: ['agenda:read:own', 'appointment:write:own', 'customers:read:own'],
  MANAGER: [
    'agenda:read:own',
    'agenda:read:all',
    'appointment:write:own',
    'appointment:write:all',
    'customers:read:own',
    'customers:read:all',
    'customers:write',
    'accounts:read',
    'checkout:collect',
    'reporting:read',
  ],
  ADMIN: [
    'agenda:read:own',
    'agenda:read:all',
    'appointment:write:own',
    'appointment:write:all',
    'customers:read:own',
    'customers:read:all',
    'customers:write',
    'accounts:read',
    'accounts:write',
    'checkout:collect',
    'reporting:read',
    'settings:write',
  ],
};

describe('matrice de permissions — la table de l’ADR 0013', () => {
  it.each([...USER_ROLES])('accorde à %s exactement ce que la table annonce', (role) => {
    expect([...permissionsOf(role)].sort()).toEqual([...EXPECTED[role]].sort());
  });

  it('n’accorde rien au rôle CLIENT — la ligne existe et elle est vide', () => {
    // Vide et non absente : la garde doit lire un tableau, pas un `undefined`
    // qu'un `?? []` distrait aurait pu retourner en « aucune exigence ».
    expect(permissionsOf('CLIENT')).toEqual([]);
    expect(ROLE_PERMISSIONS.CLIENT).toBeDefined();
  });

  it('rend les permissions dans l’ordre du vocabulaire, quel que soit le rôle', () => {
    // La liste part sur le fil par `GET /auth/me` : deux réponses qui
    // énuméreraient les mêmes droits dans deux ordres différents produiraient des
    // corps distincts pour un même état.
    for (const role of USER_ROLES) {
      const ranks = permissionsOf(role).map((permission) => PERMISSIONS.indexOf(permission));
      expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    }
  });

  it('n’accorde aucune permission inconnue du vocabulaire', () => {
    for (const role of USER_ROLES) {
      for (const permission of permissionsOf(role)) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('gèle ce qu’elle rend — une liste modifiée sur place vaudrait pour tout le processus', () => {
    expect(Object.isFrozen(permissionsOf('ADMIN'))).toBe(true);
  });
});

describe('ce que l’arbitrage du PO du 16/09 impose, permission par permission', () => {
  it('le praticien lit son agenda et jamais celui du salon', () => {
    expect(roleHasPermission('STAFF', 'agenda:read:own')).toBe(true);
    expect(roleHasPermission('STAFF', 'agenda:read:all')).toBe(false);
  });

  it('le praticien agit sur ses rendez-vous et jamais sur ceux d’une collègue', () => {
    expect(roleHasPermission('STAFF', 'appointment:write:own')).toBe(true);
    expect(roleHasPermission('STAFF', 'appointment:write:all')).toBe(false);
  });

  it('le praticien lit ses clientes et jamais le fichier du salon', () => {
    expect(roleHasPermission('STAFF', 'customers:read:own')).toBe(true);
    expect(roleHasPermission('STAFF', 'customers:read:all')).toBe(false);
    expect(roleHasPermission('STAFF', 'customers:write')).toBe(false);
  });

  it('le praticien ne lit pas l’annuaire des comptes', () => {
    expect(roleHasPermission('STAFF', 'accounts:read')).toBe(false);
  });

  it('le praticien n’encaisse pas — l’écran liste la journée de tout le salon', () => {
    expect(roleHasPermission('STAFF', 'checkout:collect')).toBe(false);
  });

  it('le gérant garde tout ce que #812 retire au praticien', () => {
    // Le ticket referme une porte, il n'en referme pas deux : le comptoir doit
    // continuer de fonctionner exactement comme avant.
    for (const permission of [
      'agenda:read:all',
      'appointment:write:all',
      'customers:read:all',
      'customers:write',
      'accounts:read',
      'checkout:collect',
    ] as const) {
      expect(roleHasPermission('MANAGER', permission)).toBe(true);
    }
  });

  it('l’administration des comptes et les réglages restent au rang le plus élevé', () => {
    expect(roleHasPermission('MANAGER', 'accounts:write')).toBe(false);
    expect(roleHasPermission('MANAGER', 'settings:write')).toBe(false);
    expect(roleHasPermission('ADMIN', 'accounts:write')).toBe(true);
    expect(roleHasPermission('ADMIN', 'settings:write')).toBe(true);
  });

  it('l’administratrice porte tout le vocabulaire — il n’y a rien au-dessus d’elle', () => {
    expect([...permissionsOf('ADMIN')]).toEqual([...PERMISSIONS]);
  });
});

describe('roleHasAnyPermission — « l’une d’elles », jamais « toutes »', () => {
  it('ouvre une route à double portée au praticien comme au gérant', () => {
    const lecture = ['customers:read:own', 'customers:read:all'] as const;

    expect(roleHasAnyPermission('STAFF', lecture)).toBe(true);
    expect(roleHasAnyPermission('MANAGER', lecture)).toBe(true);
    expect(roleHasAnyPermission('CLIENT', lecture)).toBe(false);
  });

  it('refuse sur une liste vide — aucune exigence satisfaite n’est pas une exigence absente', () => {
    // La garde traite « aucune métadonnée » ailleurs, et volontairement : ici,
    // une liste vide qui rendrait `true` aurait fait d'un `@AuthWith()` distrait
    // une route ouverte à tous.
    expect(roleHasAnyPermission('ADMIN', [])).toBe(false);
  });
});
