// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import { PERMISSIONS, type CopilotSession, type CustomerPage } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { clientsSpecialist } from '@/lib/copilot/agents/clients';

/** Le spécialiste Clients (P4-02) : des noms dans la conversation, les coordonnées sur la fiche. */

const MARIE = '3e6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const MANAGER = PERMISSIONS.filter((p) => p !== 'accounts:write' && p !== 'settings:write');
const session: CopilotSession = {
  surface: 'gerance',
  role: 'manager',
  permissions: MANAGER,
  tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
  locale: 'fr',
};
const page = {
  items: [{ id: MARIE, firstName: 'Marie', lastName: 'Dupont', email: 'marie@example.test', phone: '+33612345678', isActive: true }],
  page: 1,
  pageSize: 8,
  total: 1,
  totalPages: 1,
} as unknown as CustomerPage;

type Reply = Pick<Anthropic.Message, 'content' | 'stop_reason'>;
const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ToolUseBlock;
const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Anthropic.TextBlock;

function specialist(replies: Reply[], s: CopilotSession = session) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        return { ...replies.shift()!, usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    },
  } as unknown as Anthropic;
  const customers = vi.fn(async () => page);
  return { agent: clientsSpecialist({ client, session: s, accessToken: 'jeton', context: '', customers }), calls, customers };
}

const signal = new AbortController().signal;

describe('spécialiste Clients', () => {
  it('cherche par téléphone sans relire le numéro, et ouvre la fiche filtrée', async () => {
    const { agent, calls, customers } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'clients_chercher', { recherche: '0612345678' })] },
      { stop_reason: 'tool_use', content: [use('t2', 'clients_ouvrir_fiche', { cliente: MARIE })] },
      { stop_reason: 'end_turn', content: [text('C’est Marie Dupont : je vous ouvre sa fiche.')] },
    ]);

    const result = await agent.run({ demande: 'À qui est le 06 12 34 56 78 ?', faits: {} }, signal);

    expect(customers).toHaveBeenCalledWith('jeton', { q: '0612345678', pageSize: 8 });
    const found = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!.content as string;
    expect(found).toContain('Marie Dupont');
    expect(found).not.toContain('+33612345678');
    expect(found).not.toContain('marie@example.test');
    expect(result.actionsFront).toEqual([
      { outil: 'naviguer', arguments: { chemin: `/salon-lea/admin/clients?recherche=0612345678&fiche=${MARIE}` } },
    ]);
  });

  it('refuse d’ouvrir une fiche qui n’a pas été cherchée', async () => {
    const { agent } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'clients_ouvrir_fiche', { cliente: MARIE })] },
      { stop_reason: 'end_turn', content: [text('Je dois d’abord la chercher.')] },
    ]);
    expect((await agent.run({ demande: 'x', faits: {} }, signal)).actionsFront).toEqual([]);
  });

  it('un praticien n’a pas accès au fichier entier', async () => {
    const { agent, calls } = specialist([{ stop_reason: 'end_turn', content: [text('…')] }], {
      ...session,
      surface: 'praticien',
      role: 'staff',
      permissions: ['agenda:read:own', 'customers:read:own'],
    });
    await agent.run({ demande: 'x', faits: {} }, signal);
    expect(calls[0]?.tools ?? []).toEqual([]);
  });
});
