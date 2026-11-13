// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import {
  COPILOT_ACTION_IDS,
  COPILOT_ACTIONS,
  COPILOT_GUIDE_ROUTES,
  exposedDomains,
  meetsRequirement,
  PERMISSIONS,
  type CopilotSession,
  type Permission,
  type PublicTenant,
} from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { clientsSpecialist } from '@/lib/copilot/agents/clients';
import { encaissementSpecialist } from '@/lib/copilot/agents/encaissement';
import { guideSpecialist } from '@/lib/copilot/agents/guide';
import { rendezVousSpecialist } from '@/lib/copilot/agents/rendez-vous';
import { reservationSpecialist } from '@/lib/copilot/agents/reservation';
import { createOrchestrateur } from '@/lib/copilot/orchestrateur';
import { isSalonPath } from '@/lib/copilot/paths';
import type { ResolvedCopilotSession } from '@/lib/copilot/session';
import { specialistTools, specialistToolName, type Specialist } from '@/lib/copilot/specialists';
import { guideTool, toolNameOf } from '@/lib/copilot/tools';
import { decideWrite, MemoryPendingWriteStore, type PendingWrite } from '@/lib/copilot/writes';

/**
 * Fuite entre salons et élévation de rôle — P3-05 (#1465), CA-3 et CA-4.
 *
 * Chaque action du registre, pour chaque rôle : le modèle ne reçoit que les
 * outils que la session a le droit d'utiliser, ne navigue que dans le salon de
 * la session, et une écriture ne part que pour la personne qui l'a vue, dans
 * son salon, avec les droits qu'elle a **au moment du clic**. L'API revérifie
 * derrière avec le jeton ; ces tests tiennent la première ligne.
 */

const ALL: readonly Permission[] = PERMISSIONS;
const MANAGER = ALL.filter((p) => p !== 'accounts:write' && p !== 'settings:write');
const STAFF: Permission[] = ['agenda:read:own', 'appointment:write:own', 'customers:read:own'];

function sessionOf(role: CopilotSession['role'], slug = 'salon-lea'): CopilotSession {
  const surface = role === null ? 'visiteur' : role === 'client' ? 'client' : role === 'staff' ? 'praticien' : 'gerance';
  const permissions = role === 'admin' ? [...ALL] : role === 'manager' ? MANAGER : role === 'staff' ? STAFF : [];
  return { surface, role, permissions, tenant: { slug, timezone: 'Europe/Paris', currency: 'EUR' }, locale: 'fr' };
}

const SESSIONS = {
  visiteuse: sessionOf(null),
  cliente: sessionOf('client'),
  praticien: sessionOf('staff'),
  gerance: sessionOf('manager'),
  administratrice: sessionOf('admin'),
} as const;

const tenant = { name: 'Salon Léa', timezone: 'Europe/Paris', openingHours: [] } as unknown as PublicTenant;

/** Un faux Claude qui ne fait que noter les outils qu'on lui offre. */
function recordingClient() {
  const offered: string[][] = [];
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParams) => {
        offered.push((params.tools ?? []).map((tool) => ('name' in tool ? String(tool.name) : '')));
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok', citations: null }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    },
  } as unknown as Anthropic;
  return { client, offered };
}

function specialistsOf(session: CopilotSession, client: Anthropic): Specialist[] {
  // Un jeton est toujours présent : c'est le cas le plus large, et le rôle
  // seul doit borner ce qui est offert.
  const shared = { client, session, context: '', accessToken: 'jeton' };
  return [
    reservationSpecialist({ ...shared, services: async () => [] }),
    guideSpecialist({ ...shared, tenant, policy: async () => 'politique', services: async () => [] }),
    rendezVousSpecialist({ ...shared, services: async () => [] }),
    encaissementSpecialist(shared),
    clientsSpecialist(shared),
  ];
}

const actionOfTool = new Map(COPILOT_ACTION_IDS.map((id) => [toolNameOf(id), id]));
const signal = new AbortController().signal;

describe('élévation de rôle : les outils offerts au modèle', () => {
  for (const [name, session] of Object.entries(SESSIONS)) {
    it(`${name} : chaque outil d'un spécialiste correspond à une action permise`, async () => {
      const { client, offered } = recordingClient();
      for (const specialist of specialistsOf(session, client)) {
        await specialist.run({ demande: 'x', faits: {} }, signal);
      }
      const tools = offered.flat();
      for (const tool of tools) {
        const action = actionOfTool.get(tool);
        expect(action, `outil hors registre : ${tool}`).toBeDefined();
        expect(meetsRequirement(session, COPILOT_ACTIONS[action!].exige), `${name} reçoit ${tool}`).toBe(true);
      }
    });

    it(`${name} : l'orchestrateur ne délègue qu'aux domaines exposés`, () => {
      const { client } = recordingClient();
      const tools = specialistTools(session, specialistsOf(session, client), null).map((tool) => tool.name);
      const expected = specialistsOf(session, client)
        .filter((specialist) => exposedDomains(session).includes(specialist.domaine))
        .map((specialist) => specialistToolName(specialist.domaine));
      expect(tools.sort()).toEqual(expected.sort());
    });

    it(`${name} : le guide ne mène qu'aux écrans permis`, () => {
      const tool = guideTool(session);
      const offered = tool === null ? [] : (tool.inputSchema.properties as { route: { enum: string[] } }).route.enum;
      for (const route of Object.keys(COPILOT_GUIDE_ROUTES) as (keyof typeof COPILOT_GUIDE_ROUTES)[]) {
        expect(offered.includes(route), `${name} → ${route}`).toBe(meetsRequirement(session, COPILOT_GUIDE_ROUTES[route].exige));
      }
    });
  }

  it('une visiteuse ne reçoit aucun outil qui lit un compte ou écrit', async () => {
    const { client, offered } = recordingClient();
    for (const specialist of specialistsOf(SESSIONS.visiteuse, client)) {
      await specialist.run({ demande: 'x', faits: {} }, signal);
    }
    for (const tool of offered.flat()) {
      expect(COPILOT_ACTIONS[actionOfTool.get(tool)!].exige).toBe('public');
    }
  });

  it('la gérance, elle, reçoit bien ces outils — le filtre ne vide pas tout', async () => {
    const { client, offered } = recordingClient();
    for (const specialist of specialistsOf(SESSIONS.gerance, client)) {
      await specialist.run({ demande: 'x', faits: {} }, signal);
    }
    const tools = offered.flat();
    for (const expected of ['encaissement.a_regler', 'reporting.lire', 'clients.chercher', 'rendez_vous.poser'] as const) {
      expect(tools).toContain(toolNameOf(expected));
    }
  });

  it('un praticien ne reçoit ni encaissement, ni reporting, ni fichier client entier', async () => {
    const { client, offered } = recordingClient();
    for (const specialist of specialistsOf(SESSIONS.praticien, client)) {
      await specialist.run({ demande: 'x', faits: {} }, signal);
    }
    const tools = offered.flat();
    for (const forbidden of ['encaissement.a_regler', 'reporting.lire', 'tableau_de_bord.resumer', 'clients.chercher'] as const) {
      expect(tools).not.toContain(toolNameOf(forbidden));
    }
  });
});

describe('fuite entre salons', () => {
  it("le guide ne navigue que dans le salon de la session, et l'exécutant refuse tout autre salon", async () => {
    for (const session of Object.values(SESSIONS)) {
      const tool = guideTool(session);
      if (tool === null) continue;
      const routes = (tool.inputSchema.properties as { route: { enum: string[] } }).route.enum;
      for (const route of routes) {
        const outcome = await tool.run({ route }, signal);
        const chemins = outcome.kind === 'fin' ? (outcome.navigateur ?? []).map((call) => String(call.arguments.chemin)) : [];
        for (const chemin of chemins) {
          expect(isSalonPath(chemin, 'salon-lea'), chemin).toBe(true);
          expect(isSalonPath(chemin, 'salon-voisin')).toBe(false);
        }
      }
    }
  });

  it("l'exécutant naviguer refuse les adresses qui sortent du salon", () => {
    for (const chemin of [
      '/salon-voisin/admin/clients',
      '/salon-lea-bis/admin',
      '//evil.test/salon-lea',
      'https://evil.test/salon-lea/admin',
      '/salon-lea/../salon-voisin/admin',
      '/salon-lea\\..\\salon-voisin',
      'javascript:alert(1)',
    ]) {
      expect(isSalonPath(chemin, 'salon-lea'), chemin).toBe(false);
    }
    expect(isSalonPath('/salon-lea/admin/planning?vue=jour', 'salon-lea')).toBe(true);
  });

  it('la conversation est rangée sous le salon : même fil, autre salon, autre historique', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    const resolved = (slug: string): ResolvedCopilotSession => ({
      session: sessionOf('client', slug),
      accessToken: 'jeton',
      notice: null,
      subject: 'a'.repeat(32),
      tenant,
    });
    const lea = createOrchestrateur(resolved('salon-lea')).options.transcriptKey('fil');
    const voisin = createOrchestrateur(resolved('salon-voisin')).options.transcriptKey('fil');
    expect(lea).not.toBe(voisin);
    expect(voisin).toContain('salon-voisin');
    vi.unstubAllEnvs();
  });

  it("aucun paramètre du registre ne porte le salon : il vient toujours de la session", () => {
    for (const id of COPILOT_ACTION_IDS) {
      const schema = COPILOT_ACTIONS[id].parametres;
      if (!(schema instanceof z.ZodObject)) continue;
      const keys = Object.keys(schema.shape as Record<string, unknown>);
      expect(keys.filter((key) => /salon|tenant/i.test(key)), id).toEqual([]);
      // Un champ en trop est refusé, pas ignoré : on ne glisse pas un salon.
      expect(schema._def.unknownKeys, id).toBe('strict');
    }
  });
});

describe('écritures : la personne, le salon, les droits du moment', () => {
  const write: PendingWrite = {
    action: 'rendez_vous.marquer_honore',
    parametres: { rendezVous: '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69' },
    recapitulatif: { titre: 'Marquer honoré', lignes: [] },
    succes: 'Fait.',
  };
  const lea = { tenantSlug: 'salon-lea', subject: 'a'.repeat(32) };

  async function decide(
    scope: { tenantSlug: string; subject: string },
    session: CopilotSession,
    prepared = lea,
  ) {
    const store = new MemoryPendingWriteStore();
    const id = await store.put(prepared, write);
    const execute = vi.fn(async () => undefined);
    const outcome = await decideWrite({
      store,
      executors: { 'rendez_vous.marquer_honore': execute },
      scope,
      accessToken: 'jeton',
      id,
      decision: 'valider',
      session,
    });
    return { outcome, execute };
  }

  it('la même personne dans un autre salon ne retrouve pas l’écriture', async () => {
    const { outcome, execute } = await decide({ ...lea, tenantSlug: 'salon-voisin' }, sessionOf('staff', 'salon-voisin'));
    expect(outcome.statut).toBe('echec');
    expect(execute).not.toHaveBeenCalled();
  });

  it('une autre personne du même salon ne la retrouve pas', async () => {
    const { outcome, execute } = await decide({ ...lea, subject: 'b'.repeat(32) }, SESSIONS.gerance);
    expect(outcome.statut).toBe('echec');
    expect(execute).not.toHaveBeenCalled();
  });

  it('un rôle retiré entre la proposition et le clic ne valide plus rien', async () => {
    const { outcome, execute } = await decide(lea, SESSIONS.cliente);
    expect(outcome).toEqual({ statut: 'echec', message: "Vous n'avez pas le droit de faire cette action." });
    expect(execute).not.toHaveBeenCalled();
  });

  it("l'exécution reçoit le salon de la session, jamais un salon des paramètres", async () => {
    const store = new MemoryPendingWriteStore();
    const id = await store.put(lea, { ...write, parametres: { ...write.parametres, tenantSlug: 'salon-voisin' } });
    const execute = vi.fn(async () => undefined);
    await decideWrite({
      store,
      executors: { 'rendez_vous.marquer_honore': execute },
      scope: lea,
      accessToken: 'jeton',
      id,
      decision: 'valider',
      session: SESSIONS.praticien,
    });
    expect(execute).toHaveBeenCalledWith(expect.anything(), { accessToken: 'jeton', tenantSlug: 'salon-lea' });
  });

  it('chaque action qui écrit exige plus que « public »', () => {
    for (const id of COPILOT_ACTION_IDS) {
      if (COPILOT_ACTIONS[id].confirmation) expect(COPILOT_ACTIONS[id].exige, id).not.toBe('public');
    }
  });
});
