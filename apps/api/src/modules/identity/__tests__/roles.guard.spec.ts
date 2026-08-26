import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { ForbiddenError } from '../../../common/errors';
import { runInTenantScope } from '../../../common/tenant';
import { Auth, AuthAtLeast } from '../auth.decorator';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { Roles, RolesGuard, ROLES_METADATA } from '../roles.guard';
import { USER_ROLES, type UserRole } from '../roles';
import { TokenService } from '../token.service';
import { fakeConfig, rejectionOf } from './identity.doubles';

/**
 * Garde de permissions — la décision d'accès, rôle par rôle.
 *
 * La suite ne fabrique **pas** l'identité à la main : elle signe un vrai jeton et
 * fait tourner `JwtAuthGuard` avant `RolesGuard`, dans l'ordre où `@Auth(...)`
 * les monte. C'est la seule façon de prouver que la seconde lit bien l'identité
 * que la première a posée — un test qui écrirait `request.user` lui-même
 * validerait un emplacement que la production n'utilise pas.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Sonde annotée à la main, pour exercer `RolesGuard` seule. */
class ProbeController {
  @Roles('STAFF', 'MANAGER', 'ADMIN')
  public staffOnly(): void {
    /* sonde */
  }

  @Roles('ADMIN')
  public adminOnly(): void {
    /* sonde */
  }

  @Roles()
  public annotatedWithoutRole(): void {
    /* sonde */
  }

  public unannotated(): void {
    /* sonde */
  }
}

/** Sonde annotée au niveau de la classe, pour l'arbitrage méthode / contrôleur. */
@Roles('ADMIN')
class AdminScopedController {
  public inherited(): void {
    /* sonde */
  }

  @Roles('STAFF')
  public reopened(): void {
    /* sonde */
  }

  @Roles()
  public annotatedEmpty(): void {
    /* sonde */
  }
}

const tokens = new TokenService(new JwtService(), fakeConfig());
const guard = new RolesGuard(new Reflector());

function contextFor(cls: object, handler: unknown, request: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Le parcours complet d'une requête gardée : jeton signé → `JwtAuthGuard` →
 * `RolesGuard`. Rend `true`, ou lève ce que la garde a levé.
 */
async function authorize(input: {
  role: UserRole;
  cls: object;
  handler: unknown;
}): Promise<boolean> {
  const token = await tokens.signAccessToken({ userId: USER, tenantId: TENANT, role: input.role });
  const request = { headers: { authorization: `Bearer ${token}` } };
  const context = contextFor(input.cls, input.handler, request);

  // La portée est ouverte mais vide, comme le fait `TenantScopeMiddleware` :
  // c'est `JwtAuthGuard` qui la renseigne depuis la revendication signée.
  return runInTenantScope(async () => {
    await new JwtAuthGuard(tokens).canActivate(context);
    return guard.canActivate(context);
  });
}

describe('RolesGuard', () => {
  describe('route réservée aux rôles internes — `@Roles(STAFF, MANAGER, ADMIN)`', () => {
    it.each(['STAFF', 'MANAGER', 'ADMIN'] as const)('laisse passer %s', async (role) => {
      await expect(
        authorize({ role, cls: ProbeController, handler: ProbeController.prototype.staffOnly }),
      ).resolves.toBe(true);
    });

    it('refuse CLIENT', async () => {
      await expect(
        authorize({
          role: 'CLIENT',
          cls: ProbeController,
          handler: ProbeController.prototype.staffOnly,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('route réservée aux administrateurs — `@Roles(ADMIN)`', () => {
    it('laisse passer ADMIN', async () => {
      await expect(
        authorize({ role: 'ADMIN', cls: ProbeController, handler: ProbeController.prototype.adminOnly }),
      ).resolves.toBe(true);
    });

    it.each(['CLIENT', 'STAFF', 'MANAGER'] as const)('refuse %s', async (role) => {
      await expect(
        authorize({ role, cls: ProbeController, handler: ProbeController.prototype.adminOnly }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('sans restriction de rôle', () => {
    it.each([...USER_ROLES])('`@Roles()` laisse passer %s, identité vérifiée exigée', async (role) => {
      await expect(
        authorize({
          role,
          cls: ProbeController,
          handler: ProbeController.prototype.annotatedWithoutRole,
        }),
      ).resolves.toBe(true);
    });

    it.each([...USER_ROLES])('une route non annotée laisse passer %s, mais reste authentifiée', async (role) => {
      await expect(
        authorize({ role, cls: ProbeController, handler: ProbeController.prototype.unannotated }),
      ).resolves.toBe(true);
    });
  });

  describe('arbitrage méthode / contrôleur', () => {
    it('hérite de la déclaration du contrôleur en l’absence de déclaration de méthode', async () => {
      await expect(
        authorize({
          role: 'ADMIN',
          cls: AdminScopedController,
          handler: AdminScopedController.prototype.inherited,
        }),
      ).resolves.toBe(true);
      await expect(
        authorize({
          role: 'MANAGER',
          cls: AdminScopedController,
          handler: AdminScopedController.prototype.inherited,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('la déclaration de méthode l’emporte, y compris pour rouvrir la route', async () => {
      await expect(
        authorize({
          role: 'STAFF',
          cls: AdminScopedController,
          handler: AdminScopedController.prototype.reopened,
        }),
      ).resolves.toBe(true);
    });

    it('une déclaration de méthode **vide** n’élargit pas la restriction de classe', async () => {
      // Le piège que `getAllAndOverride` tendrait : un tableau vide est une
      // valeur définie, il l'emporterait donc sur la liste de la classe et
      // rouvrirait la route à tous les rôles authentifiés — `CLIENT` compris —
      // sans que rien ne le signale à la lecture. Le défaut penche du côté fermé.
      await expect(
        authorize({
          role: 'CLIENT',
          cls: AdminScopedController,
          handler: AdminScopedController.prototype.annotatedEmpty,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        authorize({
          role: 'ADMIN',
          cls: AdminScopedController,
          handler: AdminScopedController.prototype.annotatedEmpty,
        }),
      ).resolves.toBe(true);
    });
  });

  describe('défaut fermé', () => {
    it('répond 401 et non 403 quand aucune identité n’a été posée', () => {
      // `JwtAuthGuard` n'a pas tourné : il n'y a personne à qui refuser un droit.
      const context = contextFor(ProbeController, ProbeController.prototype.staffOnly, {
        headers: {},
      });
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('ce que le refus dit, et ce qu’il tait', () => {
    it('ne cite que les rôles exigés par la route — jamais celui du porteur', async () => {
      const failure = await rejectionOf(
        authorize({
          role: 'CLIENT',
          cls: ProbeController,
          handler: ProbeController.prototype.adminOnly,
        }),
      );

      expect(failure).toBeInstanceOf(ForbiddenError);
      const error = failure as ForbiddenError;
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual({ requiredRoles: ['ADMIN'] });
      // Ni identifiant de compte, ni tenant, ni rôle porté : le premier dirait ce
      // qui existe, le dernier confirmerait au voleur d'un jeton ce qu'il a volé.
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      expect(serialized).not.toContain(USER);
      expect(serialized).not.toContain(TENANT);
      expect(serialized).not.toContain('CLIENT');
    });

    it('rend le même refus quel que soit l’identifiant visé — la garde n’en lit aucun', async () => {
      // C'est ce qui rend la garde compatible avec « 404 et jamais 403 » sur une
      // ressource d'un autre tenant : elle ne consulte aucune ressource, son
      // refus ne peut donc pas en distinguer une.
      const refusal = async (): Promise<ForbiddenError> =>
        (await rejectionOf(
          authorize({
            role: 'STAFF',
            cls: ProbeController,
            handler: ProbeController.prototype.adminOnly,
          }),
        )) as ForbiddenError;

      const first = await refusal();
      const second = await refusal();

      expect(first.message).toBe(second.message);
      expect(first.details).toEqual(second.details);
    });
  });
});

describe('@Auth / @AuthAtLeast — déclaration des rôles', () => {
  const reflector = new Reflector();

  const declaredRolesOf = (decorate: ClassDecorator): readonly UserRole[] | undefined => {
    class Target {}
    decorate(Target);
    return reflector.get<readonly UserRole[] | undefined>(ROLES_METADATA, Target);
  };

  it('`@Auth()` sans argument ouvre à tous les rôles', () => {
    expect(declaredRolesOf(Auth())).toEqual(USER_ROLES);
  });

  it('`@Auth(role…)` déclare exactement les rôles cités', () => {
    expect(declaredRolesOf(Auth('ADMIN'))).toEqual(['ADMIN']);
    expect(declaredRolesOf(Auth('STAFF', 'ADMIN'))).toEqual(['STAFF', 'ADMIN']);
  });

  it('`@AuthAtLeast(seuil)` résout la hiérarchie **à la déclaration**', () => {
    // La garde ne compare que des appartenances à une liste : la hiérarchie est
    // résolue une fois, au montage de la route, pas à chaque requête.
    expect(declaredRolesOf(AuthAtLeast('STAFF'))).toEqual(['STAFF', 'MANAGER', 'ADMIN']);
    expect(declaredRolesOf(AuthAtLeast('ADMIN'))).toEqual(['ADMIN']);
    expect(declaredRolesOf(AuthAtLeast('CLIENT'))).toEqual(USER_ROLES);
  });
});
