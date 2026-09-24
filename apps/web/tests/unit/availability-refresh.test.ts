/**
 * La cadence de revalidation de l'étape créneau (#1153).
 *
 * Éprouvée ici plutôt qu'au travers du composant : ce qui se joue est une suite
 * de délais et de refus, et la lire au travers d'un rendu complet ferait
 * dépendre chaque assertion de la grille d'horaires. `slot-step.test.tsx` garde
 * ce qui est du ressort de l'écran — qu'il recharge bien dans les cinq secondes
 * et qu'il se relâche quand on le laisse seul.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IDLE_REFRESH_MS,
  MAX_REFRESH_MS,
  PRESENCE_WINDOW_MS,
  PRESENT_REFRESH_MS,
  nextRefreshDelay,
  startAvailabilityRefresh,
} from '@/lib/booking/availability-refresh';

describe('nextRefreshDelay', () => {
  it('bat court tant qu’un geste est récent', () => {
    expect(nextRefreshDelay({ sinceLastActivityMs: 0, consecutiveRefusals: 0 })).toBe(
      PRESENT_REFRESH_MS,
    );
    expect(
      nextRefreshDelay({ sinceLastActivityMs: PRESENCE_WINDOW_MS - 1, consecutiveRefusals: 0 }),
    ).toBe(PRESENT_REFRESH_MS);
  });

  it('retombe sur la minute d’avant #1153 quand l’écran est resté seul', () => {
    expect(
      nextRefreshDelay({ sinceLastActivityMs: PRESENCE_WINDOW_MS, consecutiveRefusals: 0 }),
    ).toBe(IDLE_REFRESH_MS);
  });

  it('s’écarte après un refus, au lieu d’insister au même rythme', () => {
    // Panne, ou quota atteint : le quota de la route publique est compté par
    // adresse, donc par le serveur Next pour tous les visiteurs à la fois.
    expect(nextRefreshDelay({ sinceLastActivityMs: 0, consecutiveRefusals: 1 })).toBe(
      PRESENT_REFRESH_MS * 2,
    );
    expect(nextRefreshDelay({ sinceLastActivityMs: 0, consecutiveRefusals: 2 })).toBe(
      PRESENT_REFRESH_MS * 4,
    );
  });

  it('ne rend jamais l’écran plus périmé qu’avant #1153', () => {
    // Le repli est borné : une correction qui, sous refus, tiendrait une liste
    // vieille de dix minutes serait pire que le défaut qu'elle corrige.
    expect(nextRefreshDelay({ sinceLastActivityMs: 0, consecutiveRefusals: 50 })).toBe(
      MAX_REFRESH_MS,
    );
    expect(
      nextRefreshDelay({ sinceLastActivityMs: PRESENCE_WINDOW_MS, consecutiveRefusals: 50 }),
    ).toBe(MAX_REFRESH_MS);
  });
});

describe('startAvailabilityRefresh', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** L'onglet passe en arrière-plan — jsdom le dit « visible » par défaut. */
  function hideTab(): void {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  }

  it('ne demande rien à l’armement', () => {
    const revalidate = vi.fn().mockResolvedValue(true);

    stop = startAvailabilityRefresh(revalidate);

    // Le premier chargement appartient à l'écran, qui doit d'abord vider ce
    // qu'il affichait ; la boucle prend la suite.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('revalide toutes les cinq secondes', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);

    stop = startAvailabilityRefresh(revalidate);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('ne demande rien à un onglet caché', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);

    hideTab();
    stop = startAvailabilityRefresh(revalidate);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS * 10);

    expect(revalidate).not.toHaveBeenCalled();
  });

  it('se repose au plafond tant que l’onglet est caché', async () => {
    // Le pendant du test précédent : ne rien demander ne suffit pas, encore
    // faut-il ne pas se réveiller pour le constater. `lastActivityAt` ne bouge
    // plus une fois l'onglet quitté, si bien qu'une cadence de présence y
    // ferait battre le fil toutes les cinq secondes pour rien pendant deux
    // minutes. Le nombre de réveils se lit sur les consultations de
    // `visibilityState` : c'est la première chose que chaque battement regarde.
    const revalidate = vi.fn().mockResolvedValue(true);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    stop = startAvailabilityRefresh(revalidate);
    visibility.mockClear();

    await vi.advanceTimersByTimeAsync(MAX_REFRESH_MS);

    // Un battement, celui du plafond — pas les douze d'une cadence de présence.
    expect(visibility.mock.calls.length).toBeLessThanOrEqual(2);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('recharge tout de suite au retour sur l’onglet', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);

    stop = startAvailabilityRefresh(revalidate);
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.advanceTimersByTimeAsync(0);

    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('garde le repli en mémoire quand on revient sur l’onglet', async () => {
    // Revenir sur un onglet ne prouve rien de l'API : remettre le compteur de
    // refus à zéro rendait le repli inopérant dans le seul cas pour lequel il
    // existe — un quota partagé par tous les visiteurs du tunnel, qu'un
    // aller-retour entre deux onglets réalimentait à cinq secondes.
    const revalidate = vi.fn().mockResolvedValue(false);

    stop = startAvailabilityRefresh(revalidate);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Le retour sur l'onglet revalide sur-le-champ — deuxième refus.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(revalidate).toHaveBeenCalledTimes(2);

    // Deux refus : le battement suivant est à vingt secondes. Avec un compteur
    // remis à zéro par le retour, il serait tombé ici.
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS * 2);
    expect(revalidate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS * 2);
    expect(revalidate).toHaveBeenCalledTimes(3);
  });

  it('n’empile pas les appels quand la réponse tarde', async () => {
    const pending: Array<(answered: boolean) => void> = [];
    const revalidate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          pending.push(resolve);
        }),
    );

    stop = startAvailabilityRefresh(revalidate);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Trois battements passent pendant que l'API n'a toujours pas répondu : une
    // API lente ne doit pas voir les requêtes s'empiler.
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS * 3);
    expect(revalidate).toHaveBeenCalledTimes(1);

    pending[0]?.(true);
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('s’écarte après un refus et reprend le rythme dès la réponse suivante', async () => {
    const revalidate = vi.fn().mockResolvedValue(false);

    stop = startAvailabilityRefresh(revalidate);

    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Le battement suivant est à dix secondes, pas à cinq.
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);

    revalidate.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(2);

    // La réponse arrivée, le compteur de refus repart de zéro.
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS);
    expect(revalidate).toHaveBeenCalledTimes(3);
  });

  it('ne demande plus rien une fois débranchée', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);

    const release = startAvailabilityRefresh(revalidate);
    release();

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(PRESENT_REFRESH_MS * 10);

    expect(revalidate).not.toHaveBeenCalled();
  });
});
