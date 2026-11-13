// @vitest-environment node

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AvailabilityResponse, PublicService, PublicTenant } from '@spa/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ResolvedCopilotSession } from '@/lib/copilot/session';

/**
 * CA-1, de bout en bout côté serveur — P2-05 (#1460).
 *
 * « Je veux un massage demain après-midi » traverse la **vraie** route du
 * copilot : runtime CopilotKit, orchestrateur, spécialiste Réservation, outils,
 * flux AG-UI rendu au navigateur. Seuls deux bouts sont simulés :
 *
 * - **le modèle** — un faux Claude HTTP, branché par `ANTHROPIC_BASE_URL` comme
 *   le SDK le permet, sans rien changer au code produit. Il joue le scénario
 *   en lisant ce qu'on lui envoie : la date du jour dans `<contexte_session>`,
 *   l'identifiant de la prestation dans `<catalogue>` ;
 * - **l'API du salon** — catalogue et créneaux.
 *
 * Ce qui est prouvé : la page reçoit l'ordre de naviguer vers le tunnel
 * **filtré** sur la prestation, le jour et la plage, et la réponse affichée ne
 * cite que des horaires de l'après-midi, à l'heure du salon.
 */

const MASSAGE = '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';
const LEA = '1c6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69';

const tenant = {
  name: 'Salon Léa',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
  openingHours: [],
} as unknown as PublicTenant;

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
] as unknown as PublicService[];

const apiMock = vi.hoisted(() => ({ fetchPublicServices: vi.fn(), fetchAvailability: vi.fn() }));
vi.mock('@/lib/api-client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api-client')>()),
  ...apiMock,
}));
const sessionMock = vi.hoisted(() => ({ resolveCopilotSession: vi.fn() }));
vi.mock('@/lib/copilot/session', () => sessionMock);

/* -------------------------------------------------------------------------- */
/* Le faux Claude                                                              */
/* -------------------------------------------------------------------------- */

interface Block {
  readonly type: 'text' | 'tool_use';
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

type Body = {
  stream?: boolean;
  system?: { text: string }[];
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
  tools?: { name: string }[];
};

const textOf = (body: Body) =>
  JSON.stringify([body.system ?? [], body.messages.map((message) => message.content)]);

const nextDay = (day: string) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const received: Body[] = [];

/** Le scénario : l'orchestrateur délègue, le spécialiste lit les créneaux et ouvre le tunnel, puis conclut. */
function script(body: Body): { blocks: Block[]; stop: 'tool_use' | 'end_turn' } {
  const all = textOf(body);
  const specialist = (body.system ?? []).some((block) => block.text.includes('spécialiste de la réservation'));
  const answered = body.messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'tool_result'),
  );

  if (!specialist) {
    const today = /Aujourd['’]hui[^0-9]*(\d{4}-\d{2}-\d{2})/u.exec(all)?.[1] ?? '';
    return {
      stop: 'tool_use',
      blocks: [
        {
          type: 'tool_use',
          id: 'toolu_orchestrateur',
          name: 'agent_reservation',
          input: { demande: `Un massage le ${nextDay(today)} l'après-midi`, faits: {} },
        },
      ],
    };
  }
  if (answered) {
    return { stop: 'end_turn', blocks: [{ type: 'text', text: 'Léa est libre à 14:00 et à 15:30. Je vous ouvre la réservation.' }] };
  }
  const prestation = /\[([0-9a-f-]{36})\] Massage/u.exec(all)?.[1];
  const jour = /(\d{4}-\d{2}-\d{2}) l'après-midi/u.exec(all)?.[1];
  return {
    stop: 'tool_use',
    blocks: [
      { type: 'tool_use', id: 'toolu_creneaux', name: 'disponibilite_creneaux', input: { prestation, jour, plage: 'apres-midi' } },
      { type: 'tool_use', id: 'toolu_tunnel', name: 'reservation_ouvrir_tunnel', input: { prestation, jour, plage: 'apres-midi' } },
    ],
  };
}

function message(blocks: Block[], stop: string) {
  return {
    id: 'msg_faux',
    type: 'message',
    role: 'assistant',
    model: 'faux-claude',
    content: blocks.map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : block)),
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

/** Le même message, en flux SSE tel que l'API Messages le rend. */
function sse(blocks: Block[], stop: string): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { ...message([], stop), stop_reason: null } }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else {
      events.push([
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
      ]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw) as Body;
      received.push(body);
      const { blocks, stop } = script(body);
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse(blocks, stop));
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(message(blocks, stop)));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv('ANTHROPIC_API_KEY', 'cle-factice');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('REDIS_URL', '');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

/* -------------------------------------------------------------------------- */

describe('CA-1 — « un massage demain après-midi » mène au tunnel filtré', () => {
  it('de la question au tunnel, à travers la route du copilot', async () => {
    const visitor: ResolvedCopilotSession = {
      session: {
        surface: 'visiteur',
        role: null,
        permissions: [],
        tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
        locale: 'fr',
      },
      accessToken: null,
      notice: null,
      subject: null,
      tenant,
    };
    sessionMock.resolveCopilotSession.mockResolvedValue(visitor);
    apiMock.fetchPublicServices.mockResolvedValue(services);
    apiMock.fetchAvailability.mockImplementation(
      async (_slug: string, query: { from: string }): Promise<AvailabilityResponse> => ({
        serviceId: MASSAGE,
        timezone: 'Europe/Paris',
        days: [
          {
            date: query.from,
            // En heure d'hiver comme d'été, 06:00Z est du matin à Paris, 13:30Z de l'après-midi.
            slots: ['06:00', '13:30'].map((hour) => ({
              startsAt: `${query.from}T${hour}:00Z`,
              endsAt: `${query.from}T${hour}:00Z`,
              staffId: LEA,
            })),
          },
        ],
      }),
    );

    const { copilotRoute } = await import('@/lib/copilot/runtime');
    const response = await copilotRoute('public')(
      new Request('http://localhost/salon-lea/copilot/agent/default/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          threadId: 'fil-ca1',
          runId: 'run-1',
          state: {},
          messages: [{ id: 'm1', role: 'user', content: 'Je veux un massage demain après-midi' }],
          tools: [],
          context: [],
          forwardedProps: {},
        }),
      }),
      { params: Promise.resolve({ tenantSlug: 'salon-lea' }) },
    );

    expect(response.status).toBe(200);
    const stream = await response.text();
    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as { type: string; delta?: string; toolCallName?: string });

    // La page reçoit l'ordre de naviguer…
    expect(events.some((event) => event.type === 'TOOL_CALL_START' && event.toolCallName === 'naviguer')).toBe(true);
    const args = events
      .filter((event) => event.type === 'TOOL_CALL_ARGS')
      .map((event) => JSON.parse(event.delta ?? '{}') as { chemin?: string });
    const chemin = args.find((arg) => arg.chemin !== undefined)?.chemin ?? '';

    // … vers le tunnel filtré sur la prestation, le jour (demain) et la plage.
    const url = new URL(chemin, 'http://localhost');
    expect(url.pathname).toBe('/salon-lea/reservation');
    expect(url.searchParams.get('etape')).toBe('creneau');
    expect(url.searchParams.get('prestation')).toBe(MASSAGE);
    expect(url.searchParams.get('plage')).toBe('apres-midi');
    const tomorrow = nextDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()));
    expect(url.searchParams.get('jour')).toBe(tomorrow);

    // La réponse affichée est celle du spécialiste, passée telle quelle.
    const text = events.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => event.delta).join('');
    expect(text).toContain('Je vous ouvre la réservation');

    // Le spécialiste n'a lu que les créneaux de l'après-midi, à l'heure du salon.
    const toolResults = JSON.stringify(received.at(-1)?.messages.at(-1)?.content);
    expect(toolResults).toMatch(/1[45]:30/);
    expect(toolResults).not.toMatch(/0[78]:00/);

    // Une visiteuse : aucun outil qui lit un compte ou écrit n'a été offert au modèle.
    const offered = received.flatMap((body) => (body.tools ?? []).map((tool) => tool.name));
    expect(offered).toContain('agent_reservation');
    expect(offered.filter((name) => /annuler|reporter|poser|clients_|encaissement_/.test(name))).toEqual([]);
  });
});
