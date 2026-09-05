import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { createAppointmentsHarness, type AppointmentsHarness } from './appointments.harness';
import { expectListScopedTo } from './utils/tenant-assertions';
import type { TenantFixture } from './utils/tenant-harness';

/**
 * Fuite inter-tenant sur l'**agenda du back-office** — tenant-isolation §6,
 * appliqué à `GET /api/v1/appointments` (#444).
 *
 * ## Ce qu'une traversée coûterait ici
 *
 * La journée entière d'un salon concurrent : qui vient, quand, pour quel soin,
 * pour combien, avec les notes internes de ses praticiens. C'est la lecture la
 * plus dense du produit — un seul appel suffirait à recopier le fichier client et
 * le carnet de commandes d'un concurrent. Le CDC §5.1 la protège, et c'est
 * l'incident le plus grave que cette route puisse produire.
 *
 * ## Trois frontières, et aucune n'est un `if`
 *
 * | Frontière | Ce qui la tient | Le cas qui l'exerce |
 * |---|---|---|
 * | l'**établissement** | le client Prisma scopé, armé par la revendication du jeton | deux salons, mêmes heures |
 * | les **filtres** | ils restreignent à l'intérieur de ce qui est déjà borné | un `staffId` du voisin |
 * | la **jointure** | les clés étrangères composites `(tenant_id, …)` | une fiche cliente de même identifiant chez les deux |
 *
 * La deuxième est la plus retorse, et c'est celle que cette suite sème
 * explicitement : un `staffId`, un `clientId` ou un `serviceId` du salon voisin
 * ne doit **ni** lever **ni** rendre quoi que ce soit — une liste vide, jamais un
 * 403 ni un 404 nommant la ressource, faute de quoi cette route deviendrait une
 * sonde d'annuaire (tenant-isolation §4).
 */

const AGENDA_PATH = '/api/v1/appointments';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('Isolation inter-tenant — agenda du back-office', () => {
  let harness: AppointmentsHarness;

  /**
   * L'identifiant de cliente **partagé** par les deux établissements.
   *
   * `users.id` est unique globalement, mais rien n'empêche deux lignes de deux
   * salons de porter le même `client_id` dans un jeu de données forgé — et c'est
   * le scénario qui distingue un filtre par cliente d'un filtre par cliente
   * **et** par établissement.
   */
  const sharedClientId = randomUUID();

  const demain = new Date(Date.now() + DAY_MS);
  /** La journée civile interrogée — le harnais est à `UTC`, voir son en-tête. */
  const jour = demain.toISOString().slice(0, 10);

  let chezA: string;
  let chezB: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();

    // La même fiche cliente, le même nom, dans les deux salons : si la jointure
    // sortait du tenant, rien dans le corps ne le trahirait — d'où le contrôle
    // sur les identifiants, et non sur les noms.
    for (const tenant of [harness.a.tenant, harness.b.tenant]) {
      harness.appointments.seedClient({
        tenantId: tenant.id,
        email: 'camille@example.test',
        firstName: 'Camille',
        lastName: 'Durand',
      });
    }

    const seed = (target: typeof harness.a): string =>
      harness.appointments.seedAppointment({
        tenantId: target.tenant.id,
        staffId: target.staffId,
        serviceId: target.serviceId,
        clientId: sharedClientId,
        startsAt: demain,
        endsAt: new Date(demain.getTime() + HOUR_MS),
        staffNote: `note interne de ${target.tenant.slug}`,
      }).id;

    chezA = seed(harness.a);
    chezB = seed(harness.b);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Un porteur signé pour cet établissement-**là**. */
  async function bearer(tenant: TenantFixture, role: UserRole = 'STAFF'): Promise<string> {
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId: randomUUID(), tenantId: tenant.id, role });
    return `Bearer ${token}`;
  }

  it('ne rend que les rendez-vous de l’établissement du jeton', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    // Égalité d'ensemble, et non simple absence : une liste vide satisferait
    // « aucun identifiant du voisin » sans rien prouver du filtrage.
    expectListScopedTo(response.body, { ownIds: [chezA], foreignIds: [chezB] });
  });

  it('le même jeu de filtres ne lit chez B que les lignes de B', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}`)
      .set('Authorization', await bearer(harness.b.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [chezB], foreignIds: [chezA] });
  });

  it('un `staffId` du voisin rend une liste vide, jamais une erreur', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&staffId=${harness.b.staffId}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    // 200 et `[]`, jamais 403 ni 404 : les trois réponses possibles diraient
    // trois choses différentes sur l'existence du praticien visé, et seule
    // celle-ci n'apprend rien.
    expect(response.body).toEqual([]);
  });

  it('un `serviceId` du voisin rend une liste vide', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&serviceId=${harness.b.serviceId}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('le `clientId` partagé ne ramène chez A que la ligne de A', async () => {
    // Le cas le plus retors : le filtre porte sur un identifiant qui existe des
    // deux côtés. Un filtre par cliente sans filtre par établissement les
    // ramènerait toutes les deux, et une assertion sur « la liste n'est pas
    // vide » ne le verrait pas.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&clientId=${sharedClientId}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [chezA], foreignIds: [chezB] });
  });

  it('n’expose ni le `tenantId` ni la note interne du voisin', async () => {
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    const serialized = JSON.stringify(response.body);
    // Le tenant est une information interne : il n'apporte rien au consommateur
    // et invite aux essais (tenant-isolation §4).
    expect(serialized).not.toContain(harness.a.tenant.id);
    expect(serialized).not.toContain(harness.b.tenant.id);
    // La note interne franchit bien la frontière du rôle — c'est le propos de
    // cette route — mais jamais celle de l'établissement.
    expect(serialized).toContain(`note interne de ${harness.a.tenant.slug}`);
    expect(serialized).not.toContain(`note interne de ${harness.b.tenant.slug}`);
  });

  it('le rang le plus élevé ne traverse pas davantage', async () => {
    // La frontière n'est pas une question de droits, c'est une question de
    // portée : un `ADMIN` de B ne voit pas un rendez-vous de plus chez A.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&staffId=${harness.a.staffId}`)
      .set('Authorization', await bearer(harness.b.tenant, 'ADMIN'))
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('aucun `tenantId` de requête ne redirige la lecture', async () => {
    // Le `ValidationPipe` global est en `forbidNonWhitelisted` : le champ est
    // nommé et refusé, jamais ignoré en silence — donc jamais interprété comme
    // une portée.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&tenantId=${harness.b.tenant.id}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(chezB);
  });

  it('rend bien quelque chose au porteur légitime — la contrepartie', async () => {
    // Sans ce cas, un refus systématique — une route cassée, un filtre trop
    // large — ferait verdir toute cette suite sans rien garantir.
    const response = await request(harness.server())
      .get(`${AGENDA_PATH}?from=${jour}&staffId=${harness.a.staffId}`)
      .set('Authorization', await bearer(harness.a.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [chezA], foreignIds: [chezB] });
  });
});
