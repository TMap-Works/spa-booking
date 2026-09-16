/**
 * La barre de résumé collante du tunnel (#735).
 *
 * Ce qu'elle doit tenir, et que rien d'autre ne tient : les quatre faits sur
 * lesquels on décide — prestation, durée, date/heure, prix — restent lisibles
 * aux étapes où l'écran ne les porte plus. L'audit de conception `d20260916-1`
 * les a relevés absents de « Créneau » et de « Coordonnées ».
 */

import type { UtcInstant } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BookingSummaryBar } from '@/components/booking/summary-bar';

import { service, tenant } from './fixtures';

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;

afterEach(cleanup);

describe('la barre de résumé', () => {
  it('rappelle la prestation, sa durée et son prix dès qu’une prestation est retenue', () => {
    render(<BookingSummaryBar tenant={tenant} service={service} startsAt={null} />);

    const barre = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(barre.textContent).toContain(service.name);
    // 60 minutes, rendues comme partout ailleurs dans le produit.
    expect(barre.textContent).toContain('1 h');
    expect(barre.textContent).toContain('35,00');
  });

  it('n’annonce pas de date tant qu’aucun créneau n’est retenu', () => {
    render(<BookingSummaryBar tenant={tenant} service={service} startsAt={null} />);

    // Le libellé lui-même est absent : une ligne « Date et heure » vide ferait
    // passer le choix à venir pour une donnée manquante.
    expect(screen.queryByText('Date et heure')).toBeNull();
  });

  it('affiche l’horaire retenu dans le fuseau du salon, et non dans celui du visiteur', () => {
    render(<BookingSummaryBar tenant={tenant} service={service} startsAt={MATIN} />);

    const barre = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(barre.textContent).toContain('1 septembre 2026');
    expect(barre.textContent).toContain('09:00');
    // 06:00 est l'instant UTC : s'il s'affichait, le fuseau du salon aurait été
    // oublié — un rendez-vous mal fuseau-horairé est un bug de sévérité haute.
    expect(barre.textContent).not.toContain('06:00');
  });

  it('ne rend rien tant qu’aucune prestation n’est retenue', () => {
    const { container } = render(
      <BookingSummaryBar tenant={tenant} service={null} startsAt={null} />,
    );

    expect(container.innerHTML).toBe('');
  });
});
