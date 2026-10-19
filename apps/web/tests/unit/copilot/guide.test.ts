// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import type { CopilotSession, PublicTenant } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { dataPolicyText, guideSpecialist } from '@/lib/copilot/agents/guide';

/** Le spécialiste Guide (P2-04) : il explique, il mène, il ne fait pas. */

const session = (role: CopilotSession['role']): CopilotSession => ({
  surface: role === null ? 'visiteur' : role === 'client' ? 'client' : 'gerance',
  role,
  permissions: [],
  tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
  locale: 'fr',
});
const tenant = { name: 'Salon Léa', contactEmail: 'contact@salon-lea.test' } as unknown as PublicTenant;

type Reply = Pick<Anthropic.Message, 'content' | 'stop_reason'>;
const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ToolUseBlock;
const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Anthropic.TextBlock;

function guide(replies: Reply[], s: CopilotSession) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        return { ...replies.shift()!, usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    },
  } as unknown as Anthropic;
  const policy = vi.fn(async () => 'Responsable : Salon Léa.\n- E-mail : confirmer le rendez-vous.');
  return { agent: guideSpecialist({ client, session: s, tenant, context: '', policy }), calls, policy };
}

const signal = new AbortController().signal;

describe('spécialiste Guide', () => {
  it('« où je change mon téléphone ? » mène à ses coordonnées', async () => {
    const { agent } = guide(
      [
        { stop_reason: 'tool_use', content: [use('t1', 'guide_mener', { route: 'coordonnees' })] },
        { stop_reason: 'end_turn', content: [text('Dans « Mes coordonnées » : je vous y emmène.')] },
      ],
      session('client'),
    );

    const result = await agent.run({ demande: 'Changer mon téléphone', faits: {} }, signal);
    expect(result.actionsFront).toEqual([
      { outil: 'naviguer', arguments: { chemin: '/salon-lea/compte/coordonnees' } },
    ]);
  });

  it("ne mène une visiteuse qu'aux écrans publics", async () => {
    const { agent, calls } = guide(
      [
        { stop_reason: 'tool_use', content: [use('t1', 'guide_mener', { route: 'reglages' })] },
        { stop_reason: 'end_turn', content: [text('Cet écran est réservé au salon.')] },
      ],
      session(null),
    );

    const result = await agent.run({ demande: 'Les réglages', faits: {} }, signal);
    expect(result.actionsFront).toEqual([]);
    const schema = calls[0]?.tools?.find((tool) => (tool as Anthropic.Tool).name === 'guide_mener') as Anthropic.Tool;
    expect((schema.input_schema.properties as { route: { enum: string[] } }).route.enum).toEqual([
      'politique_donnees',
      'connexion',
      'inscription',
    ]);
  });

  it('répond sur les données à partir de la politique du salon', async () => {
    const { agent, calls, policy } = guide(
      [
        { stop_reason: 'tool_use', content: [use('t1', 'salon_politique_donnees', {})] },
        { stop_reason: 'end_turn', content: [text('Votre e-mail sert à confirmer le rendez-vous.')] },
      ],
      session(null),
    );

    await agent.run({ demande: 'À quoi sert mon e-mail ?', faits: {} }, signal);
    expect(policy).toHaveBeenCalledWith('fr');
    const read = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!.content;
    expect(read).toContain('Responsable : Salon Léa.');
  });
});

describe('dataPolicyText', () => {
  it('assemble responsable, finalités sans doublon et droits', () => {
    const booking = {
      intro: '',
      label: '',
      summary: 'Résumé.',
      rights: 'Vos droits.',
      purposes: [{ data: 'E-mail', why: 'confirmer' }],
    };
    const account = { ...booking, purposes: [{ data: 'E-mail', why: 'identifiant' }, { data: 'Mot de passe', why: 'se connecter' }] };
    expect(dataPolicyText(tenant, booking, account)).toBe(
      'Responsable : Salon Léa, contact@salon-lea.test.\nRésumé.\n- E-mail : confirmer\n- Mot de passe : se connecter\nVos droits.',
    );
  });
});
