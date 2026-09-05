import { PaymentProviderUnavailableError, WebhookNotConfiguredError } from '../payments.errors';
import {
  resolveStripeKeys,
  resolveWebhookSecret,
  StripeConfig,
  STRIPE_API_VERSION,
} from '../stripe/stripe.config';
import { TEST_STRIPE_ENV } from './payments.doubles';

/**
 * La configuration Stripe — **le troisième critère de #57**, « la clé secrète
 * vit dans Secrets Manager et n'atteint jamais le navigateur », et le premier
 * critère de #410, « une seule `StripeConfig`, portant les trois valeurs ».
 *
 * Ce que cette suite protège n'est pas un format de chaîne : c'est la frontière
 * entre ce qui a le droit d'atteindre un navigateur et ce qui ne l'a pas.
 * L'inversion `sk_`/`pk_`, comme la `sk_…` logée dans `STRIPE_WEBHOOK_SECRET`,
 * est l'erreur de déploiement la plus banale, et la seule qui envoie un accès
 * complet au compte Stripe du salon là où il ne doit jamais aller. Le préfixe
 * est ce qui la rend incapable de démarrer.
 *
 * Les deux capacités — encaisser, et vérifier une signature — se jugent
 * **séparément** : un poste qui détient les clés de test sans avoir lancé
 * `stripe listen` est un cas ordinaire.
 */
describe('StripeConfig — les trois valeurs et les frontières entre elles', () => {
  describe('resolveStripeKeys', () => {
    it('accepte deux clés bien préfixées et les rend telles quelles', () => {
      expect(resolveStripeKeys({ NODE_ENV: 'production', ...TEST_STRIPE_ENV })).toEqual(
        TEST_STRIPE_ENV,
      );
    });

    it('laisse démarrer un poste de développement sans aucune clé', () => {
      // L'absence complète hors déploiement n'est pas une faute : c'est l'état
      // d'un poste qui travaille sur l'agenda. `AppModule` monte les huit
      // modules — exiger une clé Stripe ici ferait refuser de démarrer toutes
      // les suites d'intégration du dépôt, y compris celles qui ne parlent que
      // de créneaux.
      expect(resolveStripeKeys({ NODE_ENV: 'development' })).toBeNull();
      expect(resolveStripeKeys({ NODE_ENV: 'test' })).toBeNull();
    });

    it.each(['staging', 'production'])('refuse de démarrer en %s sans clés', (nodeEnv) => {
      expect(() => resolveStripeKeys({ NODE_ENV: nodeEnv })).toThrow(/STRIPE_SECRET_KEY/);
    });

    it('refuse de démarrer en déployé sur une configuration à moitié posée', () => {
      // En déployé, une seule clé veut dire « ce salon ne peut pas encaisser » :
      // mieux vaut l'apprendre au déploiement qu'à la première cliente.
      expect(() =>
        resolveStripeKeys({
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: TEST_STRIPE_ENV.STRIPE_SECRET_KEY,
        }),
      ).toThrow(/STRIPE_PUBLISHABLE_KEY/);

      expect(() =>
        resolveStripeKeys({
          NODE_ENV: 'production',
          STRIPE_PUBLISHABLE_KEY: TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
        }),
      ).toThrow(/STRIPE_SECRET_KEY/);
    });

    it('laisse démarrer en local sur une configuration incomplète', () => {
      // Le cas réel qui a motivé cette borne : un poste dont l'environnement
      // porte un `STRIPE_SECRET_KEY` hérité d'un autre projet. Immobiliser
      // toute l'API pour cela coûterait les sept autres modules, alors que la
      // seule capacité perdue est l'encaissement — qui répond 503.
      expect(
        resolveStripeKeys({
          NODE_ENV: 'development',
          STRIPE_SECRET_KEY: TEST_STRIPE_ENV.STRIPE_SECRET_KEY,
        }),
      ).toBeNull();
    });

    it('refuse une clé mal préfixée dans **tout** environnement', () => {
      // La seule faute dangereuse partout : une clé secrète logée dans la
      // variable publiable partirait au navigateur. Elle empêche donc même un
      // poste de développement de démarrer.
      expect(() =>
        resolveStripeKeys({
          NODE_ENV: 'development',
          STRIPE_PUBLISHABLE_KEY: TEST_STRIPE_ENV.STRIPE_SECRET_KEY,
        }),
      ).toThrow(/STRIPE_PUBLISHABLE_KEY/);

      expect(() =>
        resolveStripeKeys({
          NODE_ENV: 'test',
          STRIPE_SECRET_KEY: TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
        }),
      ).toThrow(/STRIPE_SECRET_KEY/);
    });

    it('refuse les deux clés interverties — le scénario qui exposerait le compte', () => {
      expect(() =>
        resolveStripeKeys({
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
          STRIPE_PUBLISHABLE_KEY: TEST_STRIPE_ENV.STRIPE_SECRET_KEY,
        }),
      ).toThrow(/STRIPE_SECRET_KEY/);
    });

    it('ne cite jamais la valeur d’une clé dans son message d’erreur', () => {
      // Un message qui citerait la valeur reçue écrirait une clé live en clair
      // dans les journaux de démarrage de la tâche ECS.
      const secret = 'pk_une_valeur_qui_ne_doit_pas_fuiter';
      let message = '';

      try {
        resolveStripeKeys({
          NODE_ENV: 'production',
          // Une clé publiable logée dans la variable secrète : le préfixe la
          // refuse, et le refus ne doit pas recopier ce qu'il a lu.
          STRIPE_SECRET_KEY: secret,
          STRIPE_PUBLISHABLE_KEY: TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('STRIPE_SECRET_KEY');
      expect(message).not.toContain(secret);
    });

    it('traite une variable vide comme absente', () => {
      // Une variable déclarée sans valeur dans une définition de tâche ECS
      // arrive comme `""`, jamais comme `undefined`.
      expect(
        resolveStripeKeys({ NODE_ENV: 'test', STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '' }),
      ).toBeNull();
    });
  });

  /**
   * Le secret de terminaison : ce qui empêche de démarrer, et ce qui ne
   * l'empêche pas.
   *
   * La table de `stripe.config.ts` est le contrat exercé ici. Elle a deux
   * colonnes parce que les deux fautes n'ont pas la même gravité : un secret
   * absent en local est l'état ordinaire d'un poste, un secret absent en
   * production est une panne d'encaissement qui ne se verrait qu'à la première
   * réservation non confirmée.
   */
  describe('resolveWebhookSecret', () => {
    /** Même valeur pauvre en entropie qu'ailleurs, et pour la même raison — voir `stripe-signature.spec.ts`. */
    const VALID = 'whsec_test_not_a_secret_0005';

    it('accepte un secret bien préfixé et le rend', () => {
      expect(resolveWebhookSecret({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: VALID })).toBe(
        VALID,
      );
    });

    it.each(['development', 'test'])('laisse démarrer sans secret en %s', (nodeEnv) => {
      expect(resolveWebhookSecret({ NODE_ENV: nodeEnv })).toBeNull();
    });

    it.each(['staging', 'production'])('refuse de démarrer sans secret en %s', (nodeEnv) => {
      expect(() => resolveWebhookSecret({ NODE_ENV: nodeEnv })).toThrow(/obligatoire en déployé/);
    });

    it('traite une variable vide comme absente', () => {
      // `""` est ce qu'une définition de tâche ECS produit pour une variable
      // déclarée sans valeur : « pas posée », pas « mal posée ».
      expect(resolveWebhookSecret({ NODE_ENV: 'test', STRIPE_WEBHOOK_SECRET: '' })).toBeNull();
      expect(() =>
        resolveWebhookSecret({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: '' }),
      ).toThrow(/obligatoire en déployé/);
    });

    it.each(['development', 'test', 'staging', 'production'])(
      'refuse de démarrer en %s sur un secret mal préfixé',
      (nodeEnv) => {
        // L'inversion des variables est l'erreur de déploiement la plus banale,
        // et la plus chère : ce qui atterrit ici est une clé `sk_…`, c'est-à-dire
        // un accès complet au compte Stripe du salon.
        expect(() =>
          resolveWebhookSecret({ NODE_ENV: nodeEnv, STRIPE_WEBHOOK_SECRET: 'sk_live_deadbeef' }),
        ).toThrow(/doit commencer par/);
      },
    );

    it('ne cite jamais la valeur reçue dans ses messages', () => {
      // Un message d'erreur de démarrage part dans les journaux de la tâche ECS.
      const secret = 'sk_live_tres_secret_a_ne_pas_journaliser';

      expect(() =>
        resolveWebhookSecret({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: secret }),
      ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(secret) }) as Error);
    });
  });

  describe('la façade injectée', () => {
    it('rend les trois valeurs quand elles sont posées', () => {
      const config = new StripeConfig({
        NODE_ENV: 'test',
        ...TEST_STRIPE_ENV,
        STRIPE_WEBHOOK_SECRET: 'whsec_test_not_a_secret_0006',
      });

      expect(config.isConfigured).toBe(true);
      expect(config.isWebhookConfigured).toBe(true);
      expect(config.secretKey).toBe(TEST_STRIPE_ENV.STRIPE_SECRET_KEY);
      expect(config.publishableKey).toBe(TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY);
      expect(config.requireWebhookSecret()).toBe('whsec_test_not_a_secret_0006');
    });

    it('signale un prestataire indisponible plutôt qu’une clé absente', () => {
      const config = new StripeConfig({ NODE_ENV: 'development' });

      expect(config.isConfigured).toBe(false);
      // Une erreur de domaine, pas une erreur nue : le corps de réponse ne doit
      // rien dire de notre configuration.
      expect(() => config.secretKey).toThrow(PaymentProviderUnavailableError);
      expect(() => config.publishableKey).toThrow(PaymentProviderUnavailableError);
    });

    it('rend un 503 plutôt qu’un secret vide quand la terminaison n’est pas configurée', () => {
      // Le point n'est pas le code de statut : c'est qu'aucun appelant ne puisse
      // vérifier une signature contre `null`. Un secret vide accepterait tout
      // corps accompagné du condensat de la chaîne vide.
      const config = new StripeConfig({ NODE_ENV: 'test', ...TEST_STRIPE_ENV });

      expect(config.isWebhookConfigured).toBe(false);
      expect(() => config.requireWebhookSecret()).toThrow(WebhookNotConfiguredError);

      const error = new WebhookNotConfiguredError();
      expect(error.status).toBe(503);
      expect(error.code).toBe('WEBHOOK_NOT_CONFIGURED');
    });

    it('juge les deux capacités séparément — encaisser n’est pas vérifier une signature', () => {
      // Le cas ordinaire d'un poste : les clés de test sont posées, `stripe
      // listen` n'a jamais été lancé. Un drapeau unique aurait couplé deux
      // capacités qui tombent indépendamment, et refusé de créer une intention
      // sous prétexte qu'aucun webhook ne peut être vérifié.
      const withKeysOnly = new StripeConfig({ NODE_ENV: 'test', ...TEST_STRIPE_ENV });
      expect(withKeysOnly.isConfigured).toBe(true);
      expect(withKeysOnly.isWebhookConfigured).toBe(false);

      const withSecretOnly = new StripeConfig({
        NODE_ENV: 'test',
        STRIPE_WEBHOOK_SECRET: 'whsec_test_not_a_secret_0007',
      });
      expect(withSecretOnly.isConfigured).toBe(false);
      expect(withSecretOnly.isWebhookConfigured).toBe(true);
    });
  });

  it('épingle une version d’API Stripe explicite', () => {
    // Sans épinglage, le compte suivrait la version par défaut du tableau de
    // bord Stripe : la forme des réponses changerait sans qu'une ligne du dépôt
    // ne bouge.
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
