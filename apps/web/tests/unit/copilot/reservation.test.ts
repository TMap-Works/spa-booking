// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import type { AvailabilityResponse, CopilotSession, PublicService } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { reservationSpecialist } from '@/lib/copilot/agents/reservation';

/**
 * Le spécialiste Réservation (P2-01) contre un faux Claude et une fausse API :
 * le scénario de la priorité 1, « un massage demain après-midi », doit finir
 * sur le tunnel filtré, et ne citer que des horaires que l'API a rendus.
 */

const MASSAGE = '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const LEA = '1c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';

const services = [
  {
    id: MASSAGE,
    name: 'Massage relaxant',
    description: null,
    durationMinutes: 60,
    price: { amountMinor: 7000, currency: 'EUR' },
    category: { name: 'Massages' },
    staff: [{ id: LEA, displayName: 'Léa' }],
  },
  {
    id: '2c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69',
    name: 'Coupe et brushing',
    description: null,
    durationMinutes: 45,
    price: { amountMinor: 4500, currency: 'EUR' },
    category: { name: 'Coiffure' },
    staff: [],
  },
] as unknown as PublicService[];

const session: CopilotSession = {
  surface: 'visiteur',
  role: null,
  permissions: [],
  tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
  locale: 'fr',
};

type Reply = Pick<Anthropic.Message, 'content' | 'stop_reason'>;

function fakeClaude(replies: Reply[]) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        const reply = replies.shift();
        if (!reply) throw new Error('aucune réponse prévue');
        return { ...reply, usage: { input_tokens: 10, output_tokens: 5 } };
      }),
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ToolUseBlock;
const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Anthropic.TextBlock;

const availability: AvailabilityResponse = {
  serviceId: MASSAGE,
  timezone: 'Europe/Paris',
  days: [
    {
      date: '2026-10-20',
      slots: [
        // 07:00Z = 09:00 à Paris (matin), 12:00Z = 14:00, 13:30Z = 15:30 (après-midi).
        { startsAt: '2026-10-20T07:00:00Z', endsAt: '2026-10-20T08:00:00Z', staffId: LEA },
        { startsAt: '2026-10-20T12:00:00Z', endsAt: '2026-10-20T13:00:00Z', staffId: LEA },
        { startsAt: '2026-10-20T13:30:00Z', endsAt: '2026-10-20T14:30:00Z', staffId: LEA },
      ],
    },
  ],
};

function specialist(replies: Reply[], fetchAvailability = vi.fn(async () => availability)) {
  const { client, calls } = fakeClaude(replies);
  const agent = reservationSpecialist({
    client,
    session,
    context: '<contexte_session>Aujourd’hui : lundi 2026-10-19</contexte_session>',
    services: async () => services,
    availability: fetchAvailability,
  });
  return { agent, calls, fetchAvailability };
}

const signal = new AbortController().signal;

describe('spécialiste Réservation', () => {
  it('« un massage demain après-midi » ouvre le tunnel filtré, avec les seuls horaires de l’après-midi', async () => {
    const { agent, calls, fetchAvailability } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'catalogue_chercher', { recherche: 'massage' })] },
      {
        stop_reason: 'tool_use',
        content: [
          use('t2', 'disponibilite_creneaux', { prestation: MASSAGE, jour: '2026-10-20', plage: 'apres-midi' }),
        ],
      },
      {
        stop_reason: 'tool_use',
        content: [
          use('t3', 'reservation_ouvrir_tunnel', { prestation: MASSAGE, jour: '2026-10-20', plage: 'apres-midi' }),
        ],
      },
      { stop_reason: 'end_turn', content: [text('Léa est libre demain à 14 h et 15 h 30. Je vous ouvre la réservation.')] },
    ]);

    const result = await agent.run({ demande: 'Un massage le 2026-10-20 après-midi', faits: {} }, signal);

    expect(result.reponse).toBe('Léa est libre demain à 14 h et 15 h 30. Je vous ouvre la réservation.');
    expect(result.actionsFront).toEqual([
      {
        outil: 'naviguer',
        arguments: {
          chemin: `/salon-lea/reservation?etape=creneau&prestation=${MASSAGE}&jour=2026-10-20&plage=apres-midi`,
        },
      },
    ]);
    expect(fetchAvailability).toHaveBeenCalledWith('salon-lea', { serviceId: MASSAGE, from: '2026-10-20', to: '2026-10-20' });

    // Ce que Claude a lu des créneaux : l'après-midi seul, à l'heure du salon.
    const slotsResult = (calls[2]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(slotsResult.content).toContain('14:00');
    expect(slotsResult.content).toContain('15:30');
    expect(slotsResult.content).not.toContain('09:00');

    // Le brief arrive seul, sans conversation, après le contexte du serveur.
    expect(calls[0]?.messages).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('tool_choice');
  });

  it('refuse une prestation que le catalogue ne connaît pas', async () => {
    const { agent, calls } = specialist([
      {
        stop_reason: 'tool_use',
        content: [use('t1', 'reservation_ouvrir_tunnel', { prestation: '9b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69' })],
      },
      { stop_reason: 'end_turn', content: [text('Je ne trouve pas cette prestation.')] },
    ]);

    const result = await agent.run({ demande: 'Un soin inventé', faits: {} }, signal);

    const refused = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(refused.is_error).toBe(true);
    expect(result.actionsFront).toEqual([]);
  });

  it('rejette des paramètres mal formés avant toute lecture', async () => {
    const { agent, fetchAvailability } = specialist([
      {
        stop_reason: 'tool_use',
        content: [use('t1', 'disponibilite_creneaux', { prestation: MASSAGE, jour: 'demain' })],
      },
      { stop_reason: 'end_turn', content: [text('Pour quel jour ?')] },
    ]);

    await agent.run({ demande: 'Un massage demain', faits: {} }, signal);
    expect(fetchAvailability).not.toHaveBeenCalled();
  });

  it('dit simplement qu’il n’y a pas de créneau, sans en inventer', async () => {
    const empty = vi.fn(async () => ({ ...availability, days: [{ date: '2026-10-20', slots: [] }] }));
    const { agent, calls } = specialist(
      [
        {
          stop_reason: 'tool_use',
          content: [use('t1', 'disponibilite_creneaux', { prestation: MASSAGE, jour: '2026-10-20', plage: 'soir' })],
        },
        { stop_reason: 'end_turn', content: [text('Aucun créneau demain soir.')] },
      ],
      empty,
    );

    await agent.run({ demande: 'Un massage demain soir', faits: {} }, signal);
    const result = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result.content).toBe('Aucun créneau libre le 2026-10-20 (soir).');
  });

  it('un refus de Claude donne une réponse neutre, sans navigation', async () => {
    const { agent } = specialist([{ stop_reason: 'refusal', content: [] }]);
    const result = await agent.run({ demande: 'x', faits: {} }, signal);
    expect(result.reponse).toContain('page de réservation');
    expect(result.actionsFront).toEqual([]);
  });
});
