import { randomUUID } from 'node:crypto';
import { get, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
 * Isolation inter-tenant — le flux temps réel des rendez-vous
 * (`GET /v1/appointments/stream`).
 *
 * Le flux ne se lit pas par identifiant : il **pousse**. La fuite possible n'est
 * donc pas un 200 là où l'on attendait un 404, mais un message qui arrive sur la
 * mauvaise connexion. Ces cas ouvrent de vraies connexions `text/event-stream`
 * — une par établissement —, réservent chez A, et constatent ce que chacune a
 * reçu.
 *
 * L'attente est bornée sur la connexion de A : c'est elle qui prouve que le
 * signal est bien parti. Constater que B n'a rien reçu sans avoir vu A recevoir
 * quelque chose ne prouverait rien — un flux cassé passerait aussi.
 */

const STREAM_PATH = '/api/v1/appointments/stream';

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

/** Une connexion ouverte au flux, et tout ce qu'elle a reçu jusqu'ici. */
interface OpenStream {
  readonly status: number;
  readonly contentType: string | undefined;
  received(): string;
  close(): void;
}

describe('Isolation inter-tenant — flux temps réel des rendez-vous', () => {
  let harness: AppointmentsHarness;
  let port: number;
  const opened: OpenStream[] = [];

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    const server = harness.server() as Server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const stream of opened.splice(0)) {
      stream.close();
    }
    await harness.close();
  });

  async function bearer(role: UserRole, tenant: TenantFixture, userId = randomUUID()) {
    const tokens = harness.app.get(TokenService);
    const token = await tokens.signAccessToken({ userId, tenantId: tenant.id, role });
    return `Bearer ${token}`;
  }

  function openStream(authorization: string | null): Promise<OpenStream> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      const req = get(
        {
          host: '127.0.0.1',
          port,
          path: STREAM_PATH,
          headers: {
            accept: 'text/event-stream',
            ...(authorization === null ? {} : { authorization }),
          },
        },
        (response: IncomingMessage) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => chunks.push(chunk));
          const stream: OpenStream = {
            status: response.statusCode ?? 0,
            contentType: response.headers['content-type'],
            received: () => chunks.join(''),
            close: () => {
              req.destroy();
            },
          };
          opened.push(stream);
          resolve(stream);
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        // La fermeture volontaire en fin de test n'est pas une erreur.
        if (error.code !== 'ECONNRESET') {
          reject(error);
        }
      });
    });
  }

  async function bookInA(): Promise<string> {
    const slot = bookableSlot();
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
        dataConsent: true,
      });

    expect(response.status).toBe(201);
    return String(response.body.id);
  }

  async function waitFor(stream: OpenStream, needle: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!stream.received().includes(needle)) {
      if (Date.now() > deadline) {
        throw new Error(`le flux n'a pas reçu « ${needle} » en 3 s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('refuse une connexion sans jeton', async () => {
    const stream = await openStream(null);

    expect(stream.status).toBe(401);
  });

  it('ouvre un flux `text/event-stream` pour un jeton valide', async () => {
    const stream = await openStream(await bearer('MANAGER', harness.a.tenant));

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');
  });

  it('la réservation chez A atteint la gérante de A, et jamais celle de B', async () => {
    const chezA = await openStream(await bearer('MANAGER', harness.a.tenant));
    const chezB = await openStream(await bearer('MANAGER', harness.b.tenant));

    const inA = await bookInA();
    await waitFor(chezA, inA);

    expect(chezA.received()).toContain('event: appointment');
    expect(chezB.received()).not.toContain('event: appointment');
    expect(chezB.received()).not.toContain(inA);
    expect(chezB.received()).not.toContain(harness.a.tenant.id);
  });

  it('pas même un `ADMIN` de B ne reçoit ce qui se passe chez A', async () => {
    const chezA = await openStream(await bearer('ADMIN', harness.a.tenant));
    const adminB = await openStream(await bearer('ADMIN', harness.b.tenant));

    const inA = await bookInA();
    await waitFor(chezA, inA);

    expect(adminB.received()).not.toContain('event: appointment');
  });

  it('une cliente ne reçoit pas les rendez-vous d’une autre, même dans son salon', async () => {
    const chezA = await openStream(await bearer('MANAGER', harness.a.tenant));
    const autreCliente = await openStream(await bearer('CLIENT', harness.a.tenant));

    const inA = await bookInA();
    await waitFor(chezA, inA);

    expect(autreCliente.received()).not.toContain('event: appointment');
  });

  it('ne transporte ni tenant ni coordonnée de la cliente', async () => {
    const chezA = await openStream(await bearer('MANAGER', harness.a.tenant));

    const inA = await bookInA();
    await waitFor(chezA, inA);

    const body = chezA.received();
    expect(body).not.toContain(harness.a.tenant.id);
    expect(body).not.toContain(GUEST.email);
    expect(body).not.toContain(GUEST.lastName);
  });
});
