/**
 * L'adresse publique d'un salon — la liste des noms qu'elle ne peut pas porter,
 * et la façon de la composer (#837).
 *
 * ## Ce que cette suite tient, et que rien d'autre ne tient
 *
 * Trois surfaces doivent s'accorder au nom près : la création d'un salon
 * (`slugSchema`), la résolution d'une requête publique
 * (`apps/api/src/common/tenant/public-tenant-request.ts`), et le routage par
 * sous-domaine du front (#838). Elles n'ont plus qu'une seule liste, et c'est
 * ici qu'on vérifie que cette liste dit bien ce qu'elle prétend — ordre,
 * absence de doublon, présence des noms que l'issue nomme.
 *
 * L'autre moitié de la paire est
 * `apps/api/src/common/tenant/__tests__/public-tenant-request.spec.ts`, qui
 * rejoue le refus sur une requête entrante. Les deux ensemble rendent visible le
 * jour où un côté bougerait seul.
 */

import { resourceSlugSchema, slugSchema } from '../common/identifiers';
import {
  DNS_LABEL_PATTERN,
  TENANT_URL_MODES,
  canHostTenantSubdomain,
  isReservedTenantSlug,
  isTenantSubdomainLabel,
  resolveTenantUrlMode,
  tenantBaseHost,
  tenantPublicUrl,
} from '../common/tenant-url';
import { SLUG_MAX_LENGTH } from '../constants/limits';
import { RESERVED_TENANT_SLUGS } from '../constants/reserved-slugs';

describe('RESERVED_TENANT_SLUGS', () => {
  it('porte les noms que #837 nomme, la liste d’avant comprise', () => {
    // La liste d'avant #837, telle qu'elle vivait dans l'API…
    const avant = [
      'admin',
      'api',
      'app',
      'assets',
      'cdn',
      'dev',
      'mail',
      'staging',
      'static',
      'www',
    ];
    // …et ce que le critère 1 y ajoute.
    const ajouts = [
      'origin',
      'console',
      'plateforme',
      'auth',
      'status',
      'support',
      'help',
      'docs',
      'blog',
      'smtp',
      'ftp',
      'm',
    ];

    for (const name of [...avant, ...ajouts]) {
      expect(RESERVED_TENANT_SLUGS).toContain(name);
    }
  });

  it('est triée et sans doublon — c’est ce qui rend un ajout relisible', () => {
    const noms = [...RESERVED_TENANT_SLUGS];
    expect(noms).toEqual([...noms].sort());
    expect(new Set(noms).size).toBe(noms.length);
  });

  it('ne contient que des labels DNS valides', () => {
    // Un nom réservé qui ne serait pas un label DNS ne protégerait rien :
    // aucun slug ne pourrait l'égaler, le motif le refusant déjà.
    for (const name of RESERVED_TENANT_SLUGS) {
      expect(DNS_LABEL_PATTERN.test(name)).toBe(true);
    }
  });

  it('reconnaît un nom réservé, et seulement lui', () => {
    expect(isReservedTenantSlug('origin')).toBe(true);
    expect(isReservedTenantSlug('www')).toBe(true);
    expect(isReservedTenantSlug('maison-lotus')).toBe(false);
    // Aucune correspondance partielle : `api-beaute` est un salon plausible.
    expect(isReservedTenantSlug('api-beaute')).toBe(false);
  });
});

describe('slugSchema — le slug d’un établissement', () => {
  it.each(['maison-lotus', 'spa-lumiere', 'barber-tana', 'salon2', 'a'])(
    '« %s » est accepté',
    (value) => {
      expect(slugSchema.parse(value)).toBe(value);
    },
  );

  it('canonise avant de juger', () => {
    expect(slugSchema.parse('  Maison-Lotus  ')).toBe('maison-lotus');
  });

  it.each(RESERVED_TENANT_SLUGS)('« %s » est refusé : nom réservé', (name) => {
    const parsed = slugSchema.safeParse(name);
    expect(parsed.success).toBe(false);
  });

  it('refuse un nom réservé quelle que soit son écriture', () => {
    // La canonisation passe avant le refus : `WWW` et `  www ` sont le même nom.
    expect(slugSchema.safeParse('WWW').success).toBe(false);
    expect(slugSchema.safeParse('  Origin ').success).toBe(false);
  });

  it('dit lisiblement pourquoi il refuse', () => {
    const parsed = slugSchema.safeParse('origin');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        'ce nom est réservé par la plateforme — choisissez-en un autre',
      );
    }
  });

  it.each([
    ['tiret en tête', '-salon'],
    ['tiret en fin', 'salon-'],
    ['deux tirets', 'salon--lilas'],
    ['underscore', 'salon_lilas'],
    ['majuscule impossible à canoniser', 'salon lilas'],
    ['non ASCII', 'salon-des-lilàs'],
    ['vide', ''],
  ])('%s → refus', (_cas, value) => {
    expect(slugSchema.safeParse(value).success).toBe(false);
  });

  it('refuse le préfixe `xn--` des domaines internationalisés', () => {
    // Punycode (RFC 3492) demande deux tirets consécutifs, que le motif n'accepte
    // pas. Le cas est testé plutôt que déduit : un assouplissement du motif le
    // rouvrirait en silence, et un salon dont le nom d'hôte se résout en un
    // caractère chez le client et en une chaîne chez nous est deux salons pour
    // un seul certificat.
    expect(slugSchema.safeParse('xn--n3h').success).toBe(false);
    expect(slugSchema.safeParse('xn--maison-lotus').success).toBe(false);
  });

  it('accepte exactement 63 caractères et refuse le 64e', () => {
    expect(slugSchema.safeParse('a'.repeat(SLUG_MAX_LENGTH)).success).toBe(true);
    expect(slugSchema.safeParse('a'.repeat(SLUG_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('resourceSlugSchema — le slug d’une rubrique ou d’une prestation', () => {
  it('applique la même forme que le slug d’établissement', () => {
    expect(resourceSlugSchema.parse('soins-visage')).toBe('soins-visage');
    expect(resourceSlugSchema.safeParse('-soins').success).toBe(false);
  });

  it('n’applique pas la liste réservée', () => {
    // Une rubrique nommée `blog` ne devient jamais un nom d'hôte. Lui appliquer
    // la liste ferait refuser **en lecture** une ligne écrite avant #837, et
    // `apps/web/lib/api-client.ts` fait échouer la page entière au moindre refus
    // de schéma de réponse.
    expect(resourceSlugSchema.parse('blog')).toBe('blog');
    expect(resourceSlugSchema.parse('www')).toBe('www');
  });
});

describe('tenantBaseHost', () => {
  it.each([
    ['https://exemple.test', 'exemple.test'],
    ['https://exemple.test/reserver', 'exemple.test'],
    ['http://localhost:3000', 'localhost'],
    ['https://www.exemple.test', 'exemple.test'],
    ['https://EXEMPLE.test', 'exemple.test'],
    ['http://127.0.0.1:3001', '127.0.0.1'],
  ])('%s → %s', (appUrl, expected) => {
    expect(tenantBaseHost(appUrl)).toBe(expected);
  });

  it.each([
    ['URL illisible', 'pas-une-url'],
    ['littéral IPv6', 'http://[::1]:3000'],
  ])('%s → null plutôt qu’une exception', (_cas, appUrl) => {
    expect(tenantBaseHost(appUrl)).toBeNull();
  });
});

describe('canHostTenantSubdomain', () => {
  it.each(['exemple.test', 'reservation.spa-booking.app'])('%s peut en porter un', (host) => {
    expect(canHostTenantSubdomain(host)).toBe(true);
  });

  it.each([
    ['adresse IPv4', '127.0.0.1'],
    ['une seule étiquette', 'localhost'],
    ['littéral IPv6', '[::1]'],
    ['vide', ''],
  ])('%s n’en porte pas', (_cas, host) => {
    expect(canHostTenantSubdomain(host)).toBe(false);
  });
});

describe('resolveTenantUrlMode', () => {
  it('auto suit l’hôte de base', () => {
    expect(resolveTenantUrlMode('https://exemple.test')).toBe('subdomain');
    expect(resolveTenantUrlMode('http://127.0.0.1:3000')).toBe('path');
    expect(resolveTenantUrlMode('http://localhost:3000')).toBe('path');
    expect(resolveTenantUrlMode('pas-une-url')).toBe('path');
  });

  it('un mode explicite n’est jamais contredit par l’hôte', () => {
    expect(resolveTenantUrlMode('http://127.0.0.1:3000', 'subdomain')).toBe('subdomain');
    expect(resolveTenantUrlMode('https://exemple.test', 'path')).toBe('path');
  });

  it('les trois valeurs sont celles du contrat', () => {
    expect([...TENANT_URL_MODES]).toEqual(['auto', 'subdomain', 'path']);
  });
});

describe('tenantPublicUrl', () => {
  it('compose l’adresse sur sous-domaine', () => {
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'https://exemple.test' })).toBe(
      'https://maison-lotus.exemple.test/compte',
    );
  });

  it('retire `www.` comme le fait la lecture d’une requête entrante', () => {
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'https://www.exemple.test' })).toBe(
      'https://maison-lotus.exemple.test/compte',
    );
  });

  it('conserve le port et le protocole de la base', () => {
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'http://exemple.test:3000' })).toBe(
      'http://maison-lotus.exemple.test:3000/compte',
    );
  });

  it('conserve le préfixe de chemin de la base', () => {
    expect(
      tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'https://exemple.test/app/' }),
    ).toBe('https://maison-lotus.exemple.test/app/compte');
  });

  it('retombe sur le chemin là où aucun sous-domaine ne se résout', () => {
    // Le cas des suites d'intégration et de la recette : critère 4.
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'http://127.0.0.1:3000' })).toBe(
      'http://127.0.0.1:3000/maison-lotus/compte',
    );
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'http://localhost:3000' })).toBe(
      'http://localhost:3000/maison-lotus/compte',
    );
  });

  it('respecte un mode forcé dans les deux sens', () => {
    expect(
      tenantPublicUrl('maison-lotus', '/compte', {
        baseUrl: 'https://exemple.test',
        mode: 'path',
      }),
    ).toBe('https://exemple.test/maison-lotus/compte');
    expect(
      tenantPublicUrl('maison-lotus', '/compte', {
        baseUrl: 'http://127.0.0.1:3000',
        mode: 'subdomain',
      }),
    ).toBe('http://maison-lotus.127.0.0.1:3000/compte');
  });

  it('n’écrit jamais un hôte qu’aucun salon ne peut servir', () => {
    // Un slug qui n'est pas un label DNS produirait `salon/évasion.exemple.test`,
    // c'est-à-dire un lien qui n'est même pas une URL. En chemin, il redevient
    // un segment encodable et le lien reste cliquable.
    expect(tenantPublicUrl('salon/évasion', '/compte', { baseUrl: 'https://exemple.test' })).toBe(
      'https://exemple.test/salon%2F%C3%A9vasion/compte',
    );
    // Un label réservé est déjà refusé par la résolution publique : l'écrire
    // serait écrire un lien mort en connaissance de cause.
    expect(tenantPublicUrl('www', '/compte', { baseUrl: 'https://exemple.test' })).toBe(
      'https://exemple.test/www/compte',
    );
  });

  it('accepte un chemin sans barre oblique initiale, et un chemin vide', () => {
    expect(tenantPublicUrl('maison-lotus', 'compte', { baseUrl: 'https://exemple.test' })).toBe(
      'https://maison-lotus.exemple.test/compte',
    );
    expect(tenantPublicUrl('maison-lotus', '', { baseUrl: 'https://exemple.test' })).toBe(
      'https://maison-lotus.exemple.test',
    );
  });

  it('ne lève pas sur une base illisible', () => {
    // Ce constructeur sert à écrire des e-mails : un envoi ne doit pas échouer
    // sur la configuration d'un autre.
    expect(tenantPublicUrl('maison-lotus', '/compte', { baseUrl: 'pas-une-url' })).toBe(
      'pas-une-url/maison-lotus/compte',
    );
  });
});

describe('isTenantSubdomainLabel', () => {
  it.each([
    ['slug ordinaire', 'maison-lotus', true],
    ['nom réservé', 'origin', false],
    ['tiret en tête', '-salon', false],
    ['64 caractères', 'a'.repeat(SLUG_MAX_LENGTH + 1), false],
    ['vide', '', false],
  ])('%s → %s', (_cas, slug, expected) => {
    expect(isTenantSubdomainLabel(slug)).toBe(expected);
  });
});
