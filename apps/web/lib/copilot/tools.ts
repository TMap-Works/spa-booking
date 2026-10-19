import type Anthropic from '@anthropic-ai/sdk';
import {
  COPILOT_ACTIONS,
  COPILOT_GUIDE_ROUTES,
  permittedGuideRoutes,
  type CopilotActionId,
  type CopilotActionParams,
  type CopilotSession,
} from '@spa/shared';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ServerTool, ServerToolOutcome } from './claude-agent';

/**
 * Les actions du registre (P1-02) mises en forme d'outils serveur — P1-07.
 *
 * Le nom d'un outil Claude n'admet ni point ni espace : `guide.mener` devient
 * `guide_mener`. La description et le schéma viennent du registre, et le schéma
 * Zod **valide l'appel du modèle** avant toute exécution (spécification §6.3) :
 * un paramètre inventé ou mal formé revient au modèle comme une erreur à
 * corriger, il n'atteint jamais l'API.
 *
 * `strict` n'est pas demandé : les schémas du registre portent des formats et
 * des motifs que le mode strict de l'API n'accepte pas tous. La validation Zod
 * en tient lieu, côté serveur.
 */

export function toolNameOf(id: CopilotActionId): string {
  return id.replace('.', '_');
}

export function inputSchemaOf(schema: z.ZodTypeAny): Anthropic.Tool.InputSchema {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

/** Résumé d'une validation refusée, lisible par le modèle — sans écho de la valeur reçue. */
function invalid(error: z.ZodError): ServerToolOutcome {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || 'paramètres'} : ${issue.code}`);
  return { kind: 'resultat', contenu: `Paramètres refusés (${issues.join(' ; ')}). Corrige l'appel.`, erreur: true };
}

export function registryTool<Id extends CopilotActionId>(
  id: Id,
  execute: (params: CopilotActionParams<Id>, signal: AbortSignal) => Promise<ServerToolOutcome>,
  schema: z.ZodTypeAny = COPILOT_ACTIONS[id].parametres,
): ServerTool {
  return {
    name: toolNameOf(id),
    description: COPILOT_ACTIONS[id].description,
    inputSchema: inputSchemaOf(schema),
    async run(input, signal) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);
      return execute(parsed.data as CopilotActionParams<Id>, signal);
    },
  };
}

/**
 * `guide.mener`, restreint aux destinations que la session peut ouvrir : le
 * modèle ne voit que celles-là dans l'énumération, et une autre serait refusée
 * par le schéma. L'outil arrête le tour sur une navigation (passe-plat) : la
 * phrase d'annonce, Claude l'a écrite avant l'appel.
 */
export function guideTool(session: CopilotSession): ServerTool | null {
  const routes = permittedGuideRoutes(session);
  if (routes.length === 0) return null;
  const schema = z.object({ route: z.enum(routes as [string, ...string[]]) }).strict();

  return registryTool(
    'guide.mener',
    async ({ route }) => {
      const chemin = `/${session.tenant.slug}${COPILOT_GUIDE_ROUTES[route].chemin}`;
      return {
        kind: 'fin',
        contenu: `Navigation lancée vers ${chemin}.`,
        navigateur: [{ outil: 'naviguer', arguments: { chemin } }],
      };
    },
    schema,
  );
}
