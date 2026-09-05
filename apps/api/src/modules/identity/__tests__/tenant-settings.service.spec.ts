import { BusinessRuleError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { UpdateTenantDto } from '../dto/tenant-settings.dto';
import {
  IdentityRepository,
  type OpeningHourRecord,
  type TenantRecord,
  type TenantSettingsChanges,
} from '../identity.repository';
import { TenantSettingsService } from '../tenant-settings.service';

/**
 * Le paramétrage de l'établissement (#343, complété par #416).
 *
 * Quatre décisions se prennent dans ce service, et elles sont toutes ici :
 *
 * 1. **la traduction charge utile → colonnes**, avec la distinction « absent =
 *    ne touche pas » / « `null` = efface » qui, mal tenue, effacerait les
 *    coordonnées d'un salon à chaque enregistrement d'un formulaire partiel ;
 * 2. **l'adresse tout ou rien** — pas de mise à jour partielle, donc pas
 *    d'ancienne rue sous une nouvelle ville ;
 * 3. **le refus des plages incohérentes avant la base**, pour que la saisie
 *    fautive sorte en 422 nommé et non en violation de contrainte, donc en 500 ;
 * 4. **une seule écriture** pour les colonnes et la semaine (#416) : deux appels
 *    successifs laissaient l'adresse commitée quand le remplacement des horaires
 *    échouait.
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

/**
 * Le dépôt tel que ce service s'en sert — deux méthodes, pas une de plus.
 *
 * `Pick` sur le **vrai** type plutôt qu'un objet libre transtypé : le double est
 * alors vérifié méthode par méthode à la compilation. Un changement de signature
 * côté dépôt — celui de #416 en est un — fait rougir cette suite au lieu de la
 * laisser exercer, en vert, un contrat qui n'existe plus.
 */
type TenantSettingsPort = Pick<IdentityRepository, 'findCurrentTenant' | 'updateTenantSettings'>;

interface Harness {
  service: TenantSettingsService;
  /** Les colonnes de la dernière écriture reçue — `undefined` si aucune. */
  changes: () => TenantSettingsChanges | undefined;
  /** Ses horaires — `undefined` si l'écriture n'en portait pas. */
  hours: () => readonly OpeningHourRecord[] | undefined;
  /** Combien d'écritures le dépôt a reçues. Une seule est attendue (#416). */
  writes: () => number;
  /** L'établissement tel que le dépôt le porte **après** écriture. */
  stored: () => TenantRecord | null;
}

interface HarnessOptions {
  /** `false` : l'écriture ne touche aucune ligne — l'établissement a disparu. */
  applied?: boolean;
  /**
   * Panne sur la part « horaires » de l'écriture, les colonnes déjà préparées.
   *
   * C'est la transposition en mémoire de ce que la base ferait sur une violation
   * de contrainte ou une coupure — et la seule façon d'exercer ici le défaut que
   * #416 corrige, puisque le service refuse en amont les plages incohérentes.
   */
  failOpeningHours?: Error;
}

function harnessOver(tenant: TenantRecord | null, options: HarnessOptions = {}): Harness {
  const applied = options.applied ?? true;
  let stored = tenant;
  let lastChanges: TenantSettingsChanges | undefined;
  let lastHours: readonly OpeningHourRecord[] | undefined;
  let writes = 0;

  const port: TenantSettingsPort = {
    findCurrentTenant: jest.fn(async () => stored),
    updateTenantSettings: jest.fn(
      async (input: {
        changes: TenantSettingsChanges;
        openingHours?: readonly OpeningHourRecord[];
      }): Promise<boolean> => {
        writes += 1;
        lastChanges = input.changes;
        lastHours = input.openingHours;

        if (!applied || stored === null) {
          return false;
        }

        // La transaction du vrai dépôt, transposée : l'état suivant se construit
        // à part et ne remplace l'état courant qu'une fois **toutes** les parts
        // de l'écriture passées. Un double qui poserait les colonnes puis les
        // horaires reproduirait le défaut au lieu de l'exposer.
        const next: TenantRecord = { ...stored, ...input.changes };

        if (input.openingHours !== undefined) {
          if (options.failOpeningHours !== undefined) {
            throw options.failOpeningHours;
          }
          next.openingHours = [...input.openingHours];
        }

        stored = next;
        return true;
      },
    ),
  };

  return {
    service: new TenantSettingsService(port as unknown as IdentityRepository),
    changes: () => lastChanges,
    hours: () => lastHours,
    writes: () => writes,
    stored: () => stored,
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
    const harness = harnessOver(FICHE, { applied: false });

    await expect(update(harness, { name: 'Salon' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('n’écrit qu’une fois, colonnes et horaires ensemble', async () => {
    // Le défaut de #416 : `updateTenantSettings` posait les colonnes, puis
    // `replaceOpeningHours` remplaçait la semaine dans sa propre transaction.
    // Deux écritures, donc une fenêtre entre les deux. Une seule demande, c'est
    // zéro fenêtre — l'atomicité de cette demande-là étant tenue par la
    // transaction du dépôt, et non par ce service.
    const harness = harnessOver(FICHE);

    await update(harness, {
      address: { line1: '3 place du Marché', city: 'Lyon', country: 'FR' },
      openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
    });

    expect(harness.writes()).toBe(1);
    expect(harness.changes()).toMatchObject({ addressLine1: '3 place du Marché', city: 'Lyon' });
    expect(harness.hours()).toEqual([{ weekday: 2, startMinute: 540, endMinute: 1140 }]);
  });

  it('laisse l’adresse inchangée quand le remplacement des horaires échoue', async () => {
    // Le critère de #416, et ce que l'ancien code ne tenait pas : l'adresse
    // était commitée par la première écriture, la semaine échouait dans la
    // seconde, et la réponse n'était jamais rendue. Le salon se retrouvait avec
    // une adresse qu'il n'avait pas vue s'enregistrer.
    const panne = new Error('remplacement des horaires refusé par la base');
    const harness = harnessOver(FICHE, { failOpeningHours: panne });

    await expect(
      update(harness, {
        address: { line1: '3 place du Marché', city: 'Lyon', country: 'FR' },
        openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
      }),
    ).rejects.toBe(panne);

    expect(harness.stored()).toMatchObject({
      addressLine1: null,
      city: null,
      openingHours: [],
    });
  });

  it('n’offre plus d’écriture séparée des horaires', () => {
    // La surface **est** la garantie : tant qu'une méthode publique écrit la
    // semaine seule, un second appelant peut refaire les deux allers-retours de
    // #416 sans que rien ne le signale. La refermer est le correctif ; ce test
    // est ce qui empêche de la rouvrir par commodité.
    expect(IdentityRepository.prototype).not.toHaveProperty('replaceOpeningHours');
    expect(IdentityRepository.prototype.updateTenantSettings).toHaveLength(1);
  });

  it('ne prend aucun établissement en paramètre', () => {
    // Même propriété que `PublicTenantService` : il n'existe pas de signature
    // par laquelle un appelant désignerait un autre établissement.
    expect(TenantSettingsService.prototype.currentTenant).toHaveLength(0);
    expect(TenantSettingsService.prototype.update).toHaveLength(1);
  });
});
