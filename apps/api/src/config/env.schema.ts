import { TENANT_URL_MODES } from '@spa/shared';
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

/**
 * Durée exprimée comme `jsonwebtoken` la lit — `15m`, `7d`, `900s`.
 *
 * Le format est contraint parce qu'il est ambigu : `jsonwebtoken` interprète un
 * **nombre nu** comme des secondes, mais une **chaîne** de chiffres sans unité
 * (`"900"`) comme des millisecondes. Une durée sans unité produirait donc un
 * jeton d'accès valable 0,9 seconde là où on croyait en poser un de 15 minutes.
 */
const jwtDuration = z
  .string()
  .regex(/^\d+[smhd]$/, {
    message: 'doit être une durée du type « 15m », « 12h » ou « 7d » (unité obligatoire)',
  });

/**
 * Secret de signature.
 *
 * 32 caractères au minimum, et **aucune valeur par défaut** : un secret par
 * défaut est un secret public, et il signerait des jetons acceptés par tous les
 * déploiements qui l'auraient gardé. L'application refuse de démarrer plutôt
 * que d'émettre des jetons forgeables.
 */
const signingSecret = z.string().min(32, {
  // Le message ne cite jamais la valeur : c'est un secret, et il finirait en clair
  // dans les logs de démarrage de la tâche ECS.
  message: 'doit compter au moins 32 caractères',
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

  /**
   * Forme de l'adresse publique d'un salon — critère 4 de #837.
   *
   * Depuis l'arbitrage du PO du 16/09/2026 (#832), un salon est servi sur
   * `{slug}.{domaine}`. Tout environnement ne sait pas résoudre un sous-domaine :
   * les suites d'intégration et la recette tapent sur `127.0.0.1`, où
   * `maison-lotus.127.0.0.1` n'est pas un nom. D'où un **mode de repli par
   * chemin**, `https://{domaine}/{slug}/…`, et ce réglage pour en décider.
   *
   * | Valeur | Effet |
   * |---|---|
   * | `auto` (défaut) | `path` quand l'hôte d'`APP_URL` ne peut porter aucune étiquette — adresse IP, hôte d'une seule étiquette comme `localhost` — et `subdomain` partout ailleurs |
   * | `subdomain` | force la forme retenue, quelle que soit la base |
   * | `path` | force le repli — le temps qu'un certificat générique ou une entrée DNS manquants soient posés |
   *
   * `auto` est le défaut parce que le seul cas de repli réellement rencontré est
   * mécaniquement détectable. Exiger un réglage explicite aurait voulu dire qu'un
   * oubli produit un lien mort dans un e-mail, et un lien d'annulation mort ne se
   * constate qu'au moment où une cliente essaie de s'en servir.
   *
   * Le réglage vaut pour **la plateforme**, pas pour un module : il gouverne
   * autant le lien que l'API écrit dans un e-mail (`tenantPublicUrl`, appliqué
   * par `cancellationUrl`) que le routage du middleware de sous-domaine
   * d'`apps/web`, qui lit cette même variable (#838). C'est ce qui le distingue
   * des clés propres à un module — `NOTIFICATIONS_INTERNAL_TOKEN`,
   * `STRIPE_SECRET_KEY` — que leur module lit lui-même, et c'est pourquoi il est
   * déclaré ici. Il a une valeur par défaut : il n'empêche aucun démarrage.
   *
   * Les valeurs sont celles de `TENANT_URL_MODES` (`@spa/shared`) — une seule
   * liste, pour que le réglage lu par le front et celui lu par l'API ne puissent
   * pas diverger.
   *
   * ## Ce qui l'applique aujourd'hui, et ce qui reste à brancher — #920
   *
   * Le **repli automatique** est en place : `cancellationUrl` compose avec
   * `auto`, qui déduit `path` d'un hôte sans sous-domaine. C'est le cas que le
   * critère 4 nomme, et il ne demande aucun réglage.
   *
   * En revanche, **forcer** une valeur n'a pas encore d'effet sur l'API : le
   * getter d'`AppConfigService` et le passage du mode par
   * `AppointmentNotificationRenderer` appartiennent à #920 — ces deux fichiers
   * étaient réécrits en parallèle par un autre ticket du jalon, et deux auteurs
   * sur les mêmes lignes se seraient conflictés. La variable est déclarée ici
   * dès maintenant parce qu'elle est **du ressort de la plateforme** et que le
   * middleware de sous-domaine du front (#838) la lit de son côté : la déclarer
   * après coup aurait voulu dire deux noms possibles le temps d'un sprint.
   */
  PUBLIC_TENANT_URL_MODE: z.enum(TENANT_URL_MODES).default('auto'),

  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,

  /**
   * Signature des **jetons d'accès** — la clé courte, celle que porte chaque
   * requête authentifiée.
   */
  JWT_SECRET: signingSecret,

  /**
   * Signature des **jetons de rafraîchissement**, distincte de la précédente.
   *
   * Deux clés et non une : avec un secret unique, un jeton d'accès dérobé — le
   * plus exposé des deux, puisqu'il voyage à chaque appel — resterait
   * syntaxiquement valide comme jeton de rafraîchissement. Seule la revendication
   * `typ` l'en distinguerait, et une revendication est une convention applicative,
   * pas une barrière cryptographique. Deux clés font que le jeton d'un usage ne se
   * vérifie tout simplement pas dans l'autre.
   */
  JWT_REFRESH_SECRET: signingSecret,

  /**
   * Durée de vie du jeton d'accès. Courte par construction : c'est ce qui borne
   * la fenêtre d'un vol, puisqu'un jeton d'accès n'est pas révocable — rien
   * n'est consulté en base pour l'accepter.
   */
  JWT_EXPIRES_IN: jwtDuration.default('15m'),

  /**
   * Durée de vie de la session de rafraîchissement. Longue, mais **révocable** :
   * la déconnexion éteint la ligne `refresh_tokens` correspondante.
   */
  REFRESH_TOKEN_EXPIRES_IN: jwtDuration.default('7d'),

  /**
   * Coût bcrypt — le nombre d'itérations est `2^BCRYPT_COST`.
   *
   * 12 est le palier « coût suffisant » attendu par #21 : environ 250 ms par
   * vérification sur le matériel de 2026, ce qui rend le forçage hors ligne
   * d'une base dérobée économiquement inintéressant. Il est réglable pour une
   * seule raison légitime — descendre en dessous en **test**, où chaque
   * inscription paierait sinon ce quart de seconde.
   */
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),

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
    // Vérification croisée, inexprimable champ par champ : deux secrets égaux
    // annulent la séparation des usages décrite sur `JWT_REFRESH_SECRET`. Le cas
    // n'a rien de théorique — il s'écrit d'un copier-coller dans une définition
    // de tâche ECS, et rien ne le signalerait à l'exécution.
    if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
      throw new EnvValidationError([
        'JWT_REFRESH_SECRET : doit différer de JWT_SECRET — deux usages, deux clés',
      ]);
    }
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
