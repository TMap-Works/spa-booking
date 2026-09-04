import { BusinessRuleError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { UpdateTenantDto } from '../dto/tenant-settings.dto';
import type {
  IdentityRepository,
  OpeningHourRecord,
  TenantRecord,
  TenantSettingsChanges,
} from '../identity.repository';
import { TenantSettingsService } from '../tenant-settings.service';

/**
 * Le paramétrage de l'établissement (#343).
 *
 * Trois décisions se prennent dans ce service, et elles sont toutes ici :
 *
 * 1. **la traduction charge utile → colonnes**, avec la distinction « absent =
 *    ne touche pas » / « `null` = efface » qui, mal tenue, effacerait les
 *    coordonnées d'un salon à chaque enregistrement d'un formulaire partiel ;
 * 2. **l'adresse tout ou rien** — pas de mise à jour partielle, donc pas
 *    d'ancienne rue sous une nouvelle ville ;
 * 3. **le refus des plages incohérentes avant la base**, pour que la saisie
 *    fautive sorte en 422 nommé et non en violation de contrainte, donc en 500.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';

const FICHE: TenantRecord = {
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
  isActive: true,
};

interface Harness {
  service: TenantSettingsService;
  changes: () => TenantSettingsChanges | undefined;
  hours: () => readonly OpeningHourRecord[] | undefined;
}

function harnessOver(tenant: TenantRecord | null, applied = true): Harness {
  let lastChanges: TenantSettingsChanges | undefined;
  let lastHours: readonly OpeningHourRecord[] | undefined;

  const repository = {
    findCurrentTenant: jest.fn(async () => tenant),
    updateTenantSettings: jest.fn(async (changes: TenantSettingsChanges) => {
      lastChanges = changes;
      return applied;
    }),
    replaceOpeningHours: jest.fn(async (entries: readonly OpeningHourRecord[]) => {
      lastHours = entries;
    }),
  } as unknown as IdentityRepository;

  return {
    service: new TenantSettingsService(repository),
    changes: () => lastChanges,
    hours: () => lastHours,
  };
}

async function update(harness: Harness, body: UpdateTenantDto): Promise<void> {
  await runWithTenant(TENANT_A, async () => harness.service.update(body));
}

describe('TenantSettingsService', () => {
  it('rend la vitrine et l’état d’activation', async () => {
    const reglages = await runWithTenant(TENANT_A, async () =>
      harnessOver(FICHE).service.currentTenant(),
    );

    expect(reglages.isActive).toBe(true);
    expect(Object.keys(reglages).sort()).toEqual([
      'contactEmail',
      'contactPhone',
      'defaultCurrency',
      'id',
      'isActive',
      'name',
      'slug',
      'timezone',
    ]);
  });

  it('ne touche pas aux champs absents de la charge utile', async () => {
    // La propriété qui coûte cher si elle est ratée : un écran qui n'affiche que
    // l'adresse ne doit pas effacer le téléphone en enregistrant.
    const harness = harnessOver(FICHE);
    await update(harness, { name: 'Salon des Lilas — Bastille' });

    expect(harness.changes()).toEqual({ name: 'Salon des Lilas — Bastille' });
  });

  it('efface un contact sur un `null` explicite', async () => {
    const harness = harnessOver(FICHE);
    await update(harness, { contactPhone: null });

    expect(harness.changes()).toEqual({ contactPhone: null });
  });

  it('pose les cinq colonnes d’adresse d’un coup, complément absent remis à `null`', async () => {
    // Pas de mise à jour partielle d'adresse : sans cela, poser une nouvelle rue
    // sans complément garderait l'ancien « Bâtiment B » sous la nouvelle voie.
    const harness = harnessOver(FICHE);
    await update(harness, {
      address: { line1: '3 place du Marché', city: 'Lyon', country: 'FR' },
    });

    expect(harness.changes()).toEqual({
      addressLine1: '3 place du Marché',
      addressLine2: null,
      postalCode: null,
      city: 'Lyon',
      countryCode: 'FR',
    });
  });

  it('efface les cinq colonnes d’adresse sur `address: null`', async () => {
    const harness = harnessOver(FICHE);
    await update(harness, { address: null });

    expect(harness.changes()).toEqual({
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
    });
  });

  it('convertit les heures murales en minutes locales, minuit compris', async () => {
    const harness = harnessOver(FICHE);
    await update(harness, {
      openingHours: [
        { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
        { weekday: 6, opensAt: '18:00', closesAt: '24:00' },
      ],
    });

    expect(harness.hours()).toEqual([
      { weekday: 2, startMinute: 540, endMinute: 720 },
      { weekday: 6, startMinute: 1080, endMinute: 1440 },
    ]);
  });

  it('ne touche pas aux horaires quand la charge utile ne les porte pas', async () => {
    // `openingHours` absent n'est pas « efface les horaires » : ce serait vider
    // la semaine publiée à chaque enregistrement d'un autre champ.
    const harness = harnessOver(FICHE);
    await update(harness, { name: 'Salon des Lilas' });

    expect(harness.hours()).toBeUndefined();
  });

  it('efface la semaine publiée sur un tableau vide', async () => {
    const harness = harnessOver(FICHE);
    await update(harness, { openingHours: [] });

    expect(harness.hours()).toEqual([]);
  });

  it('refuse une fermeture antérieure à l’ouverture, sans rien avoir écrit', async () => {
    // La base la refuserait aussi (`tenant_opening_hours_minutes_check`), mais
    // en violation de contrainte brute : 500 sur une saisie fautive, là où le
    // contrat annonce 422.
    //
    // Le `name` de la charge utile est ce qui compte ici : un contrôle fait
    // après l'écriture des colonnes rendrait le 422 attendu **et** garderait le
    // nouveau nom. L'écran annoncerait un refus, et la moitié de la saisie
    // serait passée quand même.
    const harness = harnessOver(FICHE);

    await expect(
      update(harness, {
        name: 'Salon des Lilas — Bastille',
        openingHours: [{ weekday: 2, opensAt: '19:00', closesAt: '09:00' }],
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    expect(harness.hours()).toBeUndefined();
    expect(harness.changes()).toBeUndefined();
  });

  it('refuse deux plages du même jour qui se recouvrent', async () => {
    const harness = harnessOver(FICHE);

    await expect(
      update(harness, {
        openingHours: [
          { weekday: 2, opensAt: '09:00', closesAt: '13:00' },
          { weekday: 2, opensAt: '12:00', closesAt: '19:00' },
        ],
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it('accepte deux plages adjacentes du même jour', async () => {
    // « 09:00–12:00 » puis « 12:00–19:00 » décrivent une journée continue en
    // deux morceaux : la borne haute est exclue, elles ne se recouvrent pas.
    const harness = harnessOver(FICHE);

    await update(harness, {
      openingHours: [
        { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
        { weekday: 2, opensAt: '12:00', closesAt: '19:00' },
      ],
    });

    expect(harness.hours()).toHaveLength(2);
  });

  it('accepte les mêmes heures sur deux jours différents', async () => {
    const harness = harnessOver(FICHE);

    await update(harness, {
      openingHours: [
        { weekday: 2, opensAt: '09:00', closesAt: '19:00' },
        { weekday: 3, opensAt: '09:00', closesAt: '19:00' },
      ],
    });

    expect(harness.hours()).toHaveLength(2);
  });

  it('rend un 404 si l’établissement a disparu', async () => {
    await runWithTenant(TENANT_A, async () => {
      await expect(harnessOver(null).service.currentTenant()).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('rend un 404 si l’écriture ne touche aucune ligne', async () => {
    // Un établissement supprimé entre la résolution du jeton et l'écriture :
    // sans ce contrôle, la réponse serait un 200 sur une mise à jour sans effet.
    const harness = harnessOver(FICHE, false);

    await expect(update(harness, { name: 'Salon' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ne prend aucun établissement en paramètre', () => {
    // Même propriété que `PublicTenantService` : il n'existe pas de signature
    // par laquelle un appelant désignerait un autre établissement.
    expect(TenantSettingsService.prototype.currentTenant).toHaveLength(0);
    expect(TenantSettingsService.prototype.update).toHaveLength(1);
  });
});
