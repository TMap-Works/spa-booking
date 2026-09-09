/**
 * Hook de démarrage du serveur Next (#345).
 *
 * ## Quand `register()` est réellement appelée
 *
 * En développement, à la préparation du serveur. **En production, à la première
 * requête servie** : le serveur autonome n'appelle `prepare()` que si
 * `options.dev` est vrai (`next/dist/server/next.js` — « We shouldn't prepare
 * the server in production »), et c'est ensuite `handleRequest` qui l'attend
 * (`next/dist/server/base-server.js` : `await this.prepare()`).
 *
 * ## Pourquoi `process.exit(1)` et non une exception
 *
 * Parce qu'une exception levée ici ne fait **pas** sortir le processus en
 * production. `base-server` mémorise la promesse rejetée sans jamais la
 * réarmer : le serveur annonce « Ready », garde son port ouvert, journalise un
 * `unhandledRejection` et répond 500 à *chaque* requête, indéfiniment. Un
 * conteneur vivant qui ne sert plus rien est le pire des deux mondes — il
 * consomme sa tâche Fargate et brouille le diagnostic.
 *
 * Sortir en code 1 rend au contraire à la panne la forme qu'on attend d'elle :
 * la tâche ECS s'arrête sur la première requête — le contrôle de santé de l'ALB,
 * qui vise `/` (`infra/terraform/envs/dev/main.tf`) —, elle n'entre jamais dans
 * le groupe cible, et le disjoncteur de déploiement revient à la révision
 * précédente au lieu de servir des pages fausses.
 *
 * ## Ce hook ne s'exécute pas pendant `next build`
 *
 * `registerInstrumentation` sort d'elle-même quand `NEXT_PHASE` vaut
 * `phase-production-build`. Une image se construit donc sans que l'origine
 * publique de son futur environnement soit connue — ce qui est heureux, la même
 * image partant en dev, en recette et en production.
 *
 * Ce fichier reste volontairement squelettique : ce qui se vérifie vit dans
 * `lib/`, testable sans monter de serveur.
 */

import { assertPublicOrigin } from '@/lib/public-origin';

export function register(): void {
  try {
    assertPublicOrigin(process.env);
  } catch (error) {
    // `process.stderr` et non `console` : la règle `no-console` du workspace
    // vise la console du navigateur, et ce fichier ne s'exécute que côté
    // serveur. C'est la dernière chose que ce processus écrira, et elle doit
    // atterrir telle quelle dans le flux CloudWatch de la tâche.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
