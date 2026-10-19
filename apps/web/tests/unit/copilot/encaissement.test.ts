// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import { PERMISSIONS, type Appointment, type CopilotSession } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { encaissementSpecialist } from '@/lib/copilot/agents/encaissement';

/**
 * Le spécialiste Encaissement et reporting (P4-01) : il lit comme les écrans,
 * mène avec leurs filtres, et n'encaisse jamais.
 */

const MANAGER = PERMISSIONS.filter((p) => p !== 'accounts:write' && p !== 'settings:write');
const session: CopilotSession = {
  surface: 'gerance',
  role: 'manager',
  permissions: MANAGER,
  tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
  locale: 'fr',
};

const RDV_A = '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const RDV_B = '1c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';

const appointment = (id: string, startsAt: string): Appointment =>
  ({
    id,
    status: 'completed',
    startsAt,
    endsAt: startsAt,
    service: { id: 's', name: 'Massage relaxant' },
    staff: { id: 'p', displayName: 'Léa' },
    client: { id: 'c', firstName: 'Marie', lastName: 'Dupont', email: 'marie@example.test' },
    price: { amountMinor: 7000, currency: 'EUR' },
    clientNote: 'Allergie',
  }) as unknown as Appointment;

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
  const deps = {
    appointments: vi.fn(async () => [appointment(RDV_A, '2026-10-19T08:00:00Z'), appointment(RDV_B, '2026-10-19T12:00:00Z')]),
    // RDV_B est réglé ; RDV_A ne l'est pas.
    settlements: vi.fn(async () => [{ appointmentId: RDV_B, status: 'succeeded' }] as never),
    tickets: vi.fn(async () => new Map()),
    revenue: vi.fn(async () => ({ totals: [{ currency: 'EUR', netAmountMinor: 14000 }] }) as never),
    volume: vi.fn(async () => ({ rows: [{ key: 'p', label: 'Léa', total: 2 }] }) as never),
    noShows: vi.fn(async () => ({ noShows: 1, total: 10, rate: 0.1 }) as never),
  };
  const agent = encaissementSpecialist({ client, session: s, accessToken: 'jeton', context: '', ...deps });
  return { agent, calls, deps };
}

const signal = new AbortController().signal;
const lastResult = (calls: Anthropic.MessageCreateParams[], index: number) =>
  ((calls[index]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!.content as string);

describe('spécialiste Encaissement et reporting', () => {
  it('« qui reste à encaisser ? » ne liste que ce qui n’est pas réglé, sans coordonnées', async () => {
    const { agent, calls } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'encaissement_a_regler', { jour: '2026-10-19' })] },
      { stop_reason: 'tool_use', content: [use('t2', 'encaissement_ouvrir', { date: '2026-10-19', rendezVous: RDV_A })] },
      { stop_reason: 'end_turn', content: [text('Il reste Marie D. à 10 h : je vous ouvre son encaissement.')] },
    ]);

    const result = await agent.run({ demande: 'Qui reste à encaisser aujourd’hui ?', faits: {} }, signal);

    const listed = lastResult(calls, 1);
    expect(listed).toContain(RDV_A);
    expect(listed).not.toContain(RDV_B);
    expect(listed).toContain('Marie D.');
    expect(listed).not.toContain('Dupont');
    expect(listed).not.toContain('Allergie');
    expect(listed).toMatch(/70,00\s€/);
    expect(result.actionsFront).toEqual([
      { outil: 'naviguer', arguments: { chemin: `/salon-lea/admin/encaissement?date=2026-10-19&rdv=${RDV_A}` } },
    ]);
    expect(result.confirmation).toBeNull();
  });

  it('lit une période et ouvre le reporting sur les mêmes dates', async () => {
    const { agent, calls, deps } = specialist([
      {
        stop_reason: 'tool_use',
        content: [use('t1', 'reporting_lire', { du: '2026-10-01', au: '2026-10-19', regroupement: 'praticien' })],
      },
      { stop_reason: 'tool_use', content: [use('t2', 'reporting_ouvrir', { du: '2026-10-01', au: '2026-10-19' })] },
      { stop_reason: 'end_turn', content: [text('140 € nets en octobre ; je vous ouvre le détail.')] },
    ]);

    const result = await agent.run({ demande: 'Chiffre d’affaires d’octobre', faits: {} }, signal);

    expect(deps.volume).toHaveBeenCalledWith('jeton', expect.any(Object), 'staff');
    const read = lastResult(calls, 1);
    expect(read).toMatch(/140,00\s€/);
    expect(read).toContain('Léa: 2 rendez-vous');
    expect(read).toContain('Absences : 1 sur 10 rendez-vous (10 %)');
    expect(result.actionsFront).toEqual([
      {
        outil: 'naviguer',
        arguments: { chemin: '/salon-lea/admin/reporting?periode=personnalisee&du=2026-10-01&au=2026-10-19' },
      },
    ]);
  });

  it("n'offre rien à un praticien", async () => {
    const { agent, calls } = specialist(
      [{ stop_reason: 'end_turn', content: [text('…')] }],
      { ...session, surface: 'praticien', role: 'staff', permissions: ['agenda:read:own', 'appointment:write:own'] },
    );
    await agent.run({ demande: 'x', faits: {} }, signal);
    expect(calls[0]?.tools ?? []).toEqual([]);
  });
});
