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
 * Fuite inter-tenant sur la **preuve de consentement** — tenant-isolation §6,
 * appliqué à la donnée que #790 vient d'écrire.
 *
 * ## Pourquoi une suite à elle seule, alors que l'agenda a déjà la sienne
 *
 * Parce que ce n'est pas la même chose qui est prouvée. `appointments-agenda.isolation-spec.ts`
 * prouve que la **route** est bornée ; celle-ci prouve que la **colonne** l'est —
 * c'est-à-dire qu'elle ne s'est pas invitée sur une sortie qui échappe à la
 * garde. Une colonne ajoutée en fin de course a exactement deux façons de fuir,
 * et aucune n'est couverte par les suites d'agenda existantes :
 *
 * 1. elle sort par une **surface publique** — l'écran de confirmation, le report
 *    ou l'annulation du parcours client, qui n'ont aucun jeton à présenter. Un
 *    `APPOINTMENT_SELECT` élargi d'un geste suffirait, et rien ne rougirait ;
 * 2. elle se lit **depuis le salon voisin**, qui apprendrait alors qu'une
 *    personne a consenti chez un concurrent, et quand.
 *
 * Le second est le pire des deux : une preuve de consentement dit *qu'une
 * personne a réservé* avant même de dire quoi que ce soit du rendez-vous. Le
 * troisième critère d'acceptation de #790 l'exige nommément, et c'est ce que
 * cette suite exerce.
 *
 * ## Le protocole, ramené à cette donnée
 *
 * Réserver chez A par le tunnel public — c'est la seule porte qui recueille un
 * accord —, puis :
 *
 * | Qui lit | Attendu |
 * |---|---|
 * | le comptoir de **A** | la preuve, horodatée en UTC |
 * | le comptoir de **B** | rien du tout : ni la ligne, ni la preuve |
 * | **personne** (sans jeton) | 401, et aucun corps |
 * | le parcours **public**, qui vient pourtant de réserver | pas de preuve dans la réponse |
 *
 * Le dernier n'est pas une frontière de tenant, et il est ici quand même : c'est
 * la même question posée à l'autre bout — « qui a le droit de lire cette
 * colonne ? » —, et la séparer dans une autre suite aurait laissé croire qu'une
 * réponse suffit.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const AGENDA_PATH = '/api/v1/appointments';

const REFERENCE_PATH = (reference: string): string => `${AGENDA_PATH}/reference/${reference}`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

/** Ce que rend la réservation publique, réduit à ce que cette suite relit. */
interface BookedBody {
  readonly id: string;
  readonly reference: string;
}

/** Une ligne d'agenda, réduite à ce que cette suite relit. */
interface AgendaBody {
  readonly id: string;
  readonly dataConsentAt?: string;
}

describe('Isolation inter-tenant — preuve de consentement', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;
  let booked: BookedBody;
  /** La journée civile du créneau — le harnais est à `UTC`, voir son en-tête. */
  let jour: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
    jour = slot.startsAt.toISOString().slice(0, 10);

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
    booked = response.body as BookedBody;
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Un porteur signé pour cet établissement-**là**. */
  async function bearer(tenant: TenantFixture, role: UserRole = 'MANAGER'): Promise<string> {
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId: randomUUID(), tenantId: tenant.id, role });
    return `Bearer ${token}`;
  }

  it('sert la preuve au comptoir de l’établissement, horodatée en UTC', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    const lignes = response.body as AgendaBody[];
    const ligne = lignes.find((candidate) => candidate.id === booked.id);

    expect(ligne).toBeDefined();
    // L'accord est daté, et il l'est par le **serveur** : le corps de la requête
    // n'en portait aucune date. Le `Z` final n'est pas une coquetterie de format
    // — c'est ce qui rend la preuve comparable d'un fuseau à l'autre (ADR 0006).
    expect(ligne?.dataConsentAt).toMatch(/Z$/);
    expect(new Date(String(ligne?.dataConsentAt)).getTime()).not.toBeNaN();
  });

  it('ne laisse rien lire de la preuve au comptoir du salon voisin', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}`)
      .set('Authorization', await bearer(harness.b.tenant))
      .expect(200);

    const lignes = response.body as AgendaBody[];

    // Une liste vide, et non un 403 : la route ne doit pas confirmer qu'il y a
    // quelque chose à voir ailleurs (tenant-isolation §4).
    expect(lignes).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain('dataConsentAt');
    expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
  });

  it('refuse en 404 la résolution par référence depuis le salon voisin', async () => {
    const response = await request(harness.server())
      .get(REFERENCE_PATH(booked.reference))
      .set('Authorization', await bearer(harness.b.tenant));

    // 404 et non 403 : la référence est courte et s'énumère, et un 403 dirait à
    // qui la devine qu'elle désigne un rendez-vous réel chez le voisin.
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('dataConsentAt');
    expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
  });

  it('sert la preuve à qui résout la référence dans son propre établissement', async () => {
    const response = await request(harness.server())
      .get(REFERENCE_PATH(booked.reference))
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    expect((response.body as AgendaBody).dataConsentAt).toMatch(/Z$/);
  });

  it('refuse en 401 la lecture sans jeton', async () => {
    const response = await request(harness.server()).get(`${AGENDA_PATH}?from=${jour}`);

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('dataConsentAt');
  });

  it('ne rend la preuve à aucune surface publique, pas même à qui vient de consentir', () => {
    // La réponse de la réservation elle-même : la cliente sait ce qu'elle vient
    // de cocher, et cette route n'a pas de jeton à opposer à qui devinerait un
    // identifiant. C'est une donnée de **registre**, et le registre est du côté
    // du salon.
    expect(booked).not.toHaveProperty('dataConsentAt');
    expect(JSON.stringify(booked)).not.toContain('dataConsent');
  });
});
