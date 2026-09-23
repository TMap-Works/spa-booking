import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import {
  bookableSlot,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';
import type { TenantFixture } from './utils/tenant-harness';

/**
 * Fuite inter-tenant sur l'**annulation** — tenant-isolation §6, appliqué aux
 * deux routes de #40.
 *
 * ## Pourquoi cette suite est la plus importante des trois du module
 *
 * Les deux autres protègent des lectures et des créations. Ici, une traversée
 * réussie **détruirait** : elle annulerait le rendez-vous d'un salon voisin —
 * une cliente décommandée, un créneau rendu à la vente, un praticien qui
 * découvre son agenda vide. Il n'y a aucun geste de rattrapage, la transition
 * `CANCELLED` étant terminale.
 *
 * Les deux surfaces sont exercées, parce qu'elles désignent l'établissement de
 * deux façons **différentes**, et qu'une seule des deux protégée ne protège
 * rien :
 *
 * | Route | D'où vient le tenant | Attendu en traversée |
 * |---|---|---|
 * | publique | le slug d'URL, résolu par le middleware | 404 |
 * | back-office | le jeton signé, et lui seul | 404 |
 *
 * Dans les deux cas **404, jamais 403** : un 403 confirmerait l'existence du
 * rendez-vous à qui vient d'essayer de l'effacer de l'agenda. Et dans les deux
 * cas, la ligne du voisin est relue après le refus — c'est ce qui distingue « la
 * réponse est bonne » de « rien n'a été écrit ».
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const PUBLIC_CANCEL_PATH = (slug: string, id: string): string =>
  `${BOOKING_PATH(slug)}/${id}/cancel`;

const DESK_CANCEL_PATH = (id: string): string => `/api/v1/appointments/${id}/cancel`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

describe('Isolation inter-tenant — annulation de rendez-vous', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Réserve dans l'établissement A et rend le rendez-vous obtenu. */
  async function bookInA(): Promise<{ id: string; clientId: string }> {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      // Réserver exige la cliente authentifiée depuis #1136 : c'est la cliente
      // du harnais qui pose le rendez-vous, et c'est elle que le jeton nomme.
      .set('Authorization', await harness.bearer(harness.a))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
        dataConsent: true,
      });

    expect(response.status).toBe(201);
    return { id: String(response.body.id), clientId: String(response.body.clientId) };
  }

  /**
   * Un porteur signé pour cet établissement-**là**, et pour ce compte-là.
   *
   * L'établissement est explicite et non implicite : un jeton signé sur une
   * portée qui ne désigne aucun établissement ferait verdir tous les cas de
   * traversée sans avoir jamais visé le voisin — le mode de défaillance qu'un
   * harnais de fuite ne peut pas se permettre.
   *
   * Le compte l'est aussi depuis #1135 : la route publique compare le `sub` du
   * jeton à `appointments.client_id`, et un `userId` implicite ferait rendre 404
   * pour une raison — la propriété — qui n'est pas celle que cette suite
   * observe.
   */
  async function bearerFor(role: UserRole, tenant: TenantFixture, userId: string): Promise<string> {
    const tokens = harness.app.get(TokenService);
    const token = await tokens.signAccessToken({
      userId,
      tenantId: tenant.id,
      role,
    });
    return `Bearer ${token}`;
  }

  /** Un porteur de ce rôle, pour un compte quelconque de cet établissement. */
  function bearer(role: UserRole, tenant: TenantFixture): Promise<string> {
    return bearerFor(role, tenant, randomUUID());
  }

  describe('la route publique — le tenant vient du slug d’URL', () => {
    it('refuse en 404 le rendez-vous de A demandé sous le slug de B', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.b.tenant.slug, inA.id))
        // Une cliente de **B**, munie d'un jeton valide de B : c'est la seule
        // façon d'atteindre le code métier depuis #1135, et donc la seule façon
        // d'exercer encore la frontière plutôt que la garde.
        .set('Authorization', await bearer('CLIENT', harness.b.tenant))
        .send({ reason: 'tentative' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      // Aucune miette : ni l'identifiant du voisin, ni celui de son
      // établissement ne doivent transparaître dans le corps d'erreur.
      expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
      expect(JSON.stringify(response.body)).not.toContain(inA.id);
    });

    it('refuse en 401 le jeton de A présenté sous le slug de B', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.b.tenant.slug, inA.id))
        // La cliente de A, son vrai jeton, mais le slug du voisin. Poursuivre
        // choisirait silencieusement l'un des deux établissements ; refuser est
        // la seule issue sûre (`jwt-auth.guard.ts`).
        .set('Authorization', await bearerFor('CLIENT', harness.a.tenant, inA.clientId))
        .send({ reason: 'tentative' });

      expect(response.status).toBe(401);
      expect(harness.appointments.appointments.find((row) => row.id === inA.id)?.status).toBe(
        'PENDING',
      );
    });

    it('laisse le rendez-vous du voisin absolument intact', async () => {
      const inA = await bookInA();

      await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.b.tenant.slug, inA.id))
        .set('Authorization', await bearer('CLIENT', harness.b.tenant))
        .send({ reason: 'tentative' });

      const kept = harness.appointments.appointments.find((row) => row.id === inA.id);
      expect(kept?.status).toBe('PENDING');
      // Pas seulement le statut : aucune trace n'a été posée non plus, sans quoi
      // la ligne porterait un motif écrit par un inconnu.
      expect(kept?.cancelledAt).toBeNull();
      expect(kept?.cancelledBy).toBeNull();
      expect(kept?.cancellationReason).toBeNull();
    });

    it('rend le **même** 404 pour un identifiant qui n’existe nulle part', async () => {
      const inA = await bookInA();
      const chezB = await bearer('CLIENT', harness.b.tenant);

      const inconnu = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.b.tenant.slug, randomUUID()))
        .set('Authorization', chezB)
        .send({});
      const ailleurs = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.b.tenant.slug, inA.id))
        .set('Authorization', chezB)
        .send({});

      // « Inconnu ici » et « connu ailleurs » doivent être indiscernables, faute
      // de quoi la différence sert de sonde d'existence (tenant-isolation §4).
      expect(inconnu.status).toBe(ailleurs.status);
      expect(inconnu.body.code).toBe(ailleurs.body.code);
    });

    it('n’écrit rien chez le voisin quand l’annulation aboutit', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, inA.id))
        .set('Authorization', await bearerFor('CLIENT', harness.a.tenant, inA.clientId))
        .send({});

      expect(response.status).toBe(200);
      expect(
        harness.appointments.appointments.filter((row) => row.tenantId === harness.b.tenant.id),
      ).toHaveLength(0);
      expect(JSON.stringify(response.body)).not.toContain(harness.b.tenant.id);
    });
  });

  describe('la route de back-office — le tenant vient du jeton', () => {
    it('refuse en 404 le rendez-vous de A avec un jeton `STAFF` de B', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(inA.id))
        .set('Authorization', await bearer('MANAGER', harness.b.tenant))
        .send({ reason: 'tentative' });

      // 404 et non 403 : le rang est suffisant, c'est l'établissement qui ne
      // l'est pas — et le dire confirmerait l'existence de la ligne.
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
    });

    it('ne laisse pas même un `ADMIN` du voisin annuler chez A', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(inA.id))
        .set('Authorization', await bearer('ADMIN', harness.b.tenant))
        .send({});

      // Le rang le plus élevé ne traverse pas davantage : la frontière n'est pas
      // une question de droits, c'est une question de portée.
      expect(response.status).toBe(404);
      const kept = harness.appointments.appointments.find((row) => row.id === inA.id);
      expect(kept?.status).toBe('PENDING');
      expect(kept?.cancelledBy).toBeNull();
    });

    it('laisse le rendez-vous du voisin intact après le refus', async () => {
      const inA = await bookInA();

      await request(harness.server())
        .post(DESK_CANCEL_PATH(inA.id))
        .set('Authorization', await bearer('MANAGER', harness.b.tenant))
        .send({ reason: 'tentative' });

      const kept = harness.appointments.appointments.find((row) => row.id === inA.id);
      expect(kept?.status).toBe('PENDING');
      expect(kept?.cancelledAt).toBeNull();
      expect(kept?.cancellationReason).toBeNull();
      expect(harness.appointments.appointments).toHaveLength(1);
    });

    it('accepte le même appel avec le jeton du bon établissement', async () => {
      const inA = await bookInA();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(inA.id))
        .set('Authorization', await bearer('MANAGER', harness.a.tenant))
        .send({});

      // Le contrôle de la contrepartie : sans lui, un refus systématique — une
      // route cassée, par exemple — ferait verdir toute cette suite.
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'STAFF' });
    });
  });
});
