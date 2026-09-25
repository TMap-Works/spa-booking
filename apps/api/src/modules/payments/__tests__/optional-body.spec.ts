/**
 * Le corps **absent** des deux ouvertures de page hébergée par Stripe — #1261.
 *
 * Pendant d'`appointments/__tests__/optional-body.spec.ts` et de
 * `catalog/__tests__/optional-body.spec.ts`, dont les en-têtes décrivent ce que
 * la substitution de l'ADR 0008 a déplacé : le `ValidationPipe` global ne
 * normalise plus un corps nul, le paramètre du handler n'étant plus typé par une
 * classe, et Express 5 laisse `req.body` à `undefined` quand la requête ne porte
 * aucun en-tête `Content-Type`.
 *
 * `POST /billing/checkout` et `POST /billing/portal` n'avaient **aucun** corps
 * avant #1261 et répondaient 201 sans en recevoir. C'est `optionalBody` qui le
 * tient désormais, et c'est ici que la propriété se garde : aucune suite
 * d'intégration ne l'attrape, `supertest.send(…)` posant toujours un type de
 * contenu. Sans cette suite, l'appelant qui n'a pas encore adopté le contrat —
 * et c'est le cas nominal du geste « démarrer mon essai » d'un client tiers —
 * sortirait en 400 « Required » sans qu'aucun test ne bouge.
 */

import { BadRequestException } from '@nestjs/common';

import { billingRedirectBody } from '../dto/billing-redirect.dto';

describe('ouverture d’une page Stripe sans corps', () => {
  it('se lit comme une ouverture sans langue soumise', () => {
    // L'API retrouve alors la règle d'avant le ticket : `users.locale`, puis
    // `tenants.default_locale`, puis `en`.
    expect(billingRedirectBody.transform(undefined)).toEqual({});
    expect(billingRedirectBody.transform(null)).toEqual({});
    expect(billingRedirectBody.transform({})).toEqual({});
  });

  it('normalise la casse et les espaces de la langue soumise', () => {
    // L'enveloppe ne court-circuite pas le schéma : `submittedLocaleSchema`
    // juge bien la valeur qui traverse le `preprocess`.
    expect(billingRedirectBody.transform({ locale: ' FR ' })).toEqual({ locale: 'fr' });
    expect(billingRedirectBody.transform({ locale: 'en' })).toEqual({ locale: 'en' });
  });

  it('refuse une langue qui n’est aucune des deux du contrat', () => {
    // Une page de paiement s'ouvre dans une langue connue ou ne s'ouvre pas :
    // un repli silencieux masquerait l'appelant fautif.
    expect(() => billingRedirectBody.transform({ locale: 'de' })).toThrow(BadRequestException);
  });

  it('refuse toujours un champ inconnu — l’enveloppe ne relâche pas `.strict()`', () => {
    // Un `tenantId` glissé dans le corps est **refusé**, pas silencieusement
    // ignoré (tenant-isolation §2) : `ZodValidationPipe` déballe les
    // `ZodEffects` avant de vérifier `.strict()`. Et rien qui touche une carte
    // n'entre par là — ces routes rendent une adresse, la carte se saisit chez
    // Stripe (payments-stripe §1, SAQ A).
    expect(() => billingRedirectBody.transform({ tenantId: 'x' })).toThrow(BadRequestException);
    expect(() =>
      billingRedirectBody.transform({ locale: 'fr', cardNumber: '4242424242424242' }),
    ).toThrow(BadRequestException);
  });
});
