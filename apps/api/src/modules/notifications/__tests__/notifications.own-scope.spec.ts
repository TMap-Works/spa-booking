import { Reflector } from '@nestjs/core';

import type { AuthenticatedUser } from '../../identity/identity.types';
import { PERMISSIONS_METADATA } from '../../identity/permissions.guard';
import type { UserRole } from '../../identity/roles';
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
 * La correction a deux moitiés, et chacune se prouve **là où la décision se
 * prend** :
 *
 * 1. la **porte** — « ce rôle peut-il ouvrir la route ? ». Elle ne dépend de rien
 *    de ce module : c'est la matrice de l'ADR 0013 qui tranche, et le registre
 *    central `identity/__tests__/route-permissions.spec.ts` qui l'exerce rôle par
 *    rôle contre les vraies gardes. La route y figure depuis #1204, et il n'en
 *    reste ici que la relecture de la métadonnée : une distraction qui reposerait
 *    `@AuthAtLeast('STAFF')` la ferait disparaître, et rougirait aux deux
 *    endroits ;
 * 2. la **portée** — `ownScopeOf` traduit cette porte en un critère de recherche,
 *    et c'est le seul endroit du module qui lise un rôle. Elle reste donc ici,
 *    avec le reste du module, et c'est l'objet de cette suite.
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

describe('GET /notifications — la porte', () => {
  /**
   * La seule chose qui reste ici de la porte : que la métadonnée soit **posée**.
   *
   * Ce qu'elle vaut — quel rôle passe, quel rôle se heurte à un `ForbiddenError` —
   * n'est plus exercé dans ce module : le registre central le fait pour toutes les
   * routes à permission d'un seul montage, et le refaire ici en dupliquait le
   * jeton signé, les deux gardes et la boucle sur `USER_ROLES` (#1204).
   *
   * Cette assertion-là, en revanche, ne se déduit pas du registre : son `expected`
   * est une lecture indépendante, si bien qu'une route qui déclarerait la seule
   * `agenda:read:own` y resterait verte — les trois rôles servis la portent tous.
   * C'est la paire exacte que la garde lit et que le document OpenAPI publie, et
   * c'est ce qu'on fige ici, sans monter quoi que ce soit.
   */
  it('exige `agenda:read:own` ou `agenda:read:all`, et plus un rang', () => {
    const declared = new Reflector().get<readonly string[]>(
      PERMISSIONS_METADATA,
      NotificationsController.prototype.list,
    );

    expect(declared).toEqual(['agenda:read:own', 'agenda:read:all']);
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
