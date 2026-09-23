import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { ForbiddenError } from '../../../common/errors';
import { runInTenantScope } from '../../../common/tenant';
import type { AppConfigService } from '../../../config/app-config.service';
import type { AuthenticatedUser } from '../../identity/identity.types';
import { JwtAuthGuard } from '../../identity/jwt-auth.guard';
import { PERMISSIONS_METADATA, PermissionsGuard } from '../../identity/permissions.guard';
import { permissionsOf, roleHasPermission } from '../../identity/permissions';
import { USER_ROLES, type UserRole } from '../../identity/roles';
import { TokenService } from '../../identity/token.service';
import { NotificationsController } from '../notifications.controller';
import type { NotificationsService, NotificationSearch } from '../notifications.service';

/**
 * **La frontière de #1200** : qui lit quoi du journal d'envois.
 *
 * Le constat de la campagne QA `20260922-complet` était qu'un praticien y lisait
 * les 89 lignes de l'établissement, dont 32 rendez-vous de son collègue, avec
 * leurs `appointmentId` et leurs `recipientUserId` — les identifiants mêmes par
 * lesquels le contournement de #1135 a été monté.
 *
 * Cette suite tient les deux moitiés de la correction, et elle les tient **là où
 * la décision se prend** :
 *
 * 1. la **porte** — la route exige `agenda:read:own` ou `agenda:read:all`, et
 *    plus un rang. C'est une métadonnée, et une métadonnée se relit : une
 *    distraction qui reposerait `@AuthAtLeast('STAFF')` rougirait ici ;
 * 2. la **portée** — `ownScopeOf` traduit cette porte en un critère de
 *    recherche, et c'est le seul endroit du module qui lise un rôle.
 *
 * Ce qu'elle ne couvre pas, délibérément : que le dépôt honore ce critère. Cela
 * se prouve contre une vraie base, et c'est l'objet des suites d'intégration et
 * d'isolation de `apps/api/test/`.
 */

/** Le service, réduit à ce que le contrôleur lui demande. */
function stubService(): { searches: NotificationSearch[]; service: NotificationsService } {
  const searches: NotificationSearch[] = [];

  const service = {
    list: (search: NotificationSearch) => {
      searches.push(search);
      return Promise.resolve([]);
    },
  } as unknown as NotificationsService;

  return { searches, service };
}

function buildController(): {
  searches: NotificationSearch[];
  controller: NotificationsController;
} {
  const { searches, service } = stubService();

  const controller = new NotificationsController(
    service,
    // Ni le balayage des rappels ni l'ingestion des rebonds n'interviennent sur
    // cette route : les doubler par `null` rend explicite qu'aucun de leurs
    // chemins n'est exercé ici.
    null as never,
    null as never,
  );

  return { searches, controller };
}

function actorOf(role: UserRole, userId = 'compte-de-l-appelant'): AuthenticatedUser {
  return { userId, tenantId: 'salon-courant', role };
}

/**
 * La configuration minimale dont `TokenService` a besoin pour signer.
 *
 * Écrite ici plutôt qu'empruntée à `identity/__tests__/identity.doubles` : un
 * module ne dépend pas des doubles d'un autre, pas même en test — c'est la même
 * règle de découplage qu'api-module §3 pose sur les repositories, et elle vaut
 * d'autant plus que ces quatre valeurs n'ont aucune raison de changer.
 */
const CONFIG = {
  nodeEnv: 'test',
  isProduction: false,
  jwtSecret: 'unit-test-access-key-not-a-secret-000001',
  jwtRefreshSecret: 'unit-test-refresh-key-not-a-secret-00002',
  jwtExpiresIn: '15m',
  refreshTokenExpiresIn: '7d',
} as AppConfigService;

const tokens = new TokenService(new JwtService(), CONFIG);
const permissions = new PermissionsGuard(new Reflector());

/**
 * Le parcours réel d'une requête gardée : jeton signé → `JwtAuthGuard` →
 * `PermissionsGuard`. Rend `true`, ou lève ce que la garde a levé.
 *
 * Les **vraies** gardes sur le **vrai** contrôleur : un test qui poserait
 * l'identité sur la requête lui-même validerait un emplacement que la production
 * n'utilise pas, et un test qui relirait la métadonnée sans monter la garde
 * validerait une annotation sans sa conséquence.
 *
 * C'est le montage de `identity/__tests__/route-permissions.spec.ts`, refait
 * ici plutôt que cette route ajoutée là-bas : ce ticket n'écrit pas hors de
 * `modules/notifications`, et le registre central relève du module `identity`.
 * L'y rapatrier vaut la peine — c'est l'objet d'une issue de suivi — mais la
 * couverture, elle, n'attend pas.
 */
async function authorize(role: UserRole): Promise<boolean> {
  const token = await tokens.signAccessToken({
    userId: 'compte-de-l-appelant',
    tenantId: '11111111-1111-4111-8111-111111111111',
    role,
  });

  // Une seule et même requête d'un bout à l'autre : `JwtAuthGuard` y dépose
  // l'identité vérifiée, `PermissionsGuard` l'y relit. En fabriquer une par
  // appel ferait perdre l'identité entre les deux gardes, et la seconde
  // refuserait pour une raison qui n'est pas celle qu'on teste.
  const request = { headers: { authorization: `Bearer ${token}` } };

  const context = {
    getHandler: () => NotificationsController.prototype.list,
    getClass: () => NotificationsController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  // La portée est ouverte mais vide, comme le fait `TenantScopeMiddleware` :
  // c'est `JwtAuthGuard` qui la renseigne depuis la revendication signée.
  return runInTenantScope(async () => {
    await new JwtAuthGuard(tokens).canActivate(context);
    return permissions.canActivate(context);
  });
}

describe('GET /notifications — la porte', () => {
  it('exige `agenda:read:own` ou `agenda:read:all`, et plus un rang', () => {
    const declared = new Reflector().get<readonly string[]>(
      PERMISSIONS_METADATA,
      NotificationsController.prototype.list,
    );

    expect(declared).toEqual(['agenda:read:own', 'agenda:read:all']);
  });

  it('s’ouvre à chaque rôle que la matrice sert, et se ferme aux autres', async () => {
    for (const role of USER_ROLES) {
      const granted = permissionsOf(role);
      const shouldPass =
        granted.includes('agenda:read:own') || granted.includes('agenda:read:all');

      if (shouldPass) {
        await expect(authorize(role)).resolves.toBe(true);
      } else {
        // `ForbiddenError` et non `NotFoundError` : la garde ne consulte aucune
        // ressource, son refus porte sur la **route**.
        await expect(authorize(role)).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });

  it('reste fermée à une cliente connectée, qui n’a ni l’une ni l’autre', async () => {
    // Le rang refusait déjà `CLIENT` ; le remplacer par des permissions ne doit
    // pas rouvrir la route par inadvertance.
    expect(roleHasPermission('CLIENT', 'agenda:read:own')).toBe(false);
    expect(roleHasPermission('CLIENT', 'agenda:read:all')).toBe(false);
    await expect(authorize('CLIENT')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reste ouverte au praticien — le comptoir continue de répondre au téléphone', async () => {
    // Le ticket borne ce que `STAFF` lit ; il ne lui ferme pas la porte. Fermer
    // la route à `MANAGER` aurait rendu le journal inaccessible aux personnes
    // qui décrochent, ce que le CDC range dans les gestes de front-desk.
    await expect(authorize('STAFF')).resolves.toBe(true);
  });
});

describe('GET /notifications — la portée', () => {
  it('borne le praticien à ses propres rendez-vous', async () => {
    const { searches, controller } = buildController();

    await controller.list(actorOf('STAFF', 'sam'), {});

    expect(searches[0]?.ownedByUserId).toBe('sam');
  });

  it.each<UserRole>(['MANAGER', 'ADMIN'])('ouvre le journal du salon à %s', async (role) => {
    const { searches, controller } = buildController();

    await controller.list(actorOf(role), {});

    expect(searches[0]?.ownedByUserId).toBeNull();
  });

  it('prend le compte du jeton, jamais un identifiant de la requête', async () => {
    // `ListNotificationsQueryDto` ne déclare ni `recipientUserId` ni `tenantId`,
    // et le `whitelist` global les refuserait ; la seconde barrière est que la
    // portée ne se lit nulle part ailleurs que sur l'appelant.
    const { searches, controller } = buildController();

    await controller.list(actorOf('STAFF', 'sam'), {
      appointmentId: '842db396-0000-4000-8000-000000000000',
    });

    expect(searches[0]).toMatchObject({
      appointmentId: '842db396-0000-4000-8000-000000000000',
      ownedByUserId: 'sam',
    });
  });

  it('ne rend rien de plus quand le praticien vise le rendez-vous d’une collègue', async () => {
    // La réponse est une **liste vide**, pas un 403 : distinguer « ce rendez-vous
    // existe mais n'est pas le vôtre » de « ce rendez-vous n'existe pas » aurait
    // fait de la route un oracle sur l'agenda du salon (ADR 0013).
    const { controller } = buildController();

    const response = await controller.list(actorOf('STAFF', 'sam'), {
      appointmentId: '842db396-0000-4000-8000-000000000000',
    });

    expect(response.items).toEqual([]);
  });
});
