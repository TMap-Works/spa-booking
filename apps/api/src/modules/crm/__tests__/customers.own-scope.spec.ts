import type { AuthenticatedUser } from '../../identity/identity.types';
import type { UserRole } from '../../identity/roles';
import type { Customer } from '../crm.types';
import { CustomersController } from '../customers.controller';
import type { CustomersService } from '../customers.service';

/**
 * **La frontière de #812** : qui lit quoi du fichier client.
 *
 * Le module `notifications` prouve depuis #1200 quelle permission large sa
 * route à double portée passe (`notifications.own-scope.spec.ts`) ; `crm`, qui
 * porte pourtant la route d'origine du dispositif, ne le prouvait nulle part.
 * La traduction elle-même est partagée depuis #1205 et couverte par
 * `identity/__tests__/permissions.spec.ts` ; ce qui reste propre à ce module,
 * et qui est l'objet de cette suite, c'est **quelle permission large** chacune
 * des deux routes y passe, et que le critère descende bien jusqu'au service.
 *
 * Sans elle, remplacer `customers:read:all` par `customers:read:own` à l'appel
 * — la permission voisine, celle qu'on a sous les yeux dans l'`@AuthWith` de la
 * même route — laissait tout le reste de la suite verte en rendant les
 * dix-sept fiches du salon à chaque praticien. Le type `BroadPermission` ferme
 * cette porte-là au `tsc` depuis #1205 ; cette suite ferme celle d'un argument
 * qui cesserait d'être passé, ou d'un rôle qui changerait de côté.
 *
 * Ce qu'elle ne couvre pas, délibérément : que le dépôt honore ce critère. Cela
 * se prouve contre une vraie base — `crm.repository.spec.ts` pour le prédicat,
 * `apps/api/test/` pour les suites d'intégration et d'isolation.
 */

/** Une fiche quelconque : seul le chemin compte ici, pas son contenu. */
const FICHE: Customer = {
  id: '0f0d0b1e-0000-4000-8000-000000000000',
  firstName: 'Claire',
  lastName: 'Dubois',
  email: 'claire@lilas.test',
  phone: null,
  isActive: true,
  internalNote: null,
  createdAt: new Date('2026-01-01T09:00:00.000Z'),
  marketingConsent: false,
  marketingConsentAt: null,
  anonymizedAt: null,
  emailSuppressedAt: null,
  emailSuppressionReason: null,
};

/** Le service, réduit aux deux appels que les routes à double portée lui font. */
function buildController(): {
  searchScopes: (string | null)[];
  byIdScopes: (string | null | undefined)[];
  controller: CustomersController;
} {
  const searchScopes: (string | null)[] = [];
  const byIdScopes: (string | null | undefined)[] = [];

  const service = {
    search: (query: { page: number; pageSize: number; ownedByUserId: string | null }) => {
      searchScopes.push(query.ownedByUserId);
      return Promise.resolve({
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        totalItems: 0,
        totalPages: 0,
      });
    },
    byId: (_id: string, ownedByUserId?: string | null) => {
      byIdScopes.push(ownedByUserId);
      return Promise.resolve(FICHE);
    },
  } as unknown as CustomersService;

  // Ni l'historique ni l'export n'interviennent sur ces deux routes : les
  // doubler par `null` rend explicite qu'aucun de leurs chemins n'est exercé.
  const controller = new CustomersController(service, null as never, null as never);

  return { searchScopes, byIdScopes, controller };
}

function actorOf(role: UserRole, userId = 'compte-de-l-appelant'): AuthenticatedUser {
  return { userId, tenantId: 'salon-courant', role };
}

describe('GET /customers — la portée', () => {
  it('borne le praticien à sa propre clientèle', async () => {
    const { searchScopes, controller } = buildController();

    await controller.list(actorOf('STAFF', 'sam'), {});

    expect(searchScopes[0]).toBe('sam');
  });

  it.each<UserRole>(['MANAGER', 'ADMIN'])('ouvre le fichier du salon à %s', async (role) => {
    const { searchScopes, controller } = buildController();

    await controller.list(actorOf(role), {});

    expect(searchScopes[0]).toBeNull();
  });

  it('prend le compte du jeton, jamais un identifiant de la requête', async () => {
    // `ListCustomersQueryDto` ne déclare ni `ownedByUserId` ni `tenantId`, et le
    // `whitelist` global les refuserait ; la seconde barrière est que la portée
    // ne se lit nulle part ailleurs que sur l'appelant.
    const { searchScopes, controller } = buildController();

    await controller.list(actorOf('STAFF', 'sam'), { q: 'dub' });

    expect(searchScopes[0]).toBe('sam');
  });
});

describe('GET /customers/:id — la portée', () => {
  it('borne le praticien à sa propre clientèle', async () => {
    const { byIdScopes, controller } = buildController();

    await controller.byId(actorOf('STAFF', 'sam'), FICHE.id);

    expect(byIdScopes[0]).toBe('sam');
  });

  it.each<UserRole>(['MANAGER', 'ADMIN'])('ouvre toute fiche du salon à %s', async (role) => {
    const { byIdScopes, controller } = buildController();

    await controller.byId(actorOf(role), FICHE.id);

    // `null` et non `undefined` : le défaut du service vaut « tout le fichier »,
    // et un argument oublié y retomberait sans qu'on le voie. C'est bien la
    // route qui décide, à chaque appel.
    expect(byIdScopes[0]).toBeNull();
  });
});
