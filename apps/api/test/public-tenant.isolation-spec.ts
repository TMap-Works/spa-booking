import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppConfigService } from '../src/config/app-config.service';
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { createTenantHarness, TENANT_A, TENANT_B, type TenantHarness } from './utils/tenant-harness';

/**
 * Résolution du tenant sur les pages de réservation publiques (#23) — exercée
 * de bout en bout, en HTTP, sur l'application réellement câblée.
 *
 * L'enjeu est celui d'une **surface ouverte** : ces routes sont servies sans
 * authentification, à qui connaît le slug d'un salon. Trois propriétés y sont
 * vérifiées, et ce sont les trois par lesquelles une fuite passerait :
 *
 * 1. un slug inconnu est refusé **avant le contrôleur** — pas dans un service
 *    qui aurait pu oublier de vérifier ;
 * 2. la portée résolue est bien celle de l'établissement demandé, et d'aucun
 *    autre ;
 * 3. résoudre un établissement n'**ouvre** rien : la vitrine ne rend que du
 *    public, et le back-office reste gardé.
 */

const SALON = TENANT_A.slug;
const BARBIER = TENANT_B.slug;
const FERME = 'salon-ferme';
const SANS_CONTACT = 'salon-sans-contact';

const CHEMIN_PUBLIC = (slug: string): string => `/api/v1/public/${slug}`;

/**
 * Sentinelle posée sur le contrôleur : si elle est appelée, c'est que la requête
 * a traversé le middleware. Le critère « 404 **avant** d'atteindre le
 * contrôleur » ne se prouve pas par le code de statut — un service qui lèverait
 * `NotFoundError` rendrait le même 404 — mais par le fait que rien n'a tourné.
 */
let controleurAtteint = 0;

/**
 * Les deux établissements de référence viennent du harnais partagé (#27) ; cette
 * suite y ajoute les deux cas qui lui sont propres — un salon désactivé, un
 * salon sans coordonnées — et sa sentinelle. Le dépôt est donc préparé **avant**
 * d'être remis au harnais : une sentinelle posée après la compilation du module
 * arriverait après que Nest a résolu le fournisseur.
 */
function prepareIdentity(): FakeIdentityRepository {
  const identity = new FakeIdentityRepository();
  identity.addTenant(FERME, undefined, { isActive: false });
  identity.addTenant(SANS_CONTACT, undefined, { contactEmail: null, contactPhone: null });

  controleurAtteint = 0;
  const surveille = identity.findCurrentPublicTenant.bind(identity);
  identity.findCurrentPublicTenant = async (): ReturnType<
    FakeIdentityRepository['findCurrentPublicTenant']
  > => {
    controleurAtteint += 1;
    return surveille();
  };

  return identity;
}

describe('Isolation inter-tenant — résolution publique du tenant', () => {
  let harness: TenantHarness;

  beforeEach(async () => {
    harness = await createTenantHarness({ identity: prepareIdentity() });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  describe('le slug d’URL résout l’établissement', () => {
    it('sert la vitrine de l’établissement demandé', async () => {
      const response = await request(server()).get(CHEMIN_PUBLIC(SALON)).expect(200);

      expect(response.body.slug).toBe(SALON);
      expect(response.body.id).toBe(harness.a.id);
    });

    it('sert la même vitrine sur un chemin dont la casse diffère', async () => {
      // Express route sans tenir compte de la casse : `/api/v1/PUBLIC/...`
      // atteint ce contrôleur. Si le middleware ne reconnaissait pas le chemin,
      // la portée resterait vide et le repository lèverait
      // `MissingTenantContextError` — un 500 déclenchable de l'extérieur sur une
      // surface non authentifiée.
      const response = await request(server())
        .get(`/api/v1/PUBLIC/${SALON.toUpperCase()}`)
        .expect(200);

      expect(response.body.id).toBe(harness.a.id);
    });

    it('deux slugs servent deux établissements distincts', async () => {
      const salon = await request(server()).get(CHEMIN_PUBLIC(SALON)).expect(200);
      const barbier = await request(server()).get(CHEMIN_PUBLIC(BARBIER)).expect(200);

      expect(salon.body.id).toBe(harness.a.id);
      expect(barbier.body.id).toBe(harness.b.id);
      expect(salon.body.id).not.toBe(barbier.body.id);
      expect(barbier.body.name).toBe('Barbier du Port');
    });
  });

  describe('un slug qui ne résout pas est refusé avant le contrôleur', () => {
    it.each([
      ['slug inconnu', 'salon-qui-nexiste-pas'],
      ['slug mal formé', 'salon_des_lilas'],
      ['tentative de traversée', '..'],
      ['établissement désactivé', FERME],
    ])('%s → 404, contrôleur jamais atteint', async (_cas, slug) => {
      const response = await request(server()).get(CHEMIN_PUBLIC(slug)).expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // Le cœur du critère : aucun code métier n'a tourné.
      expect(controleurAtteint).toBe(0);
    });

    it('rend le même corps pour un slug inconnu et pour un établissement fermé', async () => {
      // Les distinguer dirait à un visiteur qu'un salon a existé, et lequel.
      const inconnu = await request(server()).get(CHEMIN_PUBLIC('jamais-vu')).expect(404);
      const ferme = await request(server()).get(CHEMIN_PUBLIC(FERME)).expect(404);

      expect(inconnu.body).toEqual(ferme.body);
      expect(JSON.stringify(inconnu.body)).not.toContain(FERME);
    });

    it('le corps d’erreur ne renvoie pas le slug soumis', async () => {
      // Le corps d'une erreur sert de miroir à qui sonde des noms.
      const sonde = 'salon-de-la-concurrence';
      const response = await request(server()).get(CHEMIN_PUBLIC(sonde)).expect(404);

      expect(JSON.stringify(response.body)).not.toContain(sonde);
    });
  });

  describe('la vitrine n’expose que ce qui est destiné au public', () => {
    it('rend exactement les champs de la vitrine, et aucun autre', async () => {
      // Égalité de clés, et non `toContain` : un champ interne ajouté par
      // mégarde doit faire échouer ce test.
      const response = await request(server()).get(CHEMIN_PUBLIC(SALON)).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'contactEmail',
        'contactPhone',
        'defaultCurrency',
        'id',
        'name',
        'slug',
        'timezone',
      ]);
      expect(response.body).not.toHaveProperty('isActive');
      expect(response.body).not.toHaveProperty('createdAt');
    });

    it('omet les contacts absents plutôt que de rendre `null`', async () => {
      // `publicTenantSchema` de `@spa/shared` les déclare `.optional()`, et sa
      // suite de tests parse une vitrine dont les deux clés sont **absentes**.
      // Un `null` ici ferait échouer la validation côté front pour tout salon
      // sans coordonnées — le cas le plus courant à l'inscription.
      const response = await request(server()).get(CHEMIN_PUBLIC(SANS_CONTACT)).expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'defaultCurrency',
        'id',
        'name',
        'slug',
        'timezone',
      ]);
      expect(response.body).not.toHaveProperty('contactEmail');
      expect(response.body).not.toHaveProperty('contactPhone');
    });

    it('ne laisse filtrer aucune donnée de compte', async () => {
      await harness.seedUser(harness.a, {
        email: 'alice@example.test',
        password: 'mot-de-passe-du-salon',
        role: 'ADMIN',
      });

      const response = await request(server()).get(CHEMIN_PUBLIC(SALON)).expect(200);
      const corps = JSON.stringify(response.body);

      expect(corps).not.toContain('alice@example.test');
      expect(corps).not.toContain('passwordHash');
      expect(corps).not.toContain('ADMIN');
    });
  });

  describe('un établissement résolu n’ouvre pas ses données internes', () => {
    it.each([
      ['liste des comptes', '/api/v1/users'],
      ['compte authentifié', '/api/v1/auth/me'],
    ])('%s reste gardé même depuis l’espace public résolu', async (_cas, chemin) => {
      // La propriété qui fait tenir tout le reste : le slug **désigne** un
      // établissement, il n'**accorde** rien. Un tenant dans le contexte n'est
      // pas une identité, et le back-office continue d'exiger un jeton.
      await request(server()).get(chemin).expect(401);
    });

    it('une route inconnue de l’espace public ne rend rien, même sur un slug valide', async () => {
      // Le middleware résout l'établissement — c'est bien une route publique —
      // puis le routeur ne trouve pas de gestionnaire. La résolution n'invente
      // aucune surface.
      await request(server()).get(`${CHEMIN_PUBLIC(SALON)}/inexistant`).expect(404);
    });
  });

  describe('le sous-domaine et le slug d’URL doivent s’accorder', () => {
    // `APP_URL` du jeu d'essai fixe le domaine de base ; le sous-domaine n'est
    // lu que sous lui.
    const baseHost = (): string => new URL(harness.app.get(AppConfigService).appUrl).hostname;

    it('un sous-domaine qui contredit le slug d’URL est refusé', async () => {
      const response = await request(server())
        .get(CHEMIN_PUBLIC(BARBIER))
        .set('Host', `${SALON}.${baseHost()}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(controleurAtteint).toBe(0);
    });

    it('un sous-domaine qui s’accorde avec le slug d’URL passe', async () => {
      const response = await request(server())
        .get(CHEMIN_PUBLIC(SALON))
        .set('Host', `${SALON}.${baseHost()}`)
        .expect(200);

      expect(response.body.id).toBe(harness.a.id);
    });

    it('un `Host` arbitraire n’influence pas une route hors de l’espace public', async () => {
      // Un `Host` est fourni par le client : le lire ailleurs que sur l'espace
      // public laisserait un tiers pré-remplir la portée d'autrui.
      await request(server())
        .post('/api/v1/auth/login')
        .set('Host', `${BARBIER}.${baseHost()}`)
        .send({ tenantSlug: SALON, email: 'personne@example.test', password: 'peu-importe-1234' })
        .expect(401);
    });
  });
});
