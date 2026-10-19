/**
 * Réglages du copilot, lus côté serveur seulement (ADR 0018,
 * spécification §6.4).
 *
 * Rien ici n'est préfixé `NEXT_PUBLIC_` : la clé Anthropic et le choix des
 * modèles ne quittent jamais le serveur.
 */

/** Les agents du copilot (spécification §6.2). Le spike n'en câble qu'un. */
export type CopilotAgentName =
  | 'orchestrateur'
  | 'reservation'
  | 'guide'
  | 'rendez_vous'
  | 'clients'
  | 'encaissement';

/** Haiku 5.5 par défaut ; Sonnet 5.5 agent par agent, quand l'évaluation le justifie (§6.4.1). */
const DEFAULT_MODEL = 'claude-haiku-5-5';

/**
 * Le modèle d'un agent : `COPILOT_MODEL_<AGENT>`, sinon `COPILOT_MODEL_DEFAULT`.
 *
 * Fixé **par agent** et non par message : un bloc de réflexion ne se relit que
 * sur le modèle qui l'a produit, et changer de modèle en cours de conversation
 * en perdrait la réflexion (ADR 0018, « Conséquences »).
 */
export function copilotModel(agent: CopilotAgentName, env: NodeJS.ProcessEnv = process.env): string {
  return env[`COPILOT_MODEL_${agent.toUpperCase()}`] || env.COPILOT_MODEL_DEFAULT || DEFAULT_MODEL;
}

/**
 * Le copilot n'est ouvert que si la clé est posée **et** qu'on l'a voulu :
 * `COPILOT_ENABLED=true`, que Terraform pose avec la clé (`copilot_enabled`,
 * P1-03). En développement local, la clé seule suffit — c'est le banc d'essai.
 *
 * Une image déployée tourne en `NODE_ENV=production` : il lui faut le drapeau
 * **et** `REDIS_URL` (P1-08), posés ensemble par Terraform.
 */
export function copilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.ANTHROPIC_API_KEY) return false;
  if (env.NODE_ENV !== 'production') return true;
  // Déployé, il faut aussi Redis : sans lui, l'historique et les quotas
  // vivraient dans chaque tâche, et les quotas ne borneraient plus rien.
  return env.COPILOT_ENABLED === 'true' && Boolean(env.REDIS_URL);
}
