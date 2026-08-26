import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { IdentityRepository, PublicTenantRecord } from '../identity.repository';
import { PublicTenantService } from '../public-tenant.service';

/**
 * Ce que la vitrine publique rend — et surtout ce qu'elle ne rend pas.
 *
 * Le service n'a aucun paramètre d'établissement : il lit celui de la portée.
 * Ces tests portent donc sur la **projection**, qui est la seule décision qu'il
 * prend, et c'est celle qui porte le critère « les endpoints publics n'exposent
 * que les données destinées au public ».
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';

const FICHE: PublicTenantRecord = {
  id: TENANT_A,
  slug: 'salon-des-lilas',
  name: 'Salon des Lilas',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  contactEmail: 'contact@salon-des-lilas.test',
  contactPhone: '+33100000000',
};

function serviceOver(tenant: PublicTenantRecord | null): PublicTenantService {
  const repository = {
    findCurrentPublicTenant: jest.fn(async () => tenant),
  } as unknown as IdentityRepository;
  return new PublicTenantService(repository);
}

describe('PublicTenantService', () => {
  it('rend la vitrine de l’établissement de la portée', async () => {
    const vitrine = await runWithTenant(TENANT_A, async () => serviceOver(FICHE).currentTenant());

    expect(vitrine).toEqual(FICHE);
  });

  it('n’expose que les champs de la vitrine — la liste est close', async () => {
    // Une égalité de clés, et non un `toMatchObject` : un champ ajouté par
    // mégarde à la projection du repository — `isActive`, un compteur, une date
    // technique — doit faire échouer ce test, pas passer inaperçu. C'est la
    // seule barrière automatique entre « lu en base » et « publié ».
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({
        ...FICHE,
        // Ce que le jour où quelqu'un élargit le `select` ferait arriver ici.
        ...({ isActive: true, createdAt: new Date() } as unknown as PublicTenantRecord),
      }).currentTenant(),
    );

    expect(Object.keys(vitrine).sort()).toEqual([
      'contactEmail',
      'contactPhone',
      'defaultCurrency',
      'id',
      'name',
      'slug',
      'timezone',
    ]);
    expect(JSON.stringify(vitrine)).not.toContain('isActive');
  });

  it('omet les contacts absents au lieu de les rendre à `null`', async () => {
    // `publicTenantSchema` les déclare `.optional()` : le front valide les
    // réponses contre ce schéma, et un `null` y ferait échouer la validation de
    // tout salon sans coordonnées — le cas le plus courant à l'inscription.
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({ ...FICHE, contactEmail: null, contactPhone: null }).currentTenant(),
    );

    expect(vitrine.contactEmail).toBeUndefined();
    expect(vitrine.contactPhone).toBeUndefined();
    // `undefined` disparaît à la sérialisation : la clé est absente du corps.
    expect(JSON.parse(JSON.stringify(vitrine))).toEqual({
      id: FICHE.id,
      slug: FICHE.slug,
      name: FICHE.name,
      timezone: FICHE.timezone,
      defaultCurrency: FICHE.defaultCurrency,
    });
  });

  it('rend un 404 si l’établissement a disparu entre la résolution et la lecture', async () => {
    // Le seul chemin par lequel `null` arrive : un salon supprimé entre les deux
    // lectures. La réponse juste est celle d'un slug inconnu.
    await runWithTenant(TENANT_A, async () => {
      await expect(serviceOver(null).currentTenant()).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('ne prend aucun établissement en paramètre', () => {
    // La propriété qui compte, vérifiée sur la signature elle-même : il n'existe
    // pas de façon d'appeler ce service en désignant un autre établissement que
    // celui de la portée.
    expect(PublicTenantService.prototype.currentTenant).toHaveLength(0);
  });
});
