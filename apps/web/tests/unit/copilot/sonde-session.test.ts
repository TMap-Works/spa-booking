import { afterEach, describe, expect, it, vi } from 'vitest';

import { sondeSession } from '@/components/copilot/copilot-chat';

vi.mock('@copilotkit/react-core/v2/styles.css', () => ({}));

/**
 * La sonde qui dit au chat public si la personne est connectée : la route du
 * compte, seule à recevoir le cookie de session, répond.
 */

const COMPTE = '/salon-lea/compte/copilot';
const answer = (response: Response | Error) => vi.stubGlobal('fetch', vi.fn(async () => { if (response instanceof Error) throw response; return response; }));

afterEach(() => vi.unstubAllGlobals());

describe('sondeSession', () => {
  it('reconnaît une cliente connectée à l’empreinte de son compte', async () => {
    answer(Response.json({ suggestions: [], sujet: 'a'.repeat(32) }));
    expect(await sondeSession(COMPTE, new AbortController().signal)).toBe(true);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(`${COMPTE}/suggestions`);
  });

  it('une visiteuse reste une visiteuse', async () => {
    answer(Response.json({ suggestions: [], sujet: 'visiteur' }));
    expect(await sondeSession(COMPTE, new AbortController().signal)).toBe(false);
  });

  it('une panne ou une route fermée ne connecte personne', async () => {
    answer(new Response(null, { status: 404 }));
    expect(await sondeSession(COMPTE, new AbortController().signal)).toBe(false);
    answer(new Error('réseau'));
    expect(await sondeSession(COMPTE, new AbortController().signal)).toBe(false);
  });
});
