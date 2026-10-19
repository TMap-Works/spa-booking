import type { CopilotDomain, CopilotSession } from '@spa/shared';
import { exposedDomains } from '@spa/shared';
import { z } from 'zod';

import type { BrowserCall, ServerTool } from './claude-agent';
import { inputSchemaOf } from './tools';
import type { PendingWrite } from './writes';

/**
 * Les spécialistes, exposés à l'orchestrateur comme des outils — spécification
 * §6.2 et §6.2.3, P1-07.
 *
 * L'orchestrateur ne sait rien faire lui-même : il transmet un **brief** (la
 * demande reformulée et les faits établis, dates déjà résolues dans le fuseau
 * du salon), jamais la conversation. Le spécialiste, sans mémoire, rend un
 * résultat structuré. Sa réponse est **affichée telle quelle** (passe-plat) : le
 * tour de l'orchestrateur s'arrête sur l'appel, sans troisième appel pour la
 * reformuler.
 *
 * Un spécialiste dont aucune action n'est permise à la session n'est pas
 * exposé. Les spécialistes eux-mêmes arrivent avec leurs tickets — Réservation
 * (P2-01), Guide (P2-04), Rendez-vous (P3-02), Clients et Encaissement (P4).
 */

export const specialistBriefSchema = z
  .object({
    demande: z.string().trim().min(1).max(1_000),
    faits: z.record(z.string().max(200)).default({}),
  })
  .strict();

export type SpecialistBrief = z.infer<typeof specialistBriefSchema>;

export interface SpecialistResult {
  /** Ce que lit l'utilisateur, déjà rédigé. */
  readonly reponse: string;
  /** Navigations à exécuter dans la page. */
  readonly actionsFront: readonly BrowserCall[];
  /** Écriture préparée, en attente du clic « Valider » (P3-01) ; jamais exécutée par le spécialiste. */
  readonly confirmation: PendingWrite | null;
  /** Prochains pas cliquables, exécutés sans modèle. */
  readonly suggestions: readonly string[];
}

export interface Specialist {
  readonly domaine: CopilotDomain;
  /** Ce que l'orchestrateur lit pour décider de l'appeler. */
  readonly description: string;
  run(brief: SpecialistBrief, signal: AbortSignal): Promise<SpecialistResult>;
}

/** Nom de l'outil d'un spécialiste : `agent_reservation`, `agent_rendez_vous`… */
export function specialistToolName(domaine: CopilotDomain): string {
  return `agent_${domaine}`;
}

/**
 * Garde une écriture préparée et rend son identifiant ; `null` quand la
 * session ne peut pas écrire (visiteuse) — l'écriture est alors abandonnée.
 */
export type PrepareWrite = ((write: PendingWrite) => Promise<string>) | null;

export function specialistTools(
  session: CopilotSession,
  specialists: readonly Specialist[],
  prepareWrite: PrepareWrite = null,
): ServerTool[] {
  const exposed = new Set(exposedDomains(session));
  return specialists
    .filter((specialist) => exposed.has(specialist.domaine))
    .map((specialist) => ({
      name: specialistToolName(specialist.domaine),
      description: specialist.description,
      inputSchema: inputSchemaOf(specialistBriefSchema),
      async run(input, signal) {
        const parsed = specialistBriefSchema.safeParse(input);
        if (!parsed.success) {
          return { kind: 'resultat', contenu: 'Brief refusé : `demande` est obligatoire.', erreur: true };
        }
        const result = await specialist.run(parsed.data, signal);
        const navigateur: BrowserCall[] = [...result.actionsFront];
        let contenu = `Réponse donnée à l'utilisateur : ${result.reponse}`;
        if (result.confirmation !== null && prepareWrite !== null) {
          // L'écriture est gardée côté serveur ; la page ne reçoit que son
          // identifiant et ce qu'il faut afficher.
          const id = await prepareWrite(result.confirmation);
          navigateur.push({
            outil: 'confirmer',
            arguments: { id, titre: result.confirmation.recapitulatif.titre, lignes: [...result.confirmation.recapitulatif.lignes] },
          });
          contenu += ` Action proposée, en attente de sa validation : ${result.confirmation.recapitulatif.titre}.`;
        }
        return { kind: 'fin', contenu, texte: result.reponse, navigateur };
      },
    }));
}
