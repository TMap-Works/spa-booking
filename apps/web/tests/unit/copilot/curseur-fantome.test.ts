import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CURSOR_TIMINGS, pointTo, targetFor } from '@/components/copilot/curseur-fantome';

/** Le curseur fantôme (P4-03) : il montre le lien visé, puis rend la main — ou ne fait rien. */

function link(href: string, visible = true): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = href;
  // jsdom ne met rien en page : la visibilité se lit sur getClientRects.
  anchor.getClientRects = () => (visible ? ([{}] as unknown as DOMRectList) : ([] as unknown as DOMRectList));
  document.body.append(anchor);
  return anchor;
}

function reducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reduce }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('targetFor', () => {
  it('trouve le lien visible du même chemin, filtres ignorés', () => {
    link('/salon-lea/admin/calendrier', false);
    const visible = link('/salon-lea/admin/calendrier');
    link('/salon-lea/admin/clients');
    expect(targetFor('/salon-lea/admin/calendrier?vue=semaine&date=2026-11-14')).toBe(visible);
  });

  it("ignore les liens du chat lui-même, et rend null sans lien", () => {
    const chat = document.createElement('div');
    chat.setAttribute('data-copilotkit', '');
    document.body.append(chat);
    chat.append(link('/salon-lea/admin/clients'));
    expect(targetFor('/salon-lea/admin/clients')).toBeNull();
    expect(targetFor('/salon-lea/reservation')).toBeNull();
  });
});

describe('pointTo', () => {
  it('glisse, souligne le lien, puis nettoie tout', async () => {
    reducedMotion(false);
    const target = link('/salon-lea/admin/encaissement');
    const done = pointTo('/salon-lea/admin/encaissement?date=2026-11-13');

    await vi.advanceTimersByTimeAsync(CURSOR_TIMINGS.glide);
    expect(document.querySelector('.spa-copilot-cursor')).not.toBeNull();
    expect(target.classList.contains('spa-copilot-target')).toBe(true);

    await vi.advanceTimersByTimeAsync(CURSOR_TIMINGS.highlight);
    await done;
    expect(document.querySelector('.spa-copilot-cursor')).toBeNull();
    expect(target.classList.contains('spa-copilot-target')).toBe(false);
  });

  it('ne montre rien sous prefers-reduced-motion, ni sans lien visible', async () => {
    reducedMotion(true);
    link('/salon-lea/admin/encaissement');
    await pointTo('/salon-lea/admin/encaissement');
    expect(document.querySelector('.spa-copilot-cursor')).toBeNull();

    reducedMotion(false);
    await pointTo('/salon-lea/reservation');
    expect(document.querySelector('.spa-copilot-cursor')).toBeNull();
  });
});
