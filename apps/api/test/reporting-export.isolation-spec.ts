import request from 'supertest';

import { createReportingHarness, type ReportingHarness } from './reporting.harness';

/**
 * Isolation inter-tenant de l'export du reporting — cinquième critère de #563,
 * et obligation de tenant-isolation §6 pour tout endpoint nouveau.
 *
 * ## Pourquoi cette suite est distincte de `reporting-tenant.isolation-spec.ts`
 *
 * Parce que la propriété n'est pas la même. Les trois routes de lecture ne
 * prennent aucun identifiant : ce qui pouvait y fuir était un **chiffre**, et la
 * suite voisine le prouve en comparant des totaux. L'export, lui, introduit la
 * première ressource **adressable** du module — un `exportId` en chemin — et
 * avec elle le protocole habituel : demander la ressource du voisin, et obtenir
 * 404.
 *
 * ## Ce qui fait tenir le 404, et ce n'est pas une comparaison d'identifiants
 *
 * Aucun code de ce module ne compare le tenant d'un export à celui de
 * l'appelant. La clé S3 est **recomposée** à partir du `tenant_id` du jeton
 * (`export/report-export.key.ts`) : le voisin qui présente l'identifiant de A
 * fait chercher `exports/{B}/{id}.csv`, qui n'existe pas. Le 404 est donc une
 * conséquence de la forme de la clé, pas d'un contrôle qu'un refactor pourrait
 * emporter — et c'est exactement pour cela que cette suite vérifie **aussi** la
 * forme de la clé déposée, et non seulement le code de statut.
 *
 * ## Le scénario : deux salons, le même geste, la même période
 *
 * Chacun produit son export. Puis chacun tente celui de l'autre. Rien dans la
 * réponse d'un salon ne doit porter l'identifiant, le slug ou la clé de l'autre.
 */

const EXPORT = '/api/v1/reports/export';

const FROM = '2026-08-31T22:00:00Z';
const TO = '2026-09-30T22:00:00Z';

describe('Isolation inter-tenant — export du reporting', () => {
  let harness: ReportingHarness;
  /** L'établissement de l'appelant. */
  let a: string;
  /** L'établissement voisin, celui dont aucun export ne doit se lire. */
  let b: string;

  beforeEach(async () => {
    harness = await createReportingHarness();
    a = harness.tenantId;
    b = harness.otherTenantId;

    // Une journée identique des deux côtés, plus une recette chez B seulement :
    // si le scoping tombait, le fichier de A porterait ce surplus.
    for (const tenantId of [a, b]) {
      harness.seedPayment({
        tenantId,
        date: '2026-09-03',
        capturedAt: new Date('2026-09-03T14:00:00Z'),
        method: 'CARD',
        currency: 'EUR',
        status: 'SUCCEEDED',
        amountMinor: 12_000,
        refundedAmountMinor: 0,
      });
    }

    harness.seedPayment({
      tenantId: b,
      date: '2026-09-04',
      capturedAt: new Date('2026-09-04T14:00:00Z'),
      method: 'CASH',
      currency: 'EUR',
      status: 'SUCCEEDED',
      amountMinor: 50_000,
      refundedAmountMinor: 0,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Produit l'export de l'établissement voulu, sous un jeton `MANAGER`. */
  async function creerPour(tenantId: string): Promise<request.Response> {
    return request(harness.app.getHttpServer())
      .post(EXPORT)
      .query({ from: FROM, to: TO })
      .set('Authorization', await harness.bearer('MANAGER', tenantId))
      .expect(201);
  }

  /** Tente de re-signer un export sous le jeton de l'établissement voulu. */
  async function resignerPour(
    tenantId: string,
    exportId: string,
    status: number,
  ): Promise<request.Response> {
    return request(harness.app.getHttpServer())
      .get(`${EXPORT}/${exportId}`)
      .set('Authorization', await harness.bearer('MANAGER', tenantId))
      .expect(status);
  }

  it('range chaque export sous le préfixe de son établissement, et nulle part ailleurs', async () => {
    const chezA = await creerPour(a);
    const chezB = await creerPour(b);

    expect([...harness.storage.objects.keys()].sort()).toEqual(
      [
        `exports/${a}/${String(chezA.body.id)}.csv`,
        `exports/${b}/${String(chezB.body.id)}.csv`,
      ].sort(),
    );
  });

  it('rend **404** au voisin qui présente l’identifiant d’un export qui n’est pas le sien', async () => {
    const chezA = await creerPour(a);

    // 404, jamais 403 : un 403 confirmerait l'existence de l'export de A
    // (tenant-isolation §4).
    const refus = await resignerPour(b, String(chezA.body.id), 404);

    expect(refus.body.code).toBe('NOT_FOUND');
  });

  it('ne laisse fuir ni l’URL, ni la clé, ni le nom du fichier du voisin', async () => {
    const chezA = await creerPour(a);

    const refus = await resignerPour(b, String(chezA.body.id), 404);
    const corps = JSON.stringify(refus.body);

    expect(corps).not.toContain('http');
    expect(corps).not.toContain(a);
    expect(corps).not.toContain('maison-lotus');
  });

  it('rend le même refus dans les deux sens — B est le voisin de A autant que l’inverse', async () => {
    const chezB = await creerPour(b);

    await resignerPour(a, String(chezB.body.id), 404);
  });

  it('laisse chacun re-signer le sien', async () => {
    const chezA = await creerPour(a);
    const chezB = await creerPour(b);

    const reA = await resignerPour(a, String(chezA.body.id), 200);
    const reB = await resignerPour(b, String(chezB.body.id), 200);

    expect(reA.body.url).toContain(`exports/${a}/`);
    expect(reB.body.url).toContain(`exports/${b}/`);
  });

  it('ne sérialise que la recette de l’établissement du jeton', async () => {
    const chezA = await creerPour(a);
    const fichier = harness.storage.objects.get(`exports/${a}/${String(chezA.body.id)}.csv`)?.body;

    expect(fichier).toContain('12000');
    // La recette en espèces du voisin ne doit apparaître nulle part — un total
    // gonflé ressemble exactement à un salon qui aurait fait plus de chiffre.
    expect(fichier).not.toContain('50000');
    expect(fichier).not.toContain('CASH');
  });

  it('nomme le fichier de chacun d’après **son** slug, et son fuseau', async () => {
    const chezA = await creerPour(a);
    const chezB = await creerPour(b);

    expect(chezA.body.filename).toBe('maison-lotus-reporting-2026-09-01_2026-09-30.csv');
    // Le voisin est à Papeete : la même fenêtre d'instants n'y couvre pas les
    // mêmes journées civiles. Une confusion d'établissement se lirait donc dans
    // le nom du fichier lui-même.
    expect(String(chezB.body.filename)).toMatch(/^lagon-bleu-reporting-/);
    expect(chezB.body.filename).not.toBe(chezA.body.filename);
  });
});
