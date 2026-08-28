import request from 'supertest';

import {
  createAvailabilityEndpointHarness,
  servedDay,
  type AvailabilityEndpointHarness,
} from './availability-endpoint.harness';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * Isolation inter-tenant de l'endpoint de disponibilité et de son cache — #35,
 * DoD « test d'isolation inter-tenant pour tout endpoint nouveau ou modifié ».
 *
 * Le protocole est celui de tenant-isolation §6 : semer chez A, s'authentifier
 * comme B, tenter la lecture par identifiant, attendre **404** — jamais 403, qui
 * confirmerait l'existence de la ressource — et vérifier que la donnée de A est
 * intacte.
 *
 * ## Ce que ce ticket ajoute au protocole : la frontière du cache
 *
 * Un cache est une seconde source de vérité, et donc un second endroit où
 * l'isolation peut céder — d'une façon que le protocole habituel ne verrait pas.
 * Deux établissements peuvent poser la même question (« les créneaux du service
 * X, le 3 mars ») ; si la clé ne les distingue pas, le second reçoit la réponse
 * du premier, **sans qu'aucune requête n'ait traversé de frontière**. C'est une
 * fuite qui ne se lit ni dans un contrôleur, ni dans un repository, ni dans un
 * filtre `tenant_id` : elle est dans une chaîne de caractères.
 *
 * Trois propriétés couvrent cela, et elles sont vérifiées ici :
 *
 * | Propriété | Ce qu'elle empêche |
 * |---|---|
 * | la clé commence par le tenant | qu'une réponse serve deux établissements |
 * | l'invalidation ne porte que le préfixe du tenant courant | qu'un salon chasse le cache d'un autre |
 * | la lecture prend le tenant du contexte, jamais d'un argument | qu'un appelant sonde le cache du voisin |
 */

const BACK_OFFICE_PATH = '/api/v1/availability';
const CLOSING_DAYS_PATH = '/api/v1/closing-days';
const PUBLIC_PATH = (slug: string): string => `/api/v1/public/${slug}/availability`;

describe('Isolation inter-tenant — endpoint de disponibilité (#35)', () => {
  let harness: AvailabilityEndpointHarness;
  let day: string;

  beforeEach(async () => {
    harness = await createAvailabilityEndpointHarness();
    day = servedDay();
  });

  afterEach(async () => {
    await harness.close();
  });

  const range = (serviceId: string): Record<string, string> => ({
    serviceId,
    from: day,
    to: day,
  });

  describe('route gardée', () => {
    it('répond 404 sur la prestation du voisin — jamais 403, jamais la donnée', async () => {
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF', harness.b.tenant))
        .query(range(harness.a.serviceId))
        .expect(404);

      expect(response.body).not.toContain(harness.a.staffId);
    });

    it('rend la même réponse pour « inconnu » et « connu ailleurs »', async () => {
      // La différence entre les deux est précisément l'information à ne pas
      // donner : sans cela, la route devient une sonde d'existence (§4).
      const bearer = await harness.bearer('STAFF', harness.b.tenant);

      const neighbour = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', bearer)
        .query(range(harness.a.serviceId))
        .expect(404);

      const nowhere = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', bearer)
        .query(range(UNKNOWN_ID))
        .expect(404);

      expect(neighbour.body).toEqual(nowhere.body);
    });

    it('ne propose jamais un praticien du voisin', async () => {
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF', harness.b.tenant))
        .query({ ...range(harness.b.serviceId), staffId: harness.a.staffId })
        .expect(200);

      // Réponse vide, et non 404 : « ce praticien n'existe pas », « il est chez
      // le voisin » et « il ne pratique pas ce soin » doivent être
      // indiscernables.
      expect(response.body.days).toEqual([{ date: day, slots: [] }]);
    });
  });

  describe('route publique', () => {
    it('répond 404 quand le slug et la prestation ne désignent pas le même salon', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.b.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(404);
    });

    it('sert à chacun son établissement, sur la même question', async () => {
      const first = await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(200);

      const second = await request(harness.server())
        .get(PUBLIC_PATH(harness.b.tenant.slug))
        .query(range(harness.b.serviceId))
        .expect(200);

      expect(first.body.days[0].slots[0].staffId).toBe(harness.a.staffId);
      expect(second.body.days[0].slots[0].staffId).toBe(harness.b.staffId);
    });
  });

  describe('cache', () => {
    it('range les deux établissements sous des clés disjointes', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(200);
      await request(harness.server())
        .get(PUBLIC_PATH(harness.b.tenant.slug))
        .query(range(harness.b.serviceId))
        .expect(200);

      expect(harness.cache.keysOf(harness.a.tenant.id)).toHaveLength(1);
      expect(harness.cache.keysOf(harness.b.tenant.id)).toHaveLength(1);
      // Aucune clé ne porte les deux établissements : la preuve que le tenant
      // est bien en tête et non ailleurs dans la chaîne.
      for (const key of harness.cache.entries.keys()) {
        expect(
          key.includes(harness.a.tenant.id) && key.includes(harness.b.tenant.id),
        ).toBe(false);
      }
    });

    it('n’écrit aucune clé pour un établissement qui n’a rien demandé', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(200);

      expect(harness.cache.keysOf(harness.b.tenant.id)).toEqual([]);
    });

    it('une écriture chez le voisin ne chasse pas le cache de l’établissement', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(200);

      // Un vrai chemin d'écriture d'agenda, par HTTP, chez B.
      await request(harness.server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER', harness.b.tenant))
        .send({ weekdays: [3] })
        .expect(200);

      // Le calendrier de A n'a aucune raison d'être recalculé parce que son
      // voisin a fermé le mercredi. L'inverse ferait de chaque écriture d'un
      // salon une invalidation pour tous les autres.
      expect(harness.cache.keysOf(harness.a.tenant.id)).toHaveLength(1);
    });

    it('une écriture chez soi chasse bien son propre cache', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(range(harness.a.serviceId))
        .expect(200);

      expect(harness.cache.keysOf(harness.a.tenant.id)).toHaveLength(1);

      await request(harness.server())
        .put(CLOSING_DAYS_PATH)
        .set('Authorization', await harness.bearer('MANAGER', harness.a.tenant))
        .send({ weekdays: [3] })
        .expect(200);

      // Le témoin du troisième critère de #35, bout en bout : une écriture
      // d'agenda passée par HTTP a réellement vidé l'espace de clés du tenant.
      expect(harness.cache.keysOf(harness.a.tenant.id)).toEqual([]);
    });
  });
});
