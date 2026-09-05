/**
 * Environnement minimal des tests d'intégration, posé **avant** le chargement
 * du moindre module Nest — `AppConfigModule` valide `process.env` pendant son
 * initialisation, donc trop tard pour qu'un test le complète lui-même.
 *
 * Rien n'est écrasé : la CI fournit déjà `DATABASE_URL` et `REDIS_URL` (services
 * `postgres` et `redis` du job `test`), et il faut que ce soient ces valeurs-là
 * qui servent. Seul ce qui manque est complété — la CI ne pose ni `APP_URL` ni
 * `API_URL`, dont l'absence suffirait à faire échouer chaque test au démarrage.
 *
 * Aucune valeur n'est un secret : ce sont des adresses de boucle locale.
 */
const DEFAULTS: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3001',
  // 5433 : le port publié par `docker-compose.yml`, et non le 5432 standard
  // qu'un PostgreSQL natif peut déjà tenir (#272). La CI pose `DATABASE_URL`
  // elle-même, ce défaut ne la concerne donc pas.
  DATABASE_URL: 'postgresql://spa:spa@localhost:5433/spa_test',
  // 6380 : le port publié par `docker-compose.yml` (#272). Comme pour la base,
  // la CI pose `REDIS_URL` elle-même.
  REDIS_URL: 'redis://localhost:6380',
  // Les sondes en échec journalisent en `warn` : le palier `error` garde la
  // sortie de test lisible sans désactiver la journalisation, que la suite
  // d'isolation inspecte réellement.
  LOG_LEVEL: 'error',
  // Deux clés de signature distinctes, sans quoi `AppConfigModule` refuse de
  // démarrer et **toute** la suite d'intégration échoue à l'amorçage. Ce ne sont
  // pas des secrets : ce sont des chaînes de remplissage, jamais déployées, et
  // le dépôt n'en contient aucun autre. Les faire différer n'est pas cosmétique
  // — `validateEnv` refuse deux clés identiques.
  JWT_SECRET: 'test-access-signing-key-not-a-secret-0001',
  JWT_REFRESH_SECRET: 'test-refresh-signing-key-not-a-secret-0002',
  // Coût bcrypt plancher : 12 ferait payer ~250 ms à chaque inscription de test,
  // soit des dizaines de secondes sur la suite. Le coût réel est validé par le
  // test unitaire du hacheur, pas par le temps que met la suite d'intégration.
  BCRYPT_COST: '4',
  // Secret de terminaison des webhooks Stripe. Ce n'en est pas un : c'est une
  // chaîne de remplissage, jamais déployée, dont la seule propriété utile est
  // le préfixe `whsec_` qu'exige `StripeConfig` — `resolveWebhookSecret`, dans
  // `modules/payments/stripe/stripe.config.ts` (#410). Sans elle, la route de
  // webhook répondrait 503 en test — ce qui est le comportement voulu sur un
  // poste sans compte Stripe, mais rendrait sa recette impossible.
  STRIPE_WEBHOOK_SECRET: 'whsec_test_not_a_secret_0003',
};

for (const [name, value] of Object.entries(DEFAULTS)) {
  const current = process.env[name];
  if (current === undefined || current === '') {
    process.env[name] = value;
  }
}
