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

/**
 * L'établissement tel que la base le rend — **sans adresse ni horaires**.
 *
 * C'est délibérément l'état d'un salon fraîchement inscrit, et celui de tous les
 * établissements déjà en base au moment de la migration #343. Les cas qui
 * veulent une adresse la posent en surcharge : la forme par défaut est celle
 * dont le critère exige qu'elle reste servie.
 */
const FICHE: PublicTenantRecord = {
  id: TENANT_A,
  slug: 'salon-des-lilas',
  name: 'Salon des Lilas',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  contactEmail: 'contact@salon-des-lilas.test',
  contactPhone: '+33100000000',
  addressLine1: null,
  addressLine2: null,
  postalCode: null,
  city: null,
  countryCode: null,
  openingHours: [],
};

/** L'adresse complète du même salon, telle que la base la stocke. */
const ADRESSE = {
  addressLine1: '12 rue des Lilas',
  addressLine2: 'Bâtiment B',
  postalCode: '75011',
  city: 'Paris',
  countryCode: 'FR',
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

    expect(vitrine).toEqual({
      id: FICHE.id,
      slug: FICHE.slug,
      name: FICHE.name,
      timezone: FICHE.timezone,
      defaultCurrency: FICHE.defaultCurrency,
      contactEmail: FICHE.contactEmail,
      contactPhone: FICHE.contactPhone,
    });
  });

  it('n’expose que les champs de la vitrine — la liste est close', async () => {
    // Une égalité de clés, et non un `toMatchObject` : un champ ajouté par
    // mégarde à la projection du repository — `isActive`, un compteur, une date
    // technique — doit faire échouer ce test, pas passer inaperçu. C'est la
    // seule barrière automatique entre « lu en base » et « publié ».
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({
        ...FICHE,
        ...ADRESSE,
        // Ce que le jour où quelqu'un élargit le `select` ferait arriver ici.
        ...({
          openingHours: [{ weekday: 2, startMinute: 540, endMinute: 1140 }],
          isActive: true,
          createdAt: new Date(),
        } as unknown as PublicTenantRecord),
      }).currentTenant(),
    );

    expect(Object.keys(vitrine).sort()).toEqual([
      'address',
      'contactEmail',
      'contactPhone',
      'defaultCurrency',
      'id',
      'name',
      'openingHours',
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

  it('sert un salon sans adresse ni horaires, sans les clés correspondantes', async () => {
    // Le critère de #343 : un salon qui n'a rien saisi **reste servi**, et sa
    // vitrine a rigoureusement la forme qu'elle avait avant que ces champs
    // n'existent. Un front antérieur à la migration continue donc de la valider.
    const vitrine = await runWithTenant(TENANT_A, async () => serviceOver(FICHE).currentTenant());

    expect(vitrine.address).toBeUndefined();
    expect(vitrine.openingHours).toBeUndefined();
    expect(Object.keys(vitrine)).not.toContain('address');
    expect(Object.keys(vitrine)).not.toContain('openingHours');
  });

  it('compose l’adresse depuis ses colonnes, complément et code postal omis s’ils manquent', async () => {
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({
        ...FICHE,
        ...ADRESSE,
        addressLine2: null,
        postalCode: null,
      }).currentTenant(),
    );

    expect(vitrine.address).toEqual({
      line1: '12 rue des Lilas',
      city: 'Paris',
      country: 'FR',
    });
  });

  it('n’expose pas d’adresse quand le triplet minimal est incomplet', async () => {
    // La base l'interdit (`tenants_address_completeness_check`), mais le type de
    // la ligne lue ne dit pas que les trois colonnes vont ensemble. Une adresse
    // sans ville produirait un `PostalAddress` incomplet dans le JSON-LD, ce que
    // la page publique refuse par principe d'inventer.
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({ ...FICHE, ...ADRESSE, city: null }).currentTenant(),
    );

    expect(vitrine.address).toBeUndefined();
  });

  it('rend les horaires en heures murales, minuit compris', async () => {
    // La base compte en minutes depuis minuit local ; l'API rend une horloge.
    // `1440` est la seule façon exacte de dire « ferme à minuit » : `23:59`
    // perdrait une minute, et le dernier créneau de la soirée avec elle.
    const vitrine = await runWithTenant(TENANT_A, async () =>
      serviceOver({
        ...FICHE,
        openingHours: [
          { weekday: 2, startMinute: 540, endMinute: 720 },
          { weekday: 2, startMinute: 840, endMinute: 1140 },
          { weekday: 6, startMinute: 1080, endMinute: 1440 },
        ],
      }).currentTenant(),
    );

    expect(vitrine.openingHours).toEqual([
      { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
      { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
      { weekday: 6, opensAt: '18:00', closesAt: '24:00' },
    ]);
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
