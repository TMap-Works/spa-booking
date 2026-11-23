import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CopilotChat from '@/components/copilot/copilot-chat';
import messages from '@/messages/fr/copilot.json';

/**
 * Reproduction du bug « mes discussions disparaissent » : le **vrai** chat
 * (CopilotKit, bulle, mémoire), un faux serveur, et un rechargement simulé —
 * le composant est démonté, le stockage de l'onglet reste.
 */

vi.mock('@copilotkit/react-core/v2/styles.css', () => ({}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/salon-lea/reservation',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const RUNTIME = '/salon-lea/copilot';
const infoCalls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => String(call[0]).includes('/info')).length;
let withNavigation = false;
let infoDelayMs = 0;
const runs: { threadId: string; messages: { role: string; content?: string }[] }[] = [];

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  withNavigation = false;
  infoDelayMs = 0;
  runs.length = 0;
  Element.prototype.scrollTo = () => undefined;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
      const path = url.pathname.replace(RUNTIME, '');
      if (path === '/suggestions') return Response.json({ suggestions: [], sujet: 'visiteur' });
      if (path === '/info') {
        if (infoDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, infoDelayMs));
        return Response.json({
          version: '1.73.3',
          agents: { default: { name: 'default', description: 'x', className: 'ClaudeAgent' } },
          mode: 'sse',
          audioFileTranscriptionEnabled: false,
          // Tel que le vrai runtime l'annonce : c'est ce qui fait chercher des fils au serveur.
          threadEndpoints: { list: true, inspect: true, mutations: false, realtimeMetadata: false },
          suggestions: true,
          a2uiEnabled: false,
          openGenerativeUIEnabled: false,
          telemetryDisabled: true,
        });
      }
      if (path === '/threads') return Response.json({ threads: [], nextCursor: null });
      if (path === '/agent/default/run') {
        const body = JSON.parse(String(init?.body)) as (typeof runs)[number] & { runId: string };
        runs.push(body);
        const id = `rep-${runs.length}`;
        const navigation =
          withNavigation && runs.length === 1
            ? [
                { type: 'TOOL_CALL_START', toolCallId: `nav-${id}-0`, toolCallName: 'naviguer', parentMessageId: id },
                { type: 'TOOL_CALL_ARGS', toolCallId: `nav-${id}-0`, delta: JSON.stringify({ chemin: '/salon-lea/reservation?etape=creneau' }) },
                { type: 'TOOL_CALL_END', toolCallId: `nav-${id}-0` },
              ]
            : [];
        return sse([
          { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
          { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: 'Voici les prestations.' },
          { type: 'TEXT_MESSAGE_END', messageId: id },
          ...navigation,
          { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId },
        ]);
      }
      return new Response(null, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <NextIntlClientProvider locale="fr" messages={{ copilot: messages }}>
      <CopilotChat runtimeUrl={RUNTIME} tenantSlug="salon-lea" variant="bulle" />
    </NextIntlClientProvider>,
  );

async function openAndSay(text: string) {
  const user = userEvent.setup();
  const toggle = await screen.findByTestId('copilot-chat-toggle', undefined, { timeout: 5000 });
  await waitFor(() => expect(infoCalls()).toBeGreaterThan(0), { timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (screen.queryByTestId('copilot-chat-textarea') === null) await user.click(toggle);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Le chat finit de se brancher (découverte du runtime) avant qu'on lui écrive.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const input = await screen.findByTestId('copilot-chat-textarea', undefined, { timeout: 5000 });
  await user.type(input, text);
  await user.keyboard('{Enter}');
}

describe('rechargement de la page', () => {
  it('rend la conversation après un rechargement', async () => {
    const first = mount();
    await openAndSay('Quelles sont vos prestations ?');
    await waitFor(() => expect(runs.length).toBe(1), { timeout: 8000 });
    await screen.findByText('Voici les prestations.', undefined, { timeout: 5000 });

    const stored = window.sessionStorage.getItem('spa-copilot:salon-lea:bulle');
    expect(stored, 'la conversation doit être gardée dans l’onglet').not.toBeNull();

    first.unmount(); // le rechargement : la page repart de zéro, l'onglet garde son stockage
    mount();

    await waitFor(() => expect(screen.queryAllByText('Quelles sont vos prestations ?').length).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(screen.queryAllByText('Voici les prestations.').length).toBeGreaterThan(0);
  }, 30_000);

  it("rend la conversation après une navigation qui recharge la page", async () => {
    withNavigation = true;
    const first = mount();
    await openAndSay('Quelles sont vos prestations ?');
    await waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(1), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 1500)); // le temps que le chat « navigue » (rechargement)
    const before = runs.length;

    first.unmount(); // la page recharge
    mount();
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(screen.queryAllByText('Quelles sont vos prestations ?').length).toBeGreaterThan(0);
    expect(runs.length, 'le rechargement ne doit relancer aucune réponse').toBe(before);
  }, 30_000);

  it("rend la conversation quand le runtime met plus de 5 s à répondre après le rechargement", async () => {
    const first = mount();
    await openAndSay('Quelles sont vos prestations ?');
    await waitFor(() => expect(runs.length).toBe(1), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 500));

    first.unmount();
    infoDelayMs = 6500; // compilation à froid de la route en développement
    mount();
    await new Promise((resolve) => setTimeout(resolve, 9000));

    expect(screen.queryAllByText('Quelles sont vos prestations ?').length).toBeGreaterThan(0);
  }, 40_000);
});
