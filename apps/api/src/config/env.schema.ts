import { z } from 'zod';

/**
 * Contrat des variables d'environnement consommées par l'API.
 *
 * Deux principes :
 *
 * 1. On ne valide que ce qu'on consomme. Chaque module métier ajoutera ses
 *    propres clés (JWT, Stripe, SES…) au moment où il les lit réellement ;
 *    exiger aujourd'hui une variable que personne n'utilise ne ferait
 *    qu'empêcher un déploiement de recette de démarrer pour rien.
 * 2. Ce qui n'a pas de valeur par défaut raisonnable est **obligatoire**, et son
 *    absence empêche l'application de démarrer — mieux vaut échouer au
 *    déploiement qu'à la première requête client (api-module §7).
 */

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevelName = (typeof LOG_LEVELS)[number];

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//i.test(value), {
    // Le message ne cite jamais la valeur : une URL de connexion porte un mot de passe.
    message: 'doit être une URL PostgreSQL (postgresql://…)',
  });

const redisUrl = z
  .string()
  .min(1)
  .refine((value) => /^rediss?:\/\//i.test(value), {
    message: 'doit être une URL Redis (redis:// ou rediss://)',
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),

  /**
   * Port d'écoute du conteneur. Distinct de `API_URL`, qui est l'URL publique :
   * derrière un ALB, l'API écoute en clair sur un port interne alors que son URL
   * publique est en HTTPS sur 443.
   */
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  APP_URL: z.string().url(),
  API_URL: z.string().url(),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Levée au démarrage quand l'environnement est incomplet ou invalide. */
export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      [
        "Configuration d'environnement invalide — l'application refuse de démarrer :",
        ...issues.map((issue) => `  - ${issue}`),
        'Voir .env.example pour la liste des variables attendues.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Valide `process.env` (ou l'objet fourni par @nestjs/config) et renvoie une
 * configuration typée. Le rapport d'erreur nomme les variables fautives mais
 * **jamais leur valeur** : elles peuvent contenir un secret, et un message
 * d'erreur finit dans les logs.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  const issues = parsed.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(racine)';
    const message =
      issue.code === 'invalid_type' && issue.received === 'undefined'
        ? 'variable manquante'
        : issue.message;
    return `${name} : ${message}`;
  });

  throw new EnvValidationError(issues);
}
