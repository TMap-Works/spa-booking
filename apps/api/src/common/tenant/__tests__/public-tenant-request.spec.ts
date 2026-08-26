import { API_DEFAULT_VERSION, API_PREFIX } from '../../../bootstrap';
import {
  describePublicTenantRequest,
  publicBaseHost,
  PUBLIC_ROUTE_SEGMENT,
  readSubdomainSlug,
} from '../public-tenant-request';

/**
 * La lecture de la désignation publique est la **seule** logique du chemin
 * public qui manipule de l'entrée non vérifiée. Elle est donc exercée ici cas
 * par cas, sans HTTP ni base — ce que la séparation en fonctions pures rend
 * possible.
 *
 * Ce qui compte n'est pas qu'elle trouve le bon slug sur le cas nominal, mais
 * qu'elle refuse tout le reste : c'est le refus qui tient le critère « un slug
 * inconnu renvoie 404 avant d'atteindre le contrôleur ».
 */

const BASE = 'exemple.test';

describe('describePublicTenantRequest', () => {
  describe('hors de l’espace public, rien n’est désigné', () => {
    it.each([
      ['/health'],
      ['/api/v1/auth/login'],
      ['/api/v1/users'],
      ['/api/docs'],
      ['/'],
      // « public » n'est pas un préfixe : `publicity` est une autre route.
      ['/api/v1/publicity/salon-des-lilas'],
      // Le segment doit venir juste après la version.
      ['/api/public/salon-des-lilas'],
      ['/public/salon-des-lilas'],
    ])('%s ouvre une portée vide', (url) => {
      expect(describePublicTenantRequest(url, `salon-des-lilas.${BASE}`, BASE)).toEqual({
        kind: 'none',
      });
    });

    it('ne désigne rien même quand l’hôte porte un slug valide', () => {
      // Le point de la règle : sur une route authentifiée, l'en-tête `Host` —
      // que le client fournit — ne doit avoir aucune influence sur le tenant.
      const designation = describePublicTenantRequest(
        '/api/v1/users',
        `barbier-du-port.${BASE}`,
        BASE,
      );
      expect(designation.kind).toBe('none');
    });
  });

  describe('le slug d’URL désigne l’établissement', () => {
    it.each([
      ['/api/v1/public/salon-des-lilas', 'salon-des-lilas'],
      ['/api/v1/public/salon-des-lilas/', 'salon-des-lilas'],
      ['/api/v1/public/salon-des-lilas/services', 'salon-des-lilas'],
      ['/api/v1/public/salon-des-lilas?date=2026-09-01', 'salon-des-lilas'],
      ['/api/v1/public/salon-des-lilas#ancre', 'salon-des-lilas'],
      // Le versionnement n'est pas figé à `v1`.
      ['/api/v2/public/salon-des-lilas', 'salon-des-lilas'],
      // Casse et encodage : deux écritures du même chemin, une seule réponse.
      ['/api/v1/public/Salon-Des-Lilas', 'salon-des-lilas'],
      // Express route sans tenir compte de la casse : ces deux chemins
      // atteignent le contrôleur public. S'ils n'étaient pas reconnus ici, la
      // portée resterait vide et le repository répondrait 500.
      ['/api/v1/PUBLIC/salon-des-lilas', 'salon-des-lilas'],
      ['/API/V1/Public/salon-des-lilas', 'salon-des-lilas'],
      ['/api/v1/public/salon-des-lilas%2F', null],
      ['/api/v1/public/%73alon-des-lilas', 'salon-des-lilas'],
    ])('%s → %s', (url, slug) => {
      const designation = describePublicTenantRequest(url, undefined, BASE);
      if (slug === null) {
        expect(designation).toEqual({ kind: 'unresolvable' });
        return;
      }
      expect(designation).toEqual({ kind: 'slug', slug, source: 'path' });
    });
  });

  describe('une désignation illisible est refusée, jamais devinée', () => {
    it.each([
      ['sans slug', '/api/v1/public'],
      ['slug vide', '/api/v1/public/'],
      ['espaces seuls', '/api/v1/public/%20%20'],
      ['majuscules et underscore', '/api/v1/public/salon_des_lilas'],
      ['point — tentative de traversée', '/api/v1/public/..'],
      ['tiret en tête', '/api/v1/public/-salon'],
      ['double tiret', '/api/v1/public/salon--lilas'],
      ['caractères non ASCII', '/api/v1/public/salon-des-lilàs'],
      ['encodage invalide', '/api/v1/public/%zz'],
      ['au-delà de VARCHAR(63)', `/api/v1/public/${'a'.repeat(64)}`],
    ])('%s → refus', (_cas, url) => {
      expect(describePublicTenantRequest(url, undefined, BASE)).toEqual({ kind: 'unresolvable' });
    });

    it('accepte exactement 63 caractères — la borne de `Tenant.slug`', () => {
      const slug = 'a'.repeat(63);
      expect(describePublicTenantRequest(`/api/v1/public/${slug}`, undefined, BASE)).toEqual({
        kind: 'slug',
        slug,
        source: 'path',
      });
    });
  });

  describe('le sous-domaine désigne l’établissement quand l’URL ne le fait pas', () => {
    it('résout depuis l’hôte sur une route publique sans segment', () => {
      expect(
        describePublicTenantRequest('/api/v1/public', `salon-des-lilas.${BASE}`, BASE),
      ).toEqual({ kind: 'slug', slug: 'salon-des-lilas', source: 'subdomain' });
    });

    it('accepte que les deux sources s’accordent', () => {
      expect(
        describePublicTenantRequest(
          '/api/v1/public/salon-des-lilas/services',
          `salon-des-lilas.${BASE}`,
          BASE,
        ),
      ).toEqual({ kind: 'slug', slug: 'salon-des-lilas', source: 'path' });
    });

    it('refuse un désaccord plutôt que d’arbitrer', () => {
      // Une page servie sur le domaine d'un salon qui interrogerait les données
      // d'un autre : erreur de câblage ou tentative, il n'y a pas de bon choix.
      expect(
        describePublicTenantRequest(
          '/api/v1/public/barbier-du-port',
          `salon-des-lilas.${BASE}`,
          BASE,
        ),
      ).toEqual({ kind: 'unresolvable' });
    });
  });
});

describe('readSubdomainSlug', () => {
  it.each([
    ['sous-domaine simple', `salon-des-lilas.${BASE}`, 'salon-des-lilas'],
    ['avec port', `salon-des-lilas.${BASE}:3000`, 'salon-des-lilas'],
    ['casse mélangée', `Salon-Des-Lilas.${BASE}`, 'salon-des-lilas'],
    ['FQDN à point final', `salon-des-lilas.${BASE}.`, 'salon-des-lilas'],
  ])('%s → %s', (_cas, host, slug) => {
    expect(readSubdomainSlug(host, BASE)).toBe(slug);
  });

  it.each([
    ['le domaine nu ne désigne aucun salon', BASE],
    ['un domaine étranger', 'salon-des-lilas.autre.test'],
    ['deux étiquettes au-dessus de la base', `a.b.${BASE}`],
    ['hôte absent', undefined],
    ['littéral IPv6', '[::1]:3000'],
    ['hôte vide', '   '],
  ])('%s → aucun', (_cas, host) => {
    expect(readSubdomainSlug(host, BASE)).toBeNull();
  });

  it.each(['api', 'www', 'app', 'admin', 'staging', 'static', 'assets', 'cdn', 'dev', 'mail'])(
    '« %s » est réservé : la topologie de déploiement ne désigne pas un salon',
    (label) => {
      // Sans cette liste, déployer l'API sur `api.exemple.test` ferait lire
      // « établissement *api* » à chaque requête — donc un désaccord avec le
      // slug d'URL, donc 404 sur tout l'espace public, et seulement en déployé.
      expect(readSubdomainSlug(`${label}.${BASE}`, BASE)).toBeNull();
    },
  );

  it('ne lit rien sans domaine de base connu', () => {
    // C'est la borne qui empêche le DNS de l'équilibreur de charge — dont la
    // première étiquette a la forme d'un slug — de désigner un établissement.
    expect(readSubdomainSlug('spa-prod-alb-1.eu-west-3.elb.amazonaws.com', null)).toBeNull();
    expect(readSubdomainSlug('spa-prod-alb-1.eu-west-3.elb.amazonaws.com', BASE)).toBeNull();
  });
});

describe('publicBaseHost', () => {
  it.each([
    ['https://exemple.test', 'exemple.test'],
    ['https://exemple.test/reserver', 'exemple.test'],
    ['http://localhost:3000', 'localhost'],
    // Le front sur `www` n'empêche pas `salon.exemple.test` de désigner un salon.
    ['https://www.exemple.test', 'exemple.test'],
    ['https://EXEMPLE.test', 'exemple.test'],
  ])('%s → %s', (appUrl, expected) => {
    expect(publicBaseHost(appUrl)).toBe(expected);
  });

  it('rend `null` sur une URL illisible plutôt que de lever', () => {
    // Le middleware la calcule au démarrage : lever ici empêcherait l'API de
    // démarrer pour une fonctionnalité qui, sans domaine de base, doit
    // simplement se taire.
    expect(publicBaseHost('pas-une-url')).toBeNull();
  });

  it('sans domaine de base, le sous-domaine ne désigne plus rien', () => {
    const designation = describePublicTenantRequest(
      '/api/v1/public',
      `salon-des-lilas.${BASE}`,
      publicBaseHost('pas-une-url'),
    );
    expect(designation).toEqual({ kind: 'unresolvable' });
  });
});

describe('cohérence avec le câblage réel de l’application', () => {
  it('le motif de chemin suit le préfixe et le versionnement de `configureApp`', () => {
    // `public-tenant-request.ts` recopie ces deux valeurs pour rester exerçable
    // sans tirer `bootstrap.ts`. La recopie est tenue ici : si `configureApp`
    // change de préfixe ou de version par défaut, ce test casse.
    expect(API_PREFIX).toBe('api');
    expect(API_DEFAULT_VERSION).toBe('1');

    const url = `/${API_PREFIX}/v${API_DEFAULT_VERSION}/${PUBLIC_ROUTE_SEGMENT}/salon-des-lilas`;
    expect(describePublicTenantRequest(url, undefined, BASE)).toEqual({
      kind: 'slug',
      slug: 'salon-des-lilas',
      source: 'path',
    });
  });
});
