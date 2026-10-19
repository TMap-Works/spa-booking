import Redis from 'ioredis';

/**
 * La connexion Redis du copilot — P1-08 (#1455).
 *
 * Elle porte ce qui doit survivre à une requête et être partagé entre les
 * tâches du front : l'historique des conversations et les compteurs de quotas.
 * En production, deux tâches ECS se partagent le trafic, et un fil servi tour
 * à tour par l'une puis l'autre perdrait son historique s'il vivait en mémoire.
 *
 * `REDIS_URL` vient du secret du copilot (Terraform, `copilot_enabled`). Sans
 * elle, en développement local, le copilot se replie sur la mémoire du
 * processus ; en production, il reste fermé (`copilotEnabled`).
 */

let client: Redis | null | undefined;

export function copilotRedis(env: NodeJS.ProcessEnv = process.env): Redis | null {
  if (client !== undefined) return client;
  const url = env.REDIS_URL;
  client = url
    ? new Redis(url, {
        // Une commande qui n'aboutit pas échoue vite : le chat dit qu'il est
        // indisponible plutôt que de faire attendre la cliente.
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        enableOfflineQueue: false,
        lazyConnect: false,
      })
    : null;
  return client;
}
