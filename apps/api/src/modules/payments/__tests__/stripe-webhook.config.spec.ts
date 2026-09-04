import { WebhookNotConfiguredError } from '../stripe-webhook.errors';
import { StripeWebhookConfig } from '../stripe/stripe-webhook.config';

/**
 * Le secret de terminaison : ce qui empêche de démarrer, et ce qui ne
 * l'empêche pas.
 *
 * La table de `stripe-webhook.config.ts` est le contrat exercé ici. Elle a deux
 * colonnes parce que les deux fautes n'ont pas la même gravité : un secret
 * absent en local est l'état ordinaire d'un poste, un secret absent en
 * production est une panne d'encaissement qui ne se verrait qu'à la première
 * réservation non confirmée.
 */

/** Même valeur pauvre en entropie qu'ailleurs, et pour la même raison — voir `stripe-signature.spec.ts`. */
const VALID = 'whsec_test_not_a_secret_0005';

function config(env: NodeJS.ProcessEnv): StripeWebhookConfig {
  return new StripeWebhookConfig(env);
}

describe('StripeWebhookConfig', () => {
  it('accepte un secret bien préfixé et le rend', () => {
    const subject = config({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: VALID });

    expect(subject.isConfigured).toBe(true);
    expect(subject.requireSecret()).toBe(VALID);
  });

  it.each(['development', 'test'])('démarre sans secret en %s', (nodeEnv) => {
    const subject = config({ NODE_ENV: nodeEnv });

    expect(subject.isConfigured).toBe(false);
    expect(() => subject.requireSecret()).toThrow(WebhookNotConfiguredError);
  });

  it.each(['staging', 'production'])('refuse de démarrer sans secret en %s', (nodeEnv) => {
    expect(() => config({ NODE_ENV: nodeEnv })).toThrow(/obligatoire en déployé/);
  });

  it('traite une variable vide comme absente', () => {
    // `""` est ce qu'une définition de tâche ECS produit pour une variable
    // déclarée sans valeur : « pas posée », pas « mal posée ».
    expect(config({ NODE_ENV: 'test', STRIPE_WEBHOOK_SECRET: '' }).isConfigured).toBe(false);
    expect(() => config({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: '' })).toThrow(
      /obligatoire en déployé/,
    );
  });

  it.each(['development', 'test', 'staging', 'production'])(
    'refuse de démarrer en %s sur un secret mal préfixé',
    (nodeEnv) => {
      // L'inversion des variables est l'erreur de déploiement la plus banale, et
      // la plus chère : ce qui atterrit ici est une clé `sk_…`, c'est-à-dire un
      // accès complet au compte Stripe du salon.
      expect(() => config({ NODE_ENV: nodeEnv, STRIPE_WEBHOOK_SECRET: 'sk_live_deadbeef' })).toThrow(
        /doit commencer par/,
      );
    },
  );

  it('ne cite jamais la valeur reçue dans ses messages', () => {
    // Un message d'erreur de démarrage part dans les journaux de la tâche ECS.
    const secret = 'sk_live_tres_secret_a_ne_pas_journaliser';

    expect(() => config({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }) as Error,
    );
  });

  it('rend un 503 plutôt qu’un secret vide quand il n’est pas configuré', () => {
    // Le point n'est pas le code de statut : c'est qu'aucun appelant ne puisse
    // vérifier une signature contre `null`. Un secret vide accepterait tout
    // corps accompagné du condensat de la chaîne vide.
    const error = new WebhookNotConfiguredError();

    expect(error.status).toBe(503);
    expect(error.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });
});
