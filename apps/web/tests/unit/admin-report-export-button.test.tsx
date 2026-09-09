import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportExportButton } from '@/app/(admin)/[tenantSlug]/admin/components/report-export-button';

/**
 * Le bouton d'export du back-office — sixième critère de #563.
 *
 * Ce qui est exercé ici, c'est l'écran : le bouton **consomme la route** au lieu
 * de fabriquer un `Blob`, il ne produit pas deux exports sur un double clic, et
 * il dit ce qui s'est passé. Le transport, lui, a ses suites d'intégration et sa
 * recette — l'action serveur est doublée.
 *
 * Le point le plus important est le troisième cas : chaque clic dépose
 * réellement un objet dans un bucket S3, là où le `Blob` d'hier ne coûtait
 * qu'une allocation. Un double clic non gardé, c'est un fichier de plus à purger
 * et une seconde lecture d'un an de rendez-vous.
 */

const createReportExportAction = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/reporting/actions', () => ({
  createReportExportAction: (...args: unknown[]) => createReportExportAction(...args),
  refreshReportExportAction: vi.fn(),
}));

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace }),
}));

const SLUG = 'maison-lotus';

/** Septembre 2026 tel qu'un salon parisien le vit — ce que la page calcule. */
const FENETRE = { from: '2026-08-31T22:00:00.000Z', to: '2026-09-30T22:00:00.000Z' };

const EXPORT_PRODUIT = {
  id: '33333333-3333-4333-8333-333333333333',
  url: 'https://exports.test.invalid/exports/tenant/33333333.csv?X-Amz-Expires=900',
  expiresAt: '2026-09-09T12:15:00.000Z',
  filename: 'maison-lotus-reporting-2026-09-01_2026-09-30.csv',
};

/** Les clics d'ancre sont neutralisés : jsdom n'a pas de gestionnaire de téléchargement. */
let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  createReportExportAction.mockReset();
  replace.mockReset();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  clickSpy.mockRestore();
  cleanup();
});

describe('ReportExportButton', () => {
  it('demande l’export à la route, avec la fenêtre affichée', async () => {
    createReportExportAction.mockResolvedValue({ ok: true, data: EXPORT_PRODUIT });

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/i }));

    await waitFor(() => {
      expect(createReportExportAction).toHaveBeenCalledWith(SLUG, FENETRE);
    });
  });

  it('ouvre l’URL présignée sous le nom que le serveur a choisi', async () => {
    createReportExportAction.mockResolvedValue({ ok: true, data: EXPORT_PRODUIT });

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/i }));

    // Le nom vient de la réponse, jamais d'un calcul local : deux calculs du
    // même nom finiraient par diverger.
    await waitFor(() => {
      expect(screen.getByText(`Fichier téléchargé : ${EXPORT_PRODUIT.filename}`)).toBeTruthy();
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('ne produit pas deux exports sur un double clic', async () => {
    let resoudre: (value: unknown) => void = () => undefined;
    createReportExportAction.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resoudre = resolve;
        }),
    );

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    const bouton = screen.getByRole('button', { name: /Exporter en CSV/i });

    fireEvent.click(bouton);
    await waitFor(() => {
      expect(bouton.hasAttribute('disabled')).toBe(true);
    });
    fireEvent.click(bouton);

    expect(createReportExportAction).toHaveBeenCalledTimes(1);

    resoudre({ ok: true, data: EXPORT_PRODUIT });
    await waitFor(() => {
      expect(bouton.hasAttribute('disabled')).toBe(false);
    });
  });

  it('dit le refus de l’API sans ouvrir quoi que ce soit', async () => {
    createReportExportAction.mockResolvedValue({
      ok: false,
      code: 'REPORT_WINDOW_TOO_WIDE',
      message: 'Une fenêtre de rapport couvre au plus 366 jours.',
    });

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/i }));

    await waitFor(() => {
      expect(screen.getByText(/couvre au plus 366 jours/)).toBeTruthy();
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('renouvelle la session expirée au lieu de l’annoncer et de s’arrêter là', async () => {
    createReportExportAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
    });

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/i }));

    // Un tableau de bord se laisse ouvert longtemps : c'est l'écran où le jeton
    // expire le plus souvent, et un cul-de-sac y coûterait la période affichée.
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(String(replace.mock.calls[0]?.[0])).toContain('/session/refresh?next=');
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('nomme l’environnement sans entrepôt plutôt que de dire « erreur inattendue »', async () => {
    createReportExportAction.mockResolvedValue({
      ok: false,
      code: 'REPORT_EXPORT_UNAVAILABLE',
      message: 'L’export du reporting n’est pas disponible sur cet environnement.',
    });

    render(<ReportExportButton tenantSlug={SLUG} window={FENETRE} />);
    fireEvent.click(screen.getByRole('button', { name: /Exporter en CSV/i }));

    await waitFor(() => {
      expect(screen.getByText(/pas disponible sur cet environnement/)).toBeTruthy();
    });
  });
});
