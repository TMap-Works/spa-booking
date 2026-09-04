import { PaymentProviderUnavailableError } from '../payments.errors';
import { resolveStripeKeys, StripeConfig, STRIPE_API_VERSION } from '../stripe/stripe.config';
import { TEST_STRIPE_ENV } from './payments.doubles';

/**
 * La configuration Stripe — **le troisième critère de #57**, « la clé secrète
 * vit dans Secrets Manager et n'atteint jamais le navigateur ».
 *
 * Ce que cette suite protège n'est pas un format de chaîne : c'est la frontière
 * entre les deux clés. L'inversion `sk_`/`pk_` est l'erreur de déploiement la
 * plus banale, et la seule qui envoie un accès complet au compte Stripe du
 * salon dans le corps d'une réponse HTTP publique. Le préfixe est ce qui la
 * rend incapable de démarrer.
 */
describe('StripeConfig — les deux clés et la frontière entre elles', () => {
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

  describe('la façade injectée', () => {
    it('rend les deux clés quand elles sont posées', () => {
      const config = new StripeConfig({ NODE_ENV: 'test', ...TEST_STRIPE_ENV });

      expect(config.isConfigured).toBe(true);
      expect(config.secretKey).toBe(TEST_STRIPE_ENV.STRIPE_SECRET_KEY);
      expect(config.publishableKey).toBe(TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY);
    });

    it('signale un prestataire indisponible plutôt qu’une clé absente', () => {
      const config = new StripeConfig({ NODE_ENV: 'development' });

      expect(config.isConfigured).toBe(false);
      // Une erreur de domaine, pas une erreur nue : le corps de réponse ne doit
      // rien dire de notre configuration.
      expect(() => config.secretKey).toThrow(PaymentProviderUnavailableError);
      expect(() => config.publishableKey).toThrow(PaymentProviderUnavailableError);
    });
  });

  it('épingle une version d’API Stripe explicite', () => {
    // Sans épinglage, le compte suivrait la version par défaut du tableau de
    // bord Stripe : la forme des réponses changerait sans qu'une ligne du dépôt
    // ne bouge.
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
