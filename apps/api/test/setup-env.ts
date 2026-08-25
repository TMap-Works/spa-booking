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
  DATABASE_URL: 'postgresql://spa:spa@localhost:5432/spa_test',
  REDIS_URL: 'redis://localhost:6379',
  // Les sondes en échec journalisent en `warn` : le palier `error` garde la
  // sortie de test lisible sans désactiver la journalisation, que la suite
  // d'isolation inspecte réellement.
  LOG_LEVEL: 'error',
};

for (const [name, value] of Object.entries(DEFAULTS)) {
  const current = process.env[name];
  if (current === undefined || current === '') {
    process.env[name] = value;
  }
}
