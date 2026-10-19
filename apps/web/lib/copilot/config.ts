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
 * Le copilot n'est ouvert que si la clé est posée, et — tant que la session
 * (P1-05) et les quotas (P1-08) ne sont pas livrés — jamais en production :
 * une route qui dépense des tokens sans savoir pour qui ne doit pas être
 * joignable.
 */
export function copilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && env.NODE_ENV !== 'production';
}
