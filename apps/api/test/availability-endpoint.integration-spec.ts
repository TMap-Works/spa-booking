import request from 'supertest';

import {
  createAvailabilityEndpointHarness,
  servedDay,
  type AvailabilityEndpointHarness,
} from './availability-endpoint.harness';
import { UNKNOWN_ID } from './utils/tenant-harness';

/**
 * `GET /api/v1/availability` et sa jumelle publique — #35, premier critère.
 *
 * Ce que cette suite prouve et que les tests unitaires ne peuvent pas prouver :
 * que ces deux routes sont **servies**. Un contrôleur oublié dans les
 * `controllers` de son module compile, passe ses tests unitaires, et rend 404 en
 * vrai. C'est le seul défaut que cette suite existe pour attraper, avec le
 * comportement des gardes et du `ValidationPipe` global, qui ne s'exercent qu'en
 * HTTP.
 *
 * L'isolation inter-tenant a sa propre suite —
 * `availability-endpoint.isolation-spec.ts` —, comme l'exige la DoD du ticket.
 */

const BACK_OFFICE_PATH = '/api/v1/availability';
const PUBLIC_PATH = (slug: string): string => `/api/v1/public/${slug}/availability`;

describe('Endpoint de disponibilité', () => {
  let harness: AvailabilityEndpointHarness;
  let day: string;

  beforeEach(async () => {
    harness = await createAvailabilityEndpointHarness();
    day = servedDay();
  });

  afterEach(async () => {
    await harness.close();
  });

  const query = (overrides: Record<string, string> = {}): Record<string, string> => ({
    serviceId: harness.a.serviceId,
    from: day,
    to: day,
    ...overrides,
  });

  describe('back-office', () => {
    it('rend les créneaux de la journée, avec le fuseau de l’établissement', async () => {
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query())
        .expect(200);

      expect(response.body).toMatchObject({
        serviceId: harness.a.serviceId,
        timezone: 'UTC',
      });
      expect(response.body.days).toHaveLength(1);
      expect(response.body.days[0].date).toBe(day);
      // Neuf heures d'ouverture, un soin de quatre-vingts minutes occupées, un
      // pas de quinze : la journée n'est pas vide, et c'est tout ce qui compte
      // ici — le compte exact est la matière d'`availability.slots.spec.ts`.
      expect(response.body.days[0].slots.length).toBeGreaterThan(0);
      expect(response.body.days[0].slots[0]).toEqual({
        startsAt: expect.stringMatching(/Z$/),
        endsAt: expect.stringMatching(/Z$/),
        staffId: harness.a.staffId,
      });
    });

    it('rend une journée vide plutôt qu’un 404 quand rien n’est proposable', async () => {
      // Un salon complet existe, et son calendrier doit pouvoir le dire.
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ staffId: UNKNOWN_ID }))
        .expect(200);

      expect(response.body.days).toEqual([{ date: day, slots: [] }]);
    });

    it('refuse l’appel sans jeton', async () => {
      await request(harness.server()).get(BACK_OFFICE_PATH).query(query()).expect(401);
    });

    it('refuse l’appel d’un rôle sous le seuil', async () => {
      // `STAFF` est le rang le plus bas admis : une cliente authentifiée n'a pas
      // à lire l'agenda par cette porte, elle a la route publique.
      await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('CLIENT'))
        .query(query())
        .expect(403);
    });

    it('refuse en 400 une date mal formée, en nommant le champ', async () => {
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ from: '01/09/2026' }))
        .expect(400);

      expect(response.body).toMatchObject({ code: expect.any(String), message: expect.any(String) });
      expect(JSON.stringify(response.body)).toContain('from');
    });

    it('refuse en 400 une date civile qui n’existe pas', async () => {
      // `2026-02-31` satisfait le motif ; la laisser passer produirait un
      // calendrier décalé de deux jours, sans qu'aucune erreur ne le dise.
      await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ from: '2026-02-31' }))
        .expect(400);
    });

    it('refuse en 400 un paramètre non déclaré', async () => {
      // `forbidNonWhitelisted` : c'est ce qui empêche un `tenantId` glissé dans
      // la chaîne de requête d'atteindre quoi que ce soit.
      await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ tenantId: harness.b.tenant.id }))
        .expect(400);
    });

    it('refuse en 422 une plage de plus de 31 jours', async () => {
      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ from: '2026-09-01', to: '2026-12-31' }))
        .expect(422);

      expect(response.body.code).toBe('AVAILABILITY_RANGE_TOO_WIDE');
    });

    it('refuse en 422 une plage inversée', async () => {
      await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ from: '2026-09-02', to: '2026-09-01' }))
        .expect(422);
    });

    it('répond 404 pour une prestation inconnue', async () => {
      await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ serviceId: UNKNOWN_ID }))
        .expect(404);
    });
  });

  describe('tunnel public', () => {
    it('rend les créneaux sans le moindre jeton', async () => {
      // On réserve sans compte : on doit donc voir les créneaux sans compte.
      const response = await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query())
        .expect(200);

      expect(response.body.serviceId).toBe(harness.a.serviceId);
      expect(response.body.days[0].slots.length).toBeGreaterThan(0);
    });

    it('rend exactement la même charge utile que la route gardée', async () => {
      // Les deux portes servent la même projection : c'est ce qui garantit
      // qu'aucune donnée interne n'a été ajoutée du côté back-office par
      // inadvertance — ni motif d'absence, ni identité de cliente, ni tenant.
      const guarded = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query())
        .expect(200);

      const open = await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query())
        .expect(200);

      expect(open.body).toEqual(guarded.body);
      expect(Object.keys(open.body).sort()).toEqual(['days', 'serviceId', 'timezone']);
    });

    it('répond 404 pour un slug inconnu, sans exécuter le moindre code métier', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH('salon-qui-nexiste-pas'))
        .query(query())
        .expect(404);
    });
  });

  describe('cache', () => {
    it('écrit une clé par journée demandée, préfixée par l’établissement', async () => {
      const to = new Date(`${day}T00:00:00Z`);
      to.setUTCDate(to.getUTCDate() + 2);

      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query({ to: to.toISOString().slice(0, 10) }))
        .expect(200);

      expect(harness.cache.keysOf(harness.a.tenant.id)).toHaveLength(3);
      expect(harness.cache.keysOf(harness.b.tenant.id)).toHaveLength(0);
    });

    it('sert la seconde interrogation depuis le cache', async () => {
      const first = await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query())
        .expect(200);

      // Le planning est retiré entre les deux appels : seule une réponse
      // recalculée pourrait s'en apercevoir. La réponse identique est donc la
      // preuve que le cache a servi.
      harness.availability.schedules.length = 0;

      const second = await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query())
        .expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.body.days[0].slots.length).toBeGreaterThan(0);
    });

    it('ne met rien en cache quand la plage est refusée', async () => {
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query({ from: '2026-09-01', to: '2026-12-31' }))
        .expect(422);

      expect(harness.cache.entries.size).toBe(0);
    });
  });

  /**
   * L'exclusion du rendez-vous qu'un report déplace — #442.
   *
   * Ce qui se prouve ici est le deuxième critère du ticket, dans sa forme
   * servie : **le créneau qu'occupe le rendez-vous en cours de déplacement
   * redevient proposable dès qu'on le nomme**, et rien d'autre ne bouge. Les
   * tests unitaires du moteur (`availability.service.spec.ts`) le prouvent déjà
   * sur le calcul ; ce qui ne s'y prouve pas, c'est que le paramètre traverse le
   * DTO, le contrôleur et le service de lecture jusqu'à lui.
   */
  describe('exclusion du rendez-vous reporté (#442)', () => {
    /** Les tampons du harnais : 10 minutes avant, 60 de soin, 10 après. */
    const BUFFER_BEFORE_MS = 10 * 60_000;
    const OCCUPIED_MS = 80 * 60_000;

    const startTimes = (body: {
      days: { slots: { startsAt: string }[] }[];
    }): string[] => body.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));

    const publicSlots = async (overrides: Record<string, string> = {}): Promise<string[]> =>
      startTimes(
        (
          await request(harness.server())
            .get(PUBLIC_PATH(harness.a.tenant.slug))
            .query(query(overrides))
            .expect(200)
        ).body,
      );

    /**
     * Occupe un créneau du milieu de la journée par un rendez-vous, et rend son
     * identifiant avec l'heure **facturée** qu'il fait disparaître.
     *
     * L'intervalle posé est l'intervalle **occupé** — `startsAt` moins le tampon
     * de préparation, quatre-vingts minutes de large. C'est ce que l'agenda
     * stocke, et confondre les deux ferait chevaucher autre chose que le créneau
     * visé.
     */
    const occupyMiddleSlot = async (): Promise<{ id: string; billedStart: string }> => {
      const times = await publicSlots();
      const billedStart = times[Math.floor(times.length / 2)] as string;
      const occupiedStart = new Date(Date.parse(billedStart) - BUFFER_BEFORE_MS);

      const appointment = harness.availability.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staffId,
        startsAt: occupiedStart,
        endsAt: new Date(occupiedStart.getTime() + OCCUPIED_MS),
      });

      // Le jeu d'essai est posé dans le double et non par HTTP : aucune écriture
      // d'agenda n'a donc chassé le cache. On le vide à la main, faute de quoi
      // la question suivante serait servie par la réponse d'avant le rendez-vous.
      harness.cache.entries.clear();

      return { id: appointment.id, billedStart };
    };

    it('sans le paramètre, le créneau du rendez-vous n’est plus proposé', async () => {
      const { billedStart } = await occupyMiddleSlot();

      // L'état que #442 constate : le calendrier voit un praticien occupé, et la
      // cliente ne peut pas déplacer son rendez-vous d'un quart d'heure.
      expect(await publicSlots()).not.toContain(billedStart);
    });

    it('avec le paramètre, il redevient proposable — et rien d’autre ne change', async () => {
      const before = await publicSlots();
      const { id, billedStart } = await occupyMiddleSlot();

      const excluding = await publicSlots({ excludeAppointmentId: id });

      expect(excluding).toContain(billedStart);
      // Strictement le calendrier d'avant le rendez-vous : l'exclusion retire ce
      // rendez-vous du calcul, elle n'ouvre rien d'autre.
      expect(excluding).toEqual(before);
    });

    it('la route gardée le sert de la même façon', async () => {
      const { id, billedStart } = await occupyMiddleSlot();

      const response = await request(harness.server())
        .get(BACK_OFFICE_PATH)
        .set('Authorization', await harness.bearer('STAFF'))
        .query(query({ excludeAppointmentId: id }))
        .expect(200);

      // Le comptoir déplace des rendez-vous, lui aussi (#50).
      expect(startTimes(response.body)).toContain(billedStart);
    });

    it('n’écrit aucune clé de cache, et n’en consomme aucune', async () => {
      const { id, billedStart } = await occupyMiddleSlot();

      await publicSlots({ excludeAppointmentId: id });

      // Le troisième critère du ticket : la vue calculée avec une exclusion ne
      // se range nulle part. Sinon le créneau du rendez-vous apparaîtrait libre
      // à tous les lecteurs de la minute suivante.
      expect(harness.cache.keysOf(harness.a.tenant.id)).toEqual([]);

      // Et la question ordinaire, posée juste après, retrouve bien son
      // calendrier à elle — celui où le rendez-vous occupe son créneau.
      expect(await publicSlots()).not.toContain(billedStart);
    });

    it('ne consomme pas une journée déjà en cache', async () => {
      const { id, billedStart } = await occupyMiddleSlot();

      // La journée est mise en cache par une question ordinaire…
      await publicSlots();
      expect(harness.cache.keysOf(harness.a.tenant.id)).toHaveLength(1);

      // …et la question portant l'exclusion ne s'en sert pas : elle rendrait
      // sinon le calendrier où le rendez-vous s'occupe encore lui-même.
      expect(await publicSlots({ excludeAppointmentId: id })).toContain(billedStart);
    });

    it('refuse en 400 un identifiant mal formé', async () => {
      // Un champ libre ici descendrait dans le `where` d'une lecture d'agenda :
      // le refus est de forme, et il a lieu au DTO.
      await request(harness.server())
        .get(PUBLIC_PATH(harness.a.tenant.slug))
        .query(query({ excludeAppointmentId: 'le-mien' }))
        .expect(400);
    });

    it('reste sans effet sur un identifiant inconnu', async () => {
      const { billedStart } = await occupyMiddleSlot();

      // Ni erreur ni sonde d'existence : un identifiant qui ne désigne rien
      // n'apprend rien, et le calendrier est celui de tout le monde.
      expect(await publicSlots({ excludeAppointmentId: UNKNOWN_ID })).not.toContain(billedStart);
    });
  });
});
