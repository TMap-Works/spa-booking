// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import type { AvailabilityResponse, BookedAppointment, CopilotSession, PublicService } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { rendezVousSpecialist } from '@/lib/copilot/agents/rendez-vous';

/**
 * Le spécialiste Rendez-vous côté cliente (P3-02) : il lit, il propose, il
 * n'écrit jamais. Faux Claude, fausse API.
 */

const apiMock = vi.hoisted(() => ({ rescheduleAppointment: vi.fn(), cancelAppointment: vi.fn() }));
vi.mock('@/lib/api-client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api-client')>()),
  ...apiMock,
}));

const MASSAGE = '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const LEA = '1c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const RDV = '2d6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';

const services = [
  { id: MASSAGE, name: 'Massage relaxant', durationMinutes: 60, staff: [{ id: LEA, displayName: 'Léa' }] },
] as unknown as PublicService[];

const appointment = {
  id: RDV,
  status: 'confirmed',
  serviceId: MASSAGE,
  staffId: LEA,
  startsAt: '2026-10-22T12:00:00Z',
  endsAt: '2026-10-22T13:00:00Z',
} as unknown as BookedAppointment;

const availability: AvailabilityResponse = {
  serviceId: MASSAGE,
  timezone: 'Europe/Paris',
  days: [{ date: '2026-10-23', slots: [{ startsAt: '2026-10-23T13:30:00Z', endsAt: '2026-10-23T14:30:00Z', staffId: LEA }] }],
};

function session(role: CopilotSession['role'], permissions: CopilotSession['permissions'] = []): CopilotSession {
  return {
    surface: role === 'client' ? 'client' : role === 'staff' ? 'praticien' : 'gerance',
    role,
    permissions,
    tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
    locale: 'fr',
  };
}

type Reply = Pick<Anthropic.Message, 'content' | 'stop_reason'>;
const use = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ToolUseBlock;
const text = (value: string) => ({ type: 'text', text: value, citations: null }) as Anthropic.TextBlock;

function specialist(replies: Reply[], s: CopilotSession = session('client')) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        const reply = replies.shift();
        if (!reply) throw new Error('aucune réponse prévue');
        return { ...reply, usage: { input_tokens: 1, output_tokens: 1 } };
      }),
    },
  } as unknown as Anthropic;
  const myAppointments = vi.fn(async () => [appointment]);
  const agent = rendezVousSpecialist({
    client,
    session: s,
    accessToken: 'jeton',
    context: '<contexte_session>Aujourd’hui : lundi 2026-10-19</contexte_session>',
    services: async () => services,
    availability: async () => availability,
    myAppointments,
  });
  return { agent, calls, myAppointments };
}

const signal = new AbortController().signal;

describe('spécialiste Rendez-vous — cliente', () => {
  it('« reporte mon massage à vendredi après-midi » prépare une carte, sans rien écrire', async () => {
    const { agent, myAppointments } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'rendez_vous_mes_prochains', {})] },
      {
        stop_reason: 'tool_use',
        content: [use('t2', 'disponibilite_creneaux', { prestation: MASSAGE, jour: '2026-10-23', plage: 'apres-midi' })],
      },
      {
        stop_reason: 'tool_use',
        content: [use('t3', 'rendez_vous_reporter', { rendezVous: RDV, debut: '2026-10-23T15:30:00+02:00', praticien: LEA })],
      },
      { stop_reason: 'end_turn', content: [text('Je vous propose vendredi à 15 h 30 avec Léa : validez sur la carte.')] },
    ]);

    const result = await agent.run({ demande: 'Reporter le massage au 2026-10-23 après-midi', faits: {} }, signal);

    expect(result.reponse).toContain('validez sur la carte');
    expect(result.confirmation).toMatchObject({
      action: 'rendez_vous.reporter',
      parametres: { rendezVous: RDV, debut: '2026-10-23T15:30:00+02:00', praticien: LEA },
      recapitulatif: { titre: 'Déplacer votre Massage relaxant' },
    });
    expect(result.confirmation?.recapitulatif.lignes[1]).toContain('Léa');
    expect(result.confirmation?.succes).toContain("C'est fait");
    expect(apiMock.rescheduleAppointment).not.toHaveBeenCalled();
    // La liste à venir est lue une seule fois par appel.
    expect(myAppointments).toHaveBeenCalledTimes(1);
    expect(myAppointments).toHaveBeenCalledWith('jeton', { scope: 'upcoming', limit: 20 });
  });

  it('refuse de proposer sur un rendez-vous qui n’est pas le sien', async () => {
    const { agent, calls } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'rendez_vous_annuler', { rendezVous: '9d6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69' })] },
      { stop_reason: 'end_turn', content: [text('Je ne trouve pas ce rendez-vous.')] },
    ]);

    const result = await agent.run({ demande: 'Annuler', faits: {} }, signal);

    expect(result.confirmation).toBeNull();
    const refused = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(refused.is_error).toBe(true);
  });

  it("ouvre l'écran de report sur le mois demandé", async () => {
    const { agent } = specialist([
      { stop_reason: 'tool_use', content: [use('t1', 'rendez_vous_ouvrir_report', { rendezVous: RDV, mois: '2026-11' })] },
      { stop_reason: 'end_turn', content: [text('Je vous ouvre le report.')] },
    ]);

    const result = await agent.run({ demande: 'Reporter en novembre', faits: {} }, signal);
    expect(result.actionsFront).toEqual([
      { outil: 'naviguer', arguments: { chemin: `/salon-lea/compte/rendez-vous/${RDV}/report?mois=2026-11` } },
    ]);
  });

  it('ne donne au praticien aucun outil de la cliente', async () => {
    const { agent, calls } = specialist(
      [{ stop_reason: 'end_turn', content: [text('…')] }],
      session('staff', ['agenda:read:own', 'appointment:write:own', 'customers:read:own']),
    );
    await agent.run({ demande: 'Mes rendez-vous', faits: {} }, signal);
    const names = calls[0]?.tools?.map((tool) => (tool as Anthropic.Tool).name) ?? [];
    expect(names).not.toContain('rendez_vous_reporter');
    expect(names).not.toContain('rendez_vous_mes_prochains');
  });
});

describe('exécutants des écritures de la cliente', () => {
  it('le report passe par le schéma partagé, avec le jeton de la session', async () => {
    const { WRITE_EXECUTORS } = await import('@/lib/copilot/runtime');
    await WRITE_EXECUTORS['rendez_vous.reporter']!(
      { rendezVous: RDV, debut: '2026-10-23T15:30:00+02:00', praticien: LEA },
      { accessToken: 'jeton', tenantSlug: 'salon-lea' },
    );
    expect(apiMock.rescheduleAppointment).toHaveBeenCalledWith('salon-lea', RDV, 'jeton', {
      startsAt: '2026-10-23T13:30:00.000Z',
      staffId: LEA,
    });
  });

  it("l'annulation transmet le motif, et seulement s'il y en a un", async () => {
    const { WRITE_EXECUTORS } = await import('@/lib/copilot/runtime');
    await WRITE_EXECUTORS['rendez_vous.annuler']!({ rendezVous: RDV }, { accessToken: 'jeton', tenantSlug: 'salon-lea' });
    expect(apiMock.cancelAppointment).toHaveBeenCalledWith('salon-lea', RDV, 'jeton', {});
  });
});
