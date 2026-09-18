/**
 * La barre basse et la colonne récapitulative du tunnel (#735, #1047).
 *
 * Ce qu'elles doivent tenir, et que rien d'autre ne tient : les faits sur
 * lesquels on décide — prestation, durée, praticien, date/heure, prix — restent
 * lisibles aux étapes où l'écran ne les porte plus (audit `d20260916-1`).
 *
 * Ce que #1047 y ajoute, et que ce fichier éprouve en plus :
 *
 * - la barre **tient sur une ligne** — un seul rang de faits, sans les quatre
 *   couples libellé / valeur en capitales qui montaient à trois rangées à 360 px
 *   (`BM-TUNNEL-07`) ;
 * - le détail complet est **à un doigt**, dans une feuille (`BM-TUNNEL-12`) ;
 * - la colonne de bureau dit **la même chose**, y compris la politique
 *   d'annulation, qui n'était écrite qu'au récapitulatif.
 */

import type { UtcInstant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BookingActionBar,
  BookingSummaryAside,
  type BookingSummary,
} from '@/components/booking/summary-bar';

import { service, tenant } from './fixtures';

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;

function resume(startsAt: UtcInstant | null, staffName: string | null = null): BookingSummary {
  return {
    serviceName: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    staffName,
    startsAt,
    timeZone: tenant.timezone,
  };
}

afterEach(cleanup);

describe('la barre basse', () => {
  it('rappelle la prestation, sa durée et son prix sur une seule ligne', () => {
    render(<BookingActionBar summary={resume(null)} />);

    const ligne = screen.getByRole('button', { name: /voir le détail/i });

    expect(ligne.textContent).toContain(service.name);
    // 60 minutes, rendues comme partout ailleurs dans le produit.
    expect(ligne.textContent).toContain('1 h');
    expect(ligne.textContent).toContain('35,00');
  });

  it('n’affiche aucun rappel tant qu’aucune prestation n’est retenue', () => {
    render(<BookingActionBar summary={null} />);

    expect(screen.queryByRole('button', { name: /voir le détail/i })).toBeNull();
  });

  it('rend l’action primaire de l’étape, pleine largeur', () => {
    render(
      <BookingActionBar summary={resume(null)}>
        <button type="submit">Choisir un créneau</button>
      </BookingActionBar>,
    );

    expect(screen.getByRole('button', { name: 'Choisir un créneau' })).not.toBeNull();
  });

  it('déplie le récapitulatif complet au toucher de la ligne (BM-TUNNEL-12)', async () => {
    const user = userEvent.setup();

    const { container } = render(<BookingActionBar summary={resume(MATIN, 'Yanis B.')} />);
    const feuille = container.querySelector('dialog');

    // Fermée au départ. C'est l'attribut qu'on interroge et non la présence des
    // nœuds : `Sheet` est bâti sur `<dialog>`, dont le contenu reste dans le
    // document tant qu'il n'est pas ouvert — c'est le navigateur qui le masque,
    // et jsdom ne peint rien.
    expect(feuille?.hasAttribute('open')).toBe(false);

    await user.click(screen.getByRole('button', { name: /voir le détail/i }));

    expect(feuille?.hasAttribute('open')).toBe(true);

    const ouverte = screen.getByRole('dialog');

    expect(within(ouverte).getByText('Praticien')).not.toBeNull();
    expect(within(ouverte).getByText('Yanis B.')).not.toBeNull();
    expect(ouverte.textContent).toContain('Annulation sans frais');
  });

  it('affiche l’horaire retenu dans le fuseau du salon, et non dans celui du visiteur', async () => {
    const user = userEvent.setup();

    render(<BookingActionBar summary={resume(MATIN)} />);
    await user.click(screen.getByRole('button', { name: /voir le détail/i }));

    const feuille = screen.getByRole('dialog');

    expect(feuille.textContent).toContain('09:00');
    // 06:00 est l'instant UTC : s'il s'affichait, le fuseau du salon aurait été
    // oublié — un rendez-vous mal fuseau-horairé est un bug de sévérité haute.
    expect(feuille.textContent).not.toContain('06:00');
  });

  it('n’annonce pas de date tant qu’aucun créneau n’est retenu', async () => {
    const user = userEvent.setup();

    render(<BookingActionBar summary={resume(null)} />);
    await user.click(screen.getByRole('button', { name: /voir le détail/i }));

    // Le libellé lui-même est absent : une ligne « Date et heure » vide ferait
    // passer le choix à venir pour une donnée manquante.
    expect(screen.queryByText('Date et heure')).toBeNull();
  });
});

describe('la colonne récapitulative', () => {
  it('nomme le praticien retenu, et « Premier disponible » sans préférence', () => {
    const { rerender } = render(<BookingSummaryAside summary={resume(MATIN, 'Yanis B.')} />);

    const colonne = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(colonne.textContent).toContain('Yanis B.');

    rerender(<BookingSummaryAside summary={resume(MATIN, null)} />);

    expect(
      screen.getByRole('complementary', { name: 'Votre réservation' }).textContent,
    ).toContain('Premier disponible');
  });

  it('porte le total et la politique d’annulation, que l’écran ne disait nulle part', () => {
    render(<BookingSummaryAside summary={resume(MATIN, 'Yanis B.')} />);

    const colonne = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(within(colonne).getByText('Total')).not.toBeNull();
    expect(colonne.textContent).toContain('35,00');
    expect(colonne.textContent).toContain('Annulation sans frais');
  });
});
