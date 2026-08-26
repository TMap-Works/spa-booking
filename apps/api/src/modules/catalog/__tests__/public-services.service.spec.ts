import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import { PublicServicesService } from '../public-services.service';
import { ServiceStaffService } from '../service-staff.service';
import { FakeCatalogRepository } from './catalog.doubles';

/**
 * Le catalogue **public** — le quatrième critère de #25 : « le catalogue public
 * expose, par service, les praticiens qui le pratiquent ».
 *
 * Deux propriétés se jouent ici, et elles vont dans des sens opposés : la page
 * doit montrer assez pour qu'un visiteur choisisse son praticien, et rien de
 * plus. Les cas ci-dessous tiennent les deux bouts — ce qui apparaît, et ce qui
 * ne doit surtout pas apparaître.
 *
 * L'établissement vient de la portée ouverte par `TenantScopeMiddleware` après
 * résolution du slug d'URL. Le service n'a aucun paramètre d'établissement : les
 * tests ouvrent donc la portée exactement comme le middleware le fait.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

describe('PublicServicesService', () => {
  let repository: FakeCatalogRepository;
  let publicServices: PublicServicesService;
  let assignments: ServiceStaffService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    publicServices = new PublicServicesService(repository.asRepository());
    assignments = new ServiceStaffService(repository.asRepository());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  it('expose, par prestation, les praticiens qui la pratiquent', async () => {
    const massage = repository.seedService({
      tenantId: TENANT_A,
      name: 'Massage 60 min',
      slug: 'massage-60-min',
    });
    const alix = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Alix' });
    const zoe = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Zoé' });
    await inTenantA(async () => assignments.assign(massage.id, zoe.id));
    await inTenantA(async () => assignments.assign(massage.id, alix.id));

    const [service] = await inTenantA(async () => publicServices.list());

    expect(service?.staff).toEqual([
      { id: alix.id, displayName: 'Alix' },
      { id: zoe.id, displayName: 'Zoé' },
    ]);
  });

  it('rend la prestation sans praticien plutôt que de l’escamoter', async () => {
    repository.seedService({ tenantId: TENANT_A, name: 'Coupe', slug: 'coupe' });

    const catalogue = await inTenantA(async () => publicServices.list());

    expect(catalogue).toHaveLength(1);
    expect(catalogue[0]?.staff).toEqual([]);
  });

  it('recompose le prix en montant entier et devise, jamais en flottant', async () => {
    repository.seedService({
      tenantId: TENANT_A,
      priceAmountMinor: 3500,
      priceCurrency: 'EUR',
    });

    const [service] = await inTenantA(async () => publicServices.list());

    expect(service?.price).toEqual({ amountMinor: 3500, currency: 'EUR' });
  });

  /**
   * Ce que la page publique ne doit **pas** porter.
   *
   * Les tampons sont des temps de cabine — la cadence interne du salon — et
   * `occupiedMinutes` les redonnerait par soustraction. Le test les nomme un par
   * un plutôt que de comparer la forme entière : ajouter un champ légitime ne
   * doit pas casser ce test, en republier un interne doit le casser.
   */
  it('ne publie ni les tampons, ni la durée occupée, ni le drapeau d’activité', async () => {
    repository.seedService({
      tenantId: TENANT_A,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 15,
    });

    const [service] = await inTenantA(async () => publicServices.list());

    expect(service).not.toHaveProperty('bufferBeforeMinutes');
    expect(service).not.toHaveProperty('bufferAfterMinutes');
    expect(service).not.toHaveProperty('occupiedMinutes');
    expect(service).not.toHaveProperty('isActive');
    expect(service).not.toHaveProperty('tenantId');
  });

  it('tait la prestation retirée du catalogue', async () => {
    repository.seedService({ tenantId: TENANT_A, slug: 'active', name: 'Active' });
    repository.seedService({
      tenantId: TENANT_A,
      slug: 'retiree',
      name: 'Retirée',
      isActive: false,
    });

    const catalogue = await inTenantA(async () => publicServices.list());

    expect(catalogue.map((service) => service.slug)).toEqual(['active']);
  });

  /**
   * Un praticien désactivé ne prend plus de rendez-vous : le proposer au choix
   * mènerait à un créneau qu'aucun agenda ne peut honorer. L'affectation, elle,
   * survit — c'est ce que le back-office continue de montrer.
   */
  it('retire le praticien désactivé du choix public, sans perdre l’affectation', async () => {
    const service = repository.seedService({ tenantId: TENANT_A });
    const partant = repository.seedStaff({ tenantId: TENANT_A, displayName: 'Partant' });
    await inTenantA(async () => assignments.assign(service.id, partant.id));

    const staffRow = repository.staff.find((member) => member.id === partant.id);
    expect(staffRow).toBeDefined();
    if (staffRow !== undefined) {
      staffRow.isActive = false;
    }

    const [publie] = await inTenantA(async () => publicServices.list());
    const backOffice = await inTenantA(async () => assignments.list(service.id));

    expect(publie?.staff).toEqual([]);
    expect(backOffice).toHaveLength(1);
  });

  describe('isolation inter-tenant', () => {
    it('ne rend que le catalogue de l’établissement de la requête', async () => {
      repository.seedService({ tenantId: TENANT_A, slug: 'chez-a', name: 'Chez A' });
      repository.seedService({ tenantId: TENANT_B, slug: 'chez-b', name: 'Chez B' });

      const chezA = await inTenantA(async () => publicServices.list());
      const chezB = await inTenantB(async () => publicServices.list());

      expect(chezA.map((service) => service.slug)).toEqual(['chez-a']);
      expect(chezB.map((service) => service.slug)).toEqual(['chez-b']);
    });

    it('ne publie pas un praticien du voisin, même sur une affectation croisée', async () => {
      const service = repository.seedService({ tenantId: TENANT_A });
      const etranger = repository.seedStaff({ tenantId: TENANT_B, displayName: 'Voisin' });
      // Ligne que les clés étrangères composites rendent impossible en base.
      repository.seedAssignment({
        tenantId: TENANT_B,
        serviceId: service.id,
        staffId: etranger.id,
      });

      const [publie] = await inTenantA(async () => publicServices.list());

      expect(publie?.staff).toEqual([]);
    });

    it('refuse de lire hors portée de tenant — jamais « tout le catalogue »', async () => {
      repository.seedService({ tenantId: TENANT_A });

      await expect(publicServices.list()).rejects.toThrow(/aucun tenant courant/);
    });
  });
});
