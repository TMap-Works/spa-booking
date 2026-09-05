import request from 'supertest';

import {
  createAvailabilityEndpointHarness,
  servedDay,
  type AvailabilityEndpointHarness,
  type ServedTenant,
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

  /**
   * `excludeAppointmentId` — la frontière du paramètre ouvert par #442.
   *
   * C'est le quatrième critère du ticket : « si la route publique est retenue,
   * un identifiant d'un autre établissement reste sans effet, et un test
   * d'isolation le prouve sur l'endpoint ». Elle a été retenue — voir le README
   * du module —, et voici la preuve.
   *
   * Le risque nommé est celui d'une exclusion appliquée **avant** le filtre de
   * tenant : un appelant nommerait alors un rendez-vous du voisin et le verrait
   * disparaître de… rien du tout, puisque le calendrier interrogé n'est pas le
   * sien. Ce qui se prouve donc ici est la propriété utile : nommer
   * l'identifiant d'ailleurs **ne retire rien**, là où nommer le sien retire
   * exactement une chose.
   */
  describe('excludeAppointmentId (#442)', () => {
    const BUFFER_BEFORE_MS = 10 * 60_000;
    const OCCUPIED_MS = 80 * 60_000;

    const publicSlots = async (
      tenant: ServedTenant,
      overrides: Record<string, string> = {},
    ): Promise<string[]> => {
      const response = await request(harness.server())
        .get(PUBLIC_PATH(tenant.tenant.slug))
        .query({ ...range(tenant.serviceId), ...overrides })
        .expect(200);

      return (response.body.days as { slots: { startsAt: string }[] }[]).flatMap((day) =>
        day.slots.map((slot) => slot.startsAt),
      );
    };

    /** Occupe le créneau de mi-journée de cet établissement, et rend son identifiant. */
    const occupy = async (
      tenant: ServedTenant,
    ): Promise<{ id: string; billedStart: string }> => {
      const times = await publicSlots(tenant);
      const billedStart = times[Math.floor(times.length / 2)] as string;
      const occupiedStart = new Date(Date.parse(billedStart) - BUFFER_BEFORE_MS);

      const appointment = harness.availability.seedAppointment({
        tenantId: tenant.tenant.id,
        staffId: tenant.staffId,
        startsAt: occupiedStart,
        endsAt: new Date(occupiedStart.getTime() + OCCUPIED_MS),
      });

      // Le jeu d'essai est posé dans le double, pas par HTTP : rien n'a chassé
      // le cache, et on le vide pour que la question suivante soit recalculée.
      harness.cache.entries.clear();

      return { id: appointment.id, billedStart };
    };

    it('un identifiant du voisin ne retire rien du calendrier', async () => {
      const mine = await occupy(harness.a);
      const theirs = await occupy(harness.b);

      const withNeighbour = await publicSlots(harness.a, { excludeAppointmentId: theirs.id });

      // La lecture des rendez-vous est scopée, et `id: { not: … }` s'applique
      // après le filtre de tenant : l'identifiant d'ailleurs ne désigne rien
      // d'ici, et le créneau reste pris.
      expect(withNeighbour).not.toContain(mine.billedStart);
    });

    it('le sien, en revanche, retire exactement le sien', async () => {
      const mine = await occupy(harness.a);

      expect(await publicSlots(harness.a, { excludeAppointmentId: mine.id })).toContain(
        mine.billedStart,
      );
    });

    it('rend la même réponse pour « inconnu » et « connu chez le voisin »', async () => {
      await occupy(harness.a);
      const theirs = await occupy(harness.b);

      // La différence entre les deux est précisément l'information à ne pas
      // donner : sans cela, le paramètre devient une sonde d'existence de
      // rendez-vous (tenant-isolation §4).
      const neighbour = await publicSlots(harness.a, { excludeAppointmentId: theirs.id });
      const nowhere = await publicSlots(harness.a, { excludeAppointmentId: UNKNOWN_ID });

      expect(neighbour).toEqual(nowhere);
    });

    it('ne laisse derrière elle aucune clé de cache, pour aucun des deux', async () => {
      const mine = await occupy(harness.a);

      await publicSlots(harness.a, { excludeAppointmentId: mine.id });

      // Une vue calculée avec une exclusion rangée sous une clé qui n'en dit
      // rien serait servie à tous les lecteurs suivants du même établissement —
      // une fuite qui ne traverse aucune frontière de tenant, mais qui montre à
      // chacun un créneau qu'un autre occupe.
      expect(harness.cache.keysOf(harness.a.tenant.id)).toEqual([]);
      expect(harness.cache.keysOf(harness.b.tenant.id)).toEqual([]);
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
