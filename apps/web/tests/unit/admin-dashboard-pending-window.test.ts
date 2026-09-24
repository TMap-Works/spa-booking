import { MAX_APPOINTMENT_RANGE_DAYS, calendarDaysBetween } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  PENDING_WINDOW_DAYS,
  pendingWindow,
} from '@/app/(admin)/[tenantSlug]/admin/tableau-de-bord/pending-window';

/**
 * La fenêtre du compteur « À confirmer » du tableau de bord — #1159.
 *
 * Ce que cette suite protège tient en une phrase : le compteur qui dit à la
 * gérance ce qu'il lui reste à confirmer ne doit ni s'arrêter à la journée
 * courante — c'était le bug —, ni demander à l'API une plage qu'elle refuse en
 * 422, ce qui ferait tomber l'écran entier.
 */
describe('la fenêtre des demandes à confirmer', () => {
  it('s’ouvre sur la journée du salon et court vers l’avant', () => {
    // Le bug d'origine : la plage valait `{ from: today, to: today }`, si bien
    // qu'une demande de la semaine suivante ne comptait pas.
    expect(pendingWindow('2026-09-22')).toEqual({ from: '2026-09-22', to: '2026-10-21' });
  });

  it('couvre les six demandes futures qu’avait relevées la campagne de QA', () => {
    // Les rendez-vous en attente du constat s'étalaient jusqu'au 2026-10-03.
    const window = pendingWindow('2026-09-22');

    expect(window.from <= '2026-09-22').toBe(true);
    expect(window.to >= '2026-10-03').toBe(true);
  });

  it('traverse un changement de mois et une fin d’année sans glisser d’un jour', () => {
    // `addCalendarDays` passe par midi UTC pour cette raison : une date lue à
    // minuit retomberait sur la veille au moindre décalage.
    expect(pendingWindow('2026-12-20').to).toBe('2027-01-18');
    expect(pendingWindow('2028-02-01').to).toBe('2028-03-01');
  });

  it('tient dans la plage que l’agenda de l’API accepte', () => {
    // `appointmentListQuerySchema` refuse au-delà de `MAX_APPOINTMENT_RANGE_DAYS`
    // (422 `APPOINTMENT_RANGE_TOO_WIDE`), bornes comprises. Dépasser ferait
    // échouer le chargement du tableau de bord, pas seulement ce compteur.
    const window = pendingWindow('2026-09-22');

    expect(calendarDaysBetween(window.from, window.to)).toBe(PENDING_WINDOW_DAYS);
    expect(PENDING_WINDOW_DAYS).toBeLessThanOrEqual(MAX_APPOINTMENT_RANGE_DAYS);
  });
});
