/**
 * Le lien d'annulation sur sous-domaine, et son repli par chemin — critères 3,
 * 4 et 6 de #837.
 *
 * ## Ce que cette suite tient, et que `notification-content.spec.ts` ne tient pas
 *
 * La suite voisine vérifie que le lien **figure** dans les messages et qu'il se
 * compose depuis l'origine du front. Celle-ci vérifie la propriété que
 * l'arbitrage du 16/09/2026 ajoute (#832) : **quelle forme** ce lien prend selon
 * la base, et surtout qu'aucune base ne lui fait produire une adresse morte.
 *
 * C'est la seule preuve qu'un e-mail de recette reste cliquable. Les suites
 * d'intégration et la recette tapent sur `127.0.0.1`, où aucun
 * `maison-lotus.127.0.0.1` ne se résout : sans le repli, le lien d'annulation de
 * chaque confirmation envoyée en recette aurait mené nulle part, et personne ne
 * s'en serait aperçu avant qu'une cliente essaie de s'en servir.
 *
 * Fonctions pures : ni Nest, ni base, ni horloge.
 */

import { LOCALES } from '@spa/shared';

import { cancellationUrl, smsReferenceVariables } from '../notification-content';

const SLUG = 'maison-lotus';

describe('le lien d’annulation sur sous-domaine', () => {
  it('sert le salon sur `{slug}.{domaine}` — critère 3', () => {
    expect(cancellationUrl('https://reservation.spa-booking.app', SLUG)).toBe(
      'https://maison-lotus.reservation.spa-booking.app/compte',
    );
  });

  it('tombe sur l’hôte que le middleware sait relire, `www.` retiré', () => {
    // `publicBaseHost` retire `www.` à la lecture d'une requête entrante. Une
    // écriture qui ne le retirerait pas produirait
    // `maison-lotus.www.exemple.test`, que la résolution publique refuse — un
    // lien d'e-mail mort, et seulement en déployé.
    expect(cancellationUrl('https://www.exemple.test', SLUG)).toBe(
      'https://maison-lotus.exemple.test/compte',
    );
  });

  it('conserve le protocole et le port de la base', () => {
    expect(cancellationUrl('http://exemple.test:3000', SLUG)).toBe(
      'http://maison-lotus.exemple.test:3000/compte',
    );
  });
});

describe('le repli par chemin — critère 4', () => {
  it.each([
    ['adresse IP — les suites d’intégration et la recette', 'http://127.0.0.1:3001'],
    ['hôte d’une seule étiquette', 'http://localhost:3000'],
  ])('%s → forme par chemin', (_cas, baseUrl) => {
    expect(cancellationUrl(baseUrl, SLUG)).toBe(`${baseUrl}/${SLUG}/compte`);
  });

  it('se déclenche sans configuration : `auto` est le défaut', () => {
    // Exiger un réglage explicite aurait voulu dire qu'un oubli produit un lien
    // mort dans un e-mail déjà parti.
    expect(cancellationUrl('http://127.0.0.1:3001', SLUG, 'auto')).toBe(
      cancellationUrl('http://127.0.0.1:3001', SLUG),
    );
  });

  it('se force dans les deux sens — `PUBLIC_TENANT_URL_MODE`', () => {
    expect(cancellationUrl('https://exemple.test', SLUG, 'path')).toBe(
      'https://exemple.test/maison-lotus/compte',
    );
    expect(cancellationUrl('http://127.0.0.1:3001', SLUG, 'subdomain')).toBe(
      'http://maison-lotus.127.0.0.1:3001/compte',
    );
  });
});

describe('aucun lien d’e-mail n’est une adresse impossible', () => {
  it('un slug qui n’est pas un label DNS repasse en chemin, encodé', () => {
    // En sous-domaine, il produirait `salon/évasion.exemple.test` — pas même une
    // URL. En chemin, il redevient un segment encodable : le lien reste
    // cliquable et mène à un 404, ce qui est le bon échec.
    expect(cancellationUrl('https://exemple.test', 'salon/évasion')).toBe(
      'https://exemple.test/salon%2F%C3%A9vasion/compte',
    );
  });

  it('un label réservé repasse en chemin plutôt que d’écrire un lien mort', () => {
    // `www.exemple.test` est refusé par la résolution publique (404, critère 5).
    expect(cancellationUrl('https://exemple.test', 'www')).toBe(
      'https://exemple.test/www/compte',
    );
  });

  it('une base illisible ne fait pas échouer un envoi', () => {
    expect(() => cancellationUrl('pas-une-url', SLUG)).not.toThrow();
  });
});

describe('l’exemple de modèle suit la même forme', () => {
  // La référence est une fonction de la langue depuis #854, mais le lien n'en
  // dépend pas : c'est une URL, pas une phrase. Les deux langues sont donc
  // exercées, et c'est le fait qu'elles donnent le **même** lien qui est le
  // verdict — une référence qui traduirait un chemin d'URL produirait un lien
  // mort dans une langue sur deux.
  it.each(LOCALES)('`lien_annulation` est sur sous-domaine — %s', (locale) => {
    // Il sert à mesurer la longueur d'un SMS, mais il est aussi ce qu'un
    // intégrateur recopie dans un modèle de salon : le laisser sur l'ancienne
    // forme aurait diffusé l'adresse d'avant #837.
    expect(smsReferenceVariables(locale)['lien_annulation']).toBe(
      cancellationUrl('https://reservation.spa-booking.app', SLUG, 'subdomain'),
    );
  });

  it.each(LOCALES)('la mesure du SMS ne change pas d’un caractère — %s', (locale) => {
    // Le slug change de place, pas de longueur : le point qui le rattache au
    // domaine remplace exactement la barre oblique qui l'en séparait. C'est ce
    // qui garantit qu'aucun modèle de salon ne bascule d'un segment à deux à
    // cause de ce ticket.
    const avant = 'https://reservation.spa-booking.app/maison-lotus/compte';
    expect(smsReferenceVariables(locale)['lien_annulation']).toHaveLength(avant.length);
  });
});
