import { MAX_REPORT_EXPORT_TTL_SECONDS } from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { ReportExportConfig } from '../export/report-export.config';
import { ReportExportService } from '../export/report-export.service';
import { ReportExportUnavailableError, ReportWindowInvalidError } from '../reporting.errors';
import { ReportingService } from '../reporting.service';
import type { ReportWindow } from '../reporting.types';
import { FakeReportExportStorage } from './report-export.doubles';
import { asReportingRepository, FakeReportingRepository } from './reporting.doubles';

/**
 * Ce que `ReportExportService` décide — #563.
 *
 * Le dépôt et l'entrepôt sont des doubles : ce qui est éprouvé ici est ce que
 * le service **ajoute**, et rien d'autre. Quatre choses, et chacune casse en
 * silence si personne ne la garde :
 *
 * 1. la clé déposée est **préfixée par l'établissement du contexte**, jamais par
 *    autre chose ;
 * 2. la fenêtre est validée **avant** tout dépôt — un 422 ne laisse pas de
 *    fichier derrière lui ;
 * 3. la re-signature vérifie l'existence sous le préfixe de l'appelant, d'où le
 *    404 du voisin ;
 * 4. la durée de vie annoncée est celle qui a été signée, et elle est bornée.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const VOISIN = '22222222-2222-4222-8222-222222222222';

/** Septembre 2026 tel qu'un salon parisien le vit. */
const SEPTEMBRE: ReportWindow = {
  from: new Date('2026-08-31T22:00:00Z'),
  to: new Date('2026-09-30T22:00:00Z'),
};

interface Montage {
  readonly service: ReportExportService;
  readonly storage: FakeReportExportStorage;
  readonly repository: FakeReportingRepository;
}

function monter(env: NodeJS.ProcessEnv = { REPORT_EXPORT_BUCKET: 'spa-test-exports' }): Montage {
  const repository = new FakeReportingRepository();
  repository.seedTenant(TENANT, 'Europe/Paris', 'maison-lotus');
  repository.seedTenant(VOISIN, 'Pacific/Tahiti', 'lagon-bleu');

  const storage = new FakeReportExportStorage();
  const service = new ReportExportService(
    new ReportingService(asReportingRepository(repository)),
    asReportingRepository(repository),
    new ReportExportConfig(env),
    storage,
  );

  return { service, storage, repository };
}

describe('ReportExportService.create', () => {
  it('dépose le fichier sous une clé préfixée par le tenant du contexte', async () => {
    const { service, storage } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));

    expect([...storage.objects.keys()]).toEqual([`exports/${TENANT}/${produit.id}.csv`]);
  });

  it('nomme le fichier d’après le slug de l’établissement et la période couverte', async () => {
    const { service } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));

    expect(produit.filename).toBe('maison-lotus-reporting-2026-09-01_2026-09-30.csv');
  });

  it('dépose un CSV, et le déclare comme tel', async () => {
    const { service, storage } = monter();

    await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const [objet] = [...storage.objects.values()];

    expect(objet?.contentType).toBe('text/csv;charset=utf-8');
    expect(objet?.body).toContain('section;cle;libelle;mesure;valeur;devise');
  });

  it('tire une clé différente à chaque appel — deux exports ne s’écrasent pas', async () => {
    const { service, storage } = monter();

    const premier = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const second = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));

    expect(premier.id).not.toBe(second.id);
    expect(storage.objects.size).toBe(2);
  });

  it('refuse une fenêtre invalide **avant** de déposer quoi que ce soit', async () => {
    const { service, storage } = monter();

    await expect(
      runWithTenant(TENANT, async () =>
        service.create({ from: SEPTEMBRE.to, to: SEPTEMBRE.from }),
      ),
    ).rejects.toBeInstanceOf(ReportWindowInvalidError);
    // Un 422 qui laisserait un fichier derrière lui remplirait le bucket de
    // fichiers que personne ne réclamera jamais.
    expect(storage.objects.size).toBe(0);
  });

  it('rend 404 quand l’établissement a disparu sous la requête', async () => {
    const { service } = monter();
    const inconnu = '33333333-3333-4333-8333-333333333333';

    await expect(
      runWithTenant(inconnu, async () => service.create(SEPTEMBRE)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuse en 503 sur un environnement sans entrepôt', async () => {
    const { service } = monter({});

    await expect(runWithTenant(TENANT, async () => service.create(SEPTEMBRE))).rejects.toBeInstanceOf(
      ReportExportUnavailableError,
    );
  });

  it('signe pour la durée de vie configurée, et annonce l’échéance qui va avec', async () => {
    const { service, storage } = monter({
      REPORT_EXPORT_BUCKET: 'spa-test-exports',
      REPORT_EXPORT_URL_TTL_SECONDS: '300',
    });

    const avant = Date.now();
    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const apres = Date.now();

    expect(storage.signatures.at(-1)?.ttlSeconds).toBe(300);
    const echeance = Date.parse(produit.expiresAt);
    expect(echeance).toBeGreaterThanOrEqual(avant + 300_000);
    expect(echeance).toBeLessThanOrEqual(apres + 300_000);
  });

  it('ne signe jamais au-delà du plafond du contrat', async () => {
    const { service, storage } = monter();

    await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));

    expect(storage.signatures.at(-1)?.ttlSeconds).toBeLessThanOrEqual(
      MAX_REPORT_EXPORT_TTL_SECONDS,
    );
  });
});

describe('ReportExportService.resign', () => {
  it('re-signe l’export de l’appelant sans reproduire le fichier', async () => {
    const { service, storage } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const resigne = await runWithTenant(TENANT, async () => service.resign(produit.id));

    expect(resigne.id).toBe(produit.id);
    // Un seul objet : c'est *le* point de cette route.
    expect(storage.objects.size).toBe(1);
  });

  it('rend le fichier sous le nom du dépôt, jamais sous son identifiant technique', async () => {
    const { service, storage } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const resigne = await runWithTenant(TENANT, async () => service.resign(produit.id));

    // `ResponseContentDisposition` d'une URL présignée **l'emporte** sur
    // l'en-tête posé sur l'objet : un nom improvisé ici ne serait pas un repli,
    // ce serait le nom sous lequel le fichier atterrit.
    expect(resigne.filename).toBe(produit.filename);
    expect(storage.signatures.at(-1)?.filename).toBe(produit.filename);
  });

  it('rend 404 à l’établissement voisin qui présente un identifiant volé', async () => {
    const { service } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));

    // Ni 403, ni l'URL, ni la donnée : la clé est recomposée sous le préfixe du
    // voisin, où cet objet n'existe pas (tenant-isolation §4).
    await expect(
      runWithTenant(VOISIN, async () => service.resign(produit.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ne signe rien pour le voisin — pas même une URL vers une clé absente', async () => {
    const { service, storage } = monter();

    const produit = await runWithTenant(TENANT, async () => service.create(SEPTEMBRE));
    const signaturesAvant = storage.signatures.length;

    await expect(runWithTenant(VOISIN, async () => service.resign(produit.id))).rejects.toThrow();

    // `getSignedUrl` ne parle à personne : il signerait joyeusement la clé d'un
    // objet absent. Sans la vérification d'existence, la route rendrait une URL
    // à tout le monde et la fuite ne se verrait qu'au moment de la suivre.
    expect(storage.signatures).toHaveLength(signaturesAvant);
  });

  it('rend 404 sur un identifiant qui n’a jamais existé', async () => {
    const { service } = monter();

    await expect(
      runWithTenant(TENANT, async () => service.resign('44444444-4444-4444-8444-444444444444')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuse en 503 sur un environnement sans entrepôt', async () => {
    const { service } = monter({});

    await expect(
      runWithTenant(TENANT, async () => service.resign('44444444-4444-4444-8444-444444444444')),
    ).rejects.toBeInstanceOf(ReportExportUnavailableError);
  });
});
