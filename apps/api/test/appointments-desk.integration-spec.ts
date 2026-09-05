import { randomUUID } from 'node:crypto';

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import {
  BUFFER_BEFORE_MINUTES,
  SERVICE_DURATION_MINUTES,
  SERVICE_PRICE_MINOR,
  bookableSlot,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';
import type { TenantFixture } from './utils/tenant-harness';

/**
 * Les trois écritures de comptoir — `POST /api/v1/appointments`,
 * `/:id/reschedule` et `/:id/status` (#461, critères 1 à 4 et 7 de #50).
 *
 * Ce que cette suite exerce, et que les tests unitaires ne peuvent pas prouver :
 *
 * 1. les routes sont **servies**, et figurent dans le document OpenAPI. C'est la
 *    raison d'être du ticket : le contrat partagé les décrivait, le tiroir de
 *    #50 les appelait, et l'API rendait 404 — un contrôleur qui compile et passe
 *    ses tests unitaires peut parfaitement ne répondre à rien ;
 * 2. le **DTO de requête** est appliqué. En particulier le champ `client`, que
 *    `POST /appointments` refuse : c'est le pendant, côté API, du `.strict()` qui
 *    sépare les deux schémas de création dans `packages/shared` — le comptoir
 *    désigne une fiche, il n'en crée pas ;
 * 3. la **garde** tient : `STAFF` au minimum, jamais le parcours client ;
 * 4. le **report** produit bien une ligne neuve liée à l'ancienne, et libère le
 *    créneau de départ dans le même geste ;
 * 5. le **cycle de vie** refuse `pending → completed` en 422, et le refus vient
 *    d'`AppointmentLifecycleService` — jamais du contrôleur ;
 * 6. la réponse est la **ligne d'agenda** (`appointmentSchema`), intervalle
 *    facturé et *summaries* comprises : c'est ce que `apps/web/lib/api-client.ts`
 *    parse, et une forme publique y échouerait champ par champ.
 *
 * La frontière inter-tenant, elle, a sa propre suite
 * (`appointments-desk.isolation-spec.ts`), et la course sur le créneau la sienne
 * (`appointments-exclusion.concurrency-spec.ts`).
 */

const DESK_PATH = '/api/v1/appointments';

const RESCHEDULE_PATH = (id: string): string => `${DESK_PATH}/${id}/reschedule`;

const STATUS_PATH = (id: string): string => `${DESK_PATH}/${id}/status`;

const MINUTE_MS = 60_000;

/** La ligne d'agenda telle que le contrat la décrit — les champs qu'on vérifie. */
interface AgendaRow {
  readonly id: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly client: { readonly id: string; readonly firstName: string; readonly lastName: string };
  readonly staff: { readonly id: string; readonly displayName: string };
  readonly service: { readonly id: string; readonly name: string; readonly durationMinutes: number };
  readonly price: { readonly amountMinor: number; readonly currency: string };
  readonly clientNote?: string;
  readonly rescheduledFromId?: string;
  readonly createdAt: string;
}

describe('Écritures de rendez-vous au comptoir', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;
  /** La fiche cliente du salon A, celle que le comptoir désigne. */
  let clientId: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();

    clientId = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'camille@example.test',
      firstName: 'Camille',
      lastName: 'Rakoto',
    }).id;

    // Ce que la jointure d'agenda rendrait pour la prestation du harnais. Sans
    // lui, la ligne écrite retomberait sur l'affichage par défaut du double —
    // tampon avant nul — et la réponse annoncerait l'heure occupée au lieu de
    // l'heure du soin. Voir `seedServiceDisplay`.
    harness.appointments.seedServiceDisplay(harness.a.serviceId, {
      serviceName: 'Massage 60 min',
      serviceDurationMinutes: SERVICE_DURATION_MINUTES,
      serviceBufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
      servicePriceAmountMinor: SERVICE_PRICE_MINOR,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Un porteur signé pour l'établissement A, au rang demandé. */
  async function bearer(role: UserRole, tenant: TenantFixture = harness.a.tenant): Promise<string> {
    const tokens = harness.app.get(TokenService);
    const token = await tokens.signAccessToken({
      userId: randomUUID(),
      tenantId: tenant.id,
      role,
    });
    return `Bearer ${token}`;
  }

  /** Le corps nominal d'une prise de rendez-vous au comptoir. */
  function creation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      serviceId: harness.a.serviceId,
      staffId: harness.a.staffId,
      startsAt: slot.startsAt.toISOString(),
      clientId,
      ...overrides,
    };
  }

  /** Pose un rendez-vous au comptoir et rend la ligne d'agenda obtenue. */
  async function createAtDesk(overrides: Record<string, unknown> = {}): Promise<AgendaRow> {
    const response = await request(harness.server())
      .post(DESK_PATH)
      .set('Authorization', await bearer('STAFF'))
      .send(creation(overrides));

    expect(response.status).toBe(201);
    return response.body as AgendaRow;
  }

  describe('les routes sont servies', () => {
    it('publie les trois chemins dans le document OpenAPI', () => {
      // Le contrôle qui manquait avant ce ticket : le contrat partagé décrivait
      // les trois formes, et aucune n'était servie. Un `POST` déclaré sur un
      // contrôleur absent des `controllers` de son module compile, passe ses
      // tests unitaires — et ne figure pas ici.
      const document = SwaggerModule.createDocument(harness.app, new DocumentBuilder().build());
      const paths = document.paths as Record<string, Record<string, unknown>>;

      expect(paths[DESK_PATH]?.post).toBeDefined();
      expect(paths['/api/v1/appointments/{appointmentId}/reschedule']?.post).toBeDefined();
      expect(paths['/api/v1/appointments/{appointmentId}/status']?.post).toBeDefined();
    });
  });

  describe('POST /api/v1/appointments — poser un rendez-vous', () => {
    it('pose le rendez-vous et rend sa ligne d’agenda en 201', async () => {
      const row = await createAtDesk();

      // L'intervalle **facturé**, pas l'occupé : le comptoir annonce à la
      // cliente l'heure du soin, pas la cadence de cabine du salon.
      expect(row.startsAt).toBe(slot.startsAt.toISOString());
      expect(row.endsAt).toBe(
        new Date(slot.startsAt.getTime() + SERVICE_DURATION_MINUTES * MINUTE_MS).toISOString(),
      );
      expect(row.status).toBe('PENDING');
      // Les trois *summaries* — ce qu'`appointmentSchema` exige et que la forme
      // publique ne porte pas. Sans elles, le calendrier devrait relire la
      // période entière pour placer le bloc qu'il vient de créer.
      expect(row.client).toMatchObject({ id: clientId, firstName: 'Camille' });
      expect(row.staff).toMatchObject({ id: harness.a.staffId });
      expect(row.service).toMatchObject({
        id: harness.a.serviceId,
        durationMinutes: SERVICE_DURATION_MINUTES,
      });
      expect(row.price).toEqual({ amountMinor: SERVICE_PRICE_MINOR, currency: 'EUR' });
      expect(row.createdAt).toEqual(expect.any(String));
    });

    it('écrit la ligne dans l’établissement du jeton, rattachée à la fiche désignée', async () => {
      const row = await createAtDesk();

      const stored = harness.appointments.appointments.find((line) => line.id === row.id);
      expect(stored?.tenantId).toBe(harness.a.tenant.id);
      expect(stored?.clientId).toBe(clientId);
      // L'intervalle **occupé** est celui qui est en base, tampons compris —
      // c'est lui que la contrainte d'exclusion compare.
      expect(stored?.startsAt.toISOString()).toBe(slot.occupiedStartsAt.toISOString());
    });

    it('ne crée aucune fiche cliente au passage', async () => {
      await createAtDesk();

      // Le comptoir **désigne** une fiche, il n'en crée pas : c'est la frontière
      // que le `.strict()` des deux schémas de création tient côté contrat, et
      // qu'un doublon de fiche trahirait ici.
      expect(harness.appointments.clients).toHaveLength(1);
    });

    it('accepte un `clientNote` et le sert sur la ligne rendue', async () => {
      const row = await createAtDesk({ clientNote: 'Allergie aux huiles d’amande' });

      expect(row.clientNote).toBe('Allergie aux huiles d’amande');
    });

    it('affecte le premier praticien libre quand `staffId` est omis', async () => {
      const row = await createAtDesk({ staffId: undefined });

      // L'option « premier disponible » du CDC §1.4 (#36) vaut au comptoir comme
      // au tunnel : la réponse nomme le praticien retenu, faute de quoi
      // l'opérateur ne saurait pas chez qui il vient de poser le soin.
      expect(row.staff.id).toBe(harness.a.staffId);
    });

    it('refuse en 400 un `client` — le comptoir ne crée pas de fiche', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(
          creation({
            client: { firstName: 'Camille', lastName: 'Rakoto', email: 'autre@example.test' },
          }),
        );

      // Deuxième critère du ticket. `forbidNonWhitelisted` refuse le champ, et
      // c'est ce qui empêche une prise de rendez-vous de back-office de faire
      // naître un second dossier pour une cliente déjà fichée.
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(response.body)).toContain('client');
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('refuse en 400 un corps sans `clientId`', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation({ clientId: undefined }));

      // Le jeton est celui d'un membre du personnel : il n'y a aucune cliente à
      // en déduire, et poser un rendez-vous au nom de personne serait pire qu'un
      // refus. Voir l'en-tête de `CreateAppointmentDto`.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('clientId');
    });

    it('refuse en 400 une date-heure sans offset explicite', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation({ startsAt: '2026-09-01T09:00:00' }));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: expect.anything(),
      });
    });

    it('refuse en 404 une fiche cliente que cet établissement ne connaît pas', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation({ clientId: randomUUID() }));

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuse en 409 un créneau déjà pris', async () => {
      await createAtDesk();

      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation());

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    });

    it('refuse sans jeton en 401 et avec un jeton `CLIENT` en 403', async () => {
      const anonyme = await request(harness.server()).post(DESK_PATH).send(creation());
      const cliente = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('CLIENT'))
        .send(creation());

      expect(anonyme.status).toBe(401);
      expect(cliente.status).toBe(403);
      expect(harness.appointments.appointments).toHaveLength(0);
    });
  });

  describe('POST /api/v1/appointments/:id/reschedule — déplacer', () => {
    it('crée une ligne neuve liée à l’ancienne et annule celle-ci', async () => {
      const posé = await createAtDesk();
      const ailleurs = bookableSlot(14);

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: ailleurs.startsAt.toISOString() });

      expect(response.status).toBe(201);
      const row = response.body as AgendaRow;

      // Troisième critère du ticket : une **ligne neuve**, qui désigne celle
      // qu'elle remplace — jamais une réécriture des bornes en place.
      expect(row.id).not.toBe(posé.id);
      expect(row.rescheduledFromId).toBe(posé.id);
      expect(row.startsAt).toBe(ailleurs.startsAt.toISOString());

      const ancienne = harness.appointments.appointments.find((line) => line.id === posé.id);
      expect(ancienne?.status).toBe('CANCELLED');
      // Un report n'est pas un abandon : ni auteur ni motif ne sont inscrits,
      // faute de quoi le reporting du CDC §1.4 compterait une annulation.
      expect(ancienne?.cancelledBy).toBeNull();
      expect(ancienne?.cancellationReason).toBeNull();
    });

    it('libère le créneau de départ, qui redevient réservable', async () => {
      const posé = await createAtDesk();
      const ailleurs = bookableSlot(14);

      await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: ailleurs.startsAt.toISOString() });

      // La ligne d'origine a quitté les statuts occupants : le créneau est
      // vendable au `COMMIT`, sans qu'aucune libération n'ait été écrite.
      const repris = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation());

      expect(repris.status).toBe(201);
    });

    it('rend le rendez-vous inchangé quand le report ne déplace rien', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: slot.startsAt.toISOString(), staffId: harness.a.staffId });

      // Même praticien, même instant : rien n'est écrit, et l'identifiant que la
      // cliente a reçu reste valable.
      expect(response.status).toBe(201);
      expect((response.body as AgendaRow).id).toBe(posé.id);
      expect(harness.appointments.appointments).toHaveLength(1);
    });

    it('refuse en 422 le report d’un rendez-vous déjà annulé', async () => {
      const posé = await createAtDesk();

      await request(harness.server())
        .post(`${DESK_PATH}/${posé.id}/cancel`)
        .set('Authorization', await bearer('STAFF'))
        .send({});

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('refuse en 404 un rendez-vous inconnu, et en 400 un identifiant mal formé', async () => {
      const inconnu = await request(harness.server())
        .post(RESCHEDULE_PATH(randomUUID()))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      const malformé = await request(harness.server())
        .post(RESCHEDULE_PATH('pas-un-uuid'))
        .set('Authorization', await bearer('STAFF'))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      expect(inconnu.status).toBe(404);
      expect(malformé.status).toBe(400);
    });

    it('refuse sans jeton en 401 et avec un jeton `CLIENT` en 403', async () => {
      const posé = await createAtDesk();
      const startsAt = bookableSlot(14).startsAt.toISOString();

      const anonyme = await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .send({ startsAt });
      const cliente = await request(harness.server())
        .post(RESCHEDULE_PATH(posé.id))
        .set('Authorization', await bearer('CLIENT'))
        .send({ startsAt });

      expect(anonyme.status).toBe(401);
      expect(cliente.status).toBe(403);
      expect(harness.appointments.appointments).toHaveLength(1);
    });
  });

  describe('POST /api/v1/appointments/:id/status — faire avancer', () => {
    /** Fait passer un rendez-vous à `CONFIRMED` — la porte de `completed`. */
    async function confirm(id: string): Promise<AgendaRow> {
      const response = await request(harness.server())
        .post(STATUS_PATH(id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'confirmed' });

      expect(response.status).toBe(200);
      return response.body as AgendaRow;
    }

    it('confirme un rendez-vous et rend sa ligne d’agenda en 200', async () => {
      const posé = await createAtDesk();

      const row = await confirm(posé.id);

      // 200 et non 201 : rien n'est créé, et l'identifiant ne bouge pas — c'est
      // ce qui distingue cette route du report.
      expect(row.id).toBe(posé.id);
      expect(row.status).toBe('CONFIRMED');
    });

    it('solde un rendez-vous confirmé en `completed`, puis n’en fait plus rien', async () => {
      const posé = await createAtDesk();
      await confirm(posé.id);

      const soldé = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'completed' });

      expect(soldé.status).toBe(200);
      expect((soldé.body as AgendaRow).status).toBe('COMPLETED');

      // `COMPLETED` est terminal : tout retour en arrière est refusé, y compris
      // vers l'annulation (booking-engine §5).
      const retour = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'cancelled' });

      expect(retour.status).toBe(422);
      expect(retour.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('marque un no-show et libère le créneau', async () => {
      const posé = await createAtDesk();
      await confirm(posé.id);

      const absent = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'no_show' });

      expect(absent.status).toBe(200);
      expect((absent.body as AgendaRow).status).toBe('NO_SHOW');

      // `NO_SHOW` sort du filtre partiel de la contrainte : le créneau est
      // vendable, et c'est tout l'intérêt de le marquer plutôt que de l'effacer.
      const repris = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF'))
        .send(creation());

      expect(repris.status).toBe(201);
    });

    it('refuse `pending → completed` en 422, en nommant les deux statuts', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'completed' });

      // Quatrième critère du ticket. On ne solde pas un soin qui n'a pas été
      // confirmé — et le refus vient d'`AppointmentLifecycleService`, pas du
      // contrôleur : c'est ce que `details` prouve en portant `from` et `to`.
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { from: 'PENDING', to: 'COMPLETED' },
      });

      const stored = harness.appointments.appointments.find((line) => line.id === posé.id);
      expect(stored?.status).toBe('PENDING');
    });

    it('refuse en 422 un statut vers lui-même', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'pending' });

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('inscrit la trace d’annulation quand la transition visée est `cancelled`', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'cancelled', reason: 'Cliente injoignable' });

      expect(response.status).toBe(200);

      // La transition passe par l'annulation, qui est la seule écriture qui pose
      // la trace : sans elle, le reporting du CDC §1.4 compterait une annulation
      // dont il ne saurait dire ni quand ni de quel côté du comptoir.
      const stored = harness.appointments.appointments.find((line) => line.id === posé.id);
      expect(stored?.status).toBe('CANCELLED');
      expect(stored?.cancelledBy).toBe('STAFF');
      expect(stored?.cancelledAt).not.toBeNull();
      expect(stored?.cancellationReason).toBe('Cliente injoignable');
    });

    it('refuse en 400 un statut hors du vocabulaire du contrat', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'HONORE' });

      // 400 et non 422 : le mot n'existe pas, ce n'est pas un passage qui
      // n'existe pas. Le tiroir n'affiche pas la même chose des deux.
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuse en 400 un champ non déclaré dans le corps', async () => {
      const posé = await createAtDesk();

      const response = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'confirmed', cancelledAt: '2026-01-01T00:00:00Z' });

      // Antidater la trace depuis le corps est exactement ce que le
      // `ValidationPipe` global rend impossible.
      expect(response.status).toBe(400);
    });

    it('refuse en 404 un rendez-vous inconnu', async () => {
      const response = await request(harness.server())
        .post(STATUS_PATH(randomUUID()))
        .set('Authorization', await bearer('STAFF'))
        .send({ status: 'confirmed' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuse sans jeton en 401 et avec un jeton `CLIENT` en 403', async () => {
      const posé = await createAtDesk();

      const anonyme = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .send({ status: 'confirmed' });
      const cliente = await request(harness.server())
        .post(STATUS_PATH(posé.id))
        .set('Authorization', await bearer('CLIENT'))
        .send({ status: 'confirmed' });

      expect(anonyme.status).toBe(401);
      expect(cliente.status).toBe(403);

      const stored = harness.appointments.appointments.find((line) => line.id === posé.id);
      expect(stored?.status).toBe('PENDING');
    });
  });
});
