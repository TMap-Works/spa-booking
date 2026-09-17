import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Permission } from '@spa/shared';

import { ForbiddenError } from '../../../common/errors';
import { runInTenantScope } from '../../../common/tenant';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { MyStaffController } from '../../appointments/my-staff.controller';
import { CustomersController } from '../../crm/customers.controller';
import { CounterPaymentsController } from '../../payments/counter-payments.controller';
import { ProductsController } from '../../payments/products.controller';
import { SalesController } from '../../payments/sales.controller';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { PermissionsGuard } from '../permissions.guard';
import { permissionsOf } from '../permissions';
import { USER_ROLES, type UserRole } from '../roles';
import { TokenService } from '../token.service';
import { UsersController } from '../users.controller';
import { fakeConfig } from './identity.doubles';

/**
 * **Chaque rôle sur chaque route modifiée** — le sixième critère de #812.
 *
 * ## Ce que cette suite exerce, et pourquoi elle ne se contente pas de la matrice
 *
 * `permissions.spec.ts` prouve que la table dit la bonne chose. Il reste à
 * prouver que les **routes** la consultent — qu'aucune n'est restée derrière son
 * ancien `@AuthAtLeast('STAFF')`, et qu'aucune n'annonce une permission qu'elle
 * n'exige pas. Ce sont deux défauts distincts, et le second est silencieux : un
 * décorateur oublié compile, passe ses tests de service, et rend 200 à qui ne
 * devrait rien lire. C'est exactement ce que le retour de test du PO du 16/09 a
 * trouvé à la main.
 *
 * La suite monte donc les **vraies gardes** sur les **vrais contrôleurs**, avec
 * un vrai jeton signé — `JwtAuthGuard` puis `PermissionsGuard`, dans l'ordre où
 * `@AuthWith(...)` les pose. Un test qui écrirait `request.user` lui-même
 * validerait un emplacement que la production n'utilise pas ; un test qui
 * relirait les métadonnées sans les gardes validerait une annotation sans sa
 * conséquence.
 *
 * ## Ce qu'elle ne couvre pas, et qui est ailleurs
 *
 * La **portée** — « ce rendez-vous est-il le vôtre ? ». Elle ne se décide pas à
 * la porte, puisqu'il faut lire la ressource : c'est
 * `appointments.service.spec.ts` et `customers.service.spec.ts` qui la tiennent,
 * et le refus y est `OWN_SCOPE_ONLY`, pas `FORBIDDEN`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const tokens = new TokenService(new JwtService(), fakeConfig());
const guard = new PermissionsGuard(new Reflector());

/**
 * Une route à vérifier : où elle vit, et ce qu'elle doit exiger.
 *
 * `expected` est réécrit à la main plutôt que relu du décorateur — c'est la
 * lecture indépendante qui donne sa valeur à la comparaison.
 */
interface GuardedRoute {
  readonly label: string;
  readonly cls: new (...args: never[]) => object;
  readonly handler: unknown;
  readonly expected: readonly Permission[];
}

const ROUTES: readonly GuardedRoute[] = [
  {
    label: 'GET /v1/appointments — l’agenda du salon',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.list,
    expected: ['agenda:read:all'],
  },
  {
    label: 'GET /v1/appointments/reference/:reference',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.byReference,
    expected: ['agenda:read:all'],
  },
  {
    label: 'POST /v1/appointments — poser au comptoir',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.create,
    expected: ['appointment:write:all'],
  },
  {
    label: 'POST /v1/appointments/:id/reschedule',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.reschedule,
    expected: ['appointment:write:own', 'appointment:write:all'],
  },
  {
    label: 'POST /v1/appointments/:id/status',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.changeStatus,
    expected: ['appointment:write:own', 'appointment:write:all'],
  },
  {
    label: 'POST /v1/appointments/:id/cancel',
    cls: AppointmentsController,
    handler: AppointmentsController.prototype.cancel,
    expected: ['appointment:write:own', 'appointment:write:all'],
  },
  {
    label: 'GET /v1/me/appointments — l’agenda du praticien (#811)',
    cls: MyStaffController,
    handler: MyStaffController.prototype.appointments,
    expected: ['agenda:read:own'],
  },
  {
    label: 'GET /v1/users — l’annuaire des comptes',
    cls: UsersController,
    handler: UsersController.prototype.list,
    expected: ['accounts:read'],
  },
  {
    label: 'GET /v1/users/:id',
    cls: UsersController,
    handler: UsersController.prototype.byId,
    expected: ['accounts:read'],
  },
  {
    label: 'GET /v1/customers — le fichier client',
    cls: CustomersController,
    handler: CustomersController.prototype.list,
    expected: ['customers:read:own', 'customers:read:all'],
  },
  {
    label: 'GET /v1/customers/:id',
    cls: CustomersController,
    handler: CustomersController.prototype.byId,
    expected: ['customers:read:own', 'customers:read:all'],
  },
  {
    label: 'GET /v1/customers/:id/history',
    cls: CustomersController,
    handler: CustomersController.prototype.historyOf,
    expected: ['customers:read:all'],
  },
  {
    label: 'GET /v1/customers/:id/export',
    cls: CustomersController,
    handler: CustomersController.prototype.exportOf,
    expected: ['customers:read:all'],
  },
  {
    label: 'POST /v1/customers',
    cls: CustomersController,
    handler: CustomersController.prototype.create,
    expected: ['customers:write'],
  },
  {
    label: 'PATCH /v1/customers/:id',
    cls: CustomersController,
    handler: CustomersController.prototype.update,
    expected: ['customers:write'],
  },
  {
    label: 'PATCH /v1/customers/:id/status',
    cls: CustomersController,
    handler: CustomersController.prototype.setStatus,
    expected: ['customers:write'],
  },
  {
    label: 'POST /v1/payments/cash — l’encaissement au comptoir',
    cls: CounterPaymentsController,
    handler: CounterPaymentsController.prototype.settleInCash,
    expected: ['checkout:collect'],
  },
  {
    label: 'GET /v1/payments — le rapprochement de caisse',
    cls: CounterPaymentsController,
    handler: CounterPaymentsController.prototype.list,
    expected: ['checkout:collect'],
  },
  {
    label: 'POST /v1/payments/:paymentId/refunds',
    cls: CounterPaymentsController,
    handler: CounterPaymentsController.prototype.refund,
    expected: ['checkout:collect'],
  },
  {
    label: 'POST /v1/sales — composer un ticket',
    cls: SalesController,
    handler: SalesController.prototype.open,
    expected: ['checkout:collect'],
  },
  {
    label: 'GET /v1/sales — les tickets de caisse',
    cls: SalesController,
    handler: SalesController.prototype.history,
    expected: ['checkout:collect'],
  },
  {
    label: 'GET /v1/sales/:id',
    cls: SalesController,
    handler: SalesController.prototype.byId,
    expected: ['checkout:collect'],
  },
  {
    label: 'POST /v1/sales/:saleId/payments',
    cls: SalesController,
    handler: SalesController.prototype.settle,
    expected: ['checkout:collect'],
  },
  {
    label: 'GET /v1/products — le rayon',
    cls: ProductsController,
    handler: ProductsController.prototype.list,
    expected: ['checkout:collect'],
  },
  {
    label: 'POST /v1/products',
    cls: ProductsController,
    handler: ProductsController.prototype.create,
    expected: ['checkout:collect'],
  },
  {
    label: 'PATCH /v1/products/:id',
    cls: ProductsController,
    handler: ProductsController.prototype.update,
    expected: ['checkout:collect'],
  },
];

function contextFor(cls: object, handler: unknown, request: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * Le parcours d'une requête gardée : jeton signé → `JwtAuthGuard` →
 * `PermissionsGuard`. Rend `true`, ou lève ce que la garde a levé.
 */
async function authorize(role: UserRole, route: GuardedRoute): Promise<boolean> {
  const token = await tokens.signAccessToken({ userId: USER, tenantId: TENANT, role });
  const context = contextFor(route.cls, route.handler, {
    headers: { authorization: `Bearer ${token}` },
  });

  // La portée est ouverte mais vide, comme le fait `TenantScopeMiddleware` :
  // c'est `JwtAuthGuard` qui la renseigne depuis la revendication signée.
  return runInTenantScope(async () => {
    await new JwtAuthGuard(tokens).canActivate(context);
    return guard.canActivate(context);
  });
}

describe('les routes exigent la permission que la table leur attribue', () => {
  it.each(ROUTES.map((route) => [route.label, route] as const))(
    '%s',
    async (_label, route) => {
      for (const role of USER_ROLES) {
        const granted = permissionsOf(role);
        const shouldPass = route.expected.some((permission) => granted.includes(permission));

        if (shouldPass) {
          await expect(authorize(role, route)).resolves.toBe(true);
        } else {
          // `ForbiddenError` et non `NotFoundError` : la garde ne consulte
          // aucune ressource, son refus porte sur la **route**, et il est donc
          // identique pour un identifiant du tenant courant, un identifiant du
          // voisin et un identifiant qui n'existe nulle part.
          await expect(authorize(role, route)).rejects.toBeInstanceOf(ForbiddenError);
        }
      }
    },
  );
});

describe('ce que le retour de test du PO du 16/09 avait trouvé ouvert', () => {
  /** Les quatre portes que la praticienne poussait, et qui doivent se refermer. */
  const CLOSED_TO_STAFF = ROUTES.filter((route) =>
    [
      'GET /v1/appointments — l’agenda du salon',
      'GET /v1/users — l’annuaire des comptes',
      'POST /v1/payments/cash — l’encaissement au comptoir',
      'POST /v1/customers',
    ].includes(route.label),
  );

  it('les referme toutes au rang STAFF', async () => {
    expect(CLOSED_TO_STAFF).toHaveLength(4);

    for (const route of CLOSED_TO_STAFF) {
      await expect(authorize('STAFF', route)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('les laisse ouvertes au rang MANAGER — le comptoir continue de fonctionner', async () => {
    for (const route of CLOSED_TO_STAFF) {
      await expect(authorize('MANAGER', route)).resolves.toBe(true);
    }
  });

  it('n’ouvre rien au rôle CLIENT, sur aucune des routes du périmètre', async () => {
    for (const route of ROUTES) {
      await expect(authorize('CLIENT', route)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
