import type { PublicTenant } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SalonAside, todayWeekday } from '@/components/account/salon-aside';

import { tenant } from './fixtures';

/**
 * La carte du salon en colonne latérale de l'espace client — #1053.
 *
 * L'audit `d20260918-1` relève que « rien ne dit à qui appartient l'espace ».
 * Cette carte le dit, et ajoute ce que le pied de page n'a pas : **les horaires
 * du jour**, le seul de la semaine qui serve le jour où l'on consulte son
 * rendez-vous.
 *
 * Ce que la suite protège, et qui n'est pas évident :
 *
 * - le jour courant est celui du **fuseau de l'établissement** (ADR 0006), pas
 *   celui de la machine qui rend la page ;
 * - « fermé aujourd'hui » et « horaires jamais publiés » ne se confondent pas :
 *   se taire dans les deux cas laisserait une cliente devant la même absence
 *   pour deux faits opposés.
 */

const ADDRESS = {
  line1: '12 rue des Lilas',
  postalCode: '101',
  city: 'Antananarivo',
  country: 'MG',
};

/** Un salon complet : adresse, téléphone, et une semaine avec le dimanche fermé. */
const SALON: PublicTenant = {
  ...tenant,
  contactPhone: '+261 34 12 345 67',
  address: ADDRESS,
  openingHours: [
    { weekday: 1, opensAt: '09:00', closesAt: '13:00' },
    { weekday: 1, opensAt: '14:00', closesAt: '19:00' },
    { weekday: 6, opensAt: '10:00', closesAt: '18:00' },
  ],
};

afterEach(cleanup);

describe('todayWeekday — le jour du salon, pas celui de la machine', () => {
  it('rend la numérotation ISO, lundi en 1 et dimanche en 7', () => {
    const lundi = new Date('2026-09-21T12:00:00.000Z');

    expect(todayWeekday('Europe/Paris', lundi)).toBe(1);
    expect(todayWeekday('Europe/Paris', new Date('2026-09-20T12:00:00.000Z'))).toBe(7);
  });

  it('bascule de jour avec le fuseau de l’établissement', () => {
    // 23 h UTC le dimanche, c'est déjà le lundi 2 h à Antananarivo (UTC+3). Un
    // salon qui lirait l'horloge du serveur annoncerait les horaires de la
    // veille — ou ceux d'un jour où il est fermé.
    const veille = new Date('2026-09-20T23:00:00.000Z');

    expect(todayWeekday('UTC', veille)).toBe(7);
    expect(todayWeekday('Indian/Antananarivo', veille)).toBe(1);
  });
});

describe('SalonAside — ce que la colonne latérale dit du salon', () => {
  it('nomme le salon, son adresse, son téléphone et l’itinéraire', () => {
    render(<SalonAside tenant={SALON} />);

    const carte = screen.getByRole('complementary', { name: 'Maison Lotus' });

    expect(carte).toBeDefined();
    expect(screen.getByText('12 rue des Lilas')).toBeDefined();
    expect(screen.getByRole('link', { name: '+261 34 12 345 67' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
    expect(
      screen.getByRole('link', { name: /Itinéraire/ }).getAttribute('href'),
    ).toContain('destination=');
  });

  it('distingue un jour de fermeture d’horaires jamais publiés', () => {
    // Le salon publie sa semaine mais ferme le dimanche : c'est précisément le
    // jour où la cliente a besoin de le lire.
    const { unmount } = render(<SalonAside tenant={SALON} />);
    // Le rendu dépend du jour réel ; ce qui se prouve est que **quelque chose**
    // est écrit sous « Aujourd'hui » — une plage, ou « Fermé » — et jamais rien.
    const ligne = screen.getByText('Aujourd’hui').parentElement;
    expect(ligne?.textContent?.replace('Aujourd’hui', '').trim()).not.toBe('');
    unmount();

    // Sans horaires publiés, la ligne disparaît : rien ne permet de distinguer
    // « le salon ferme le lundi » de « le salon n'a pas encore saisi ses
    // horaires », et afficher le premier enverrait une cliente devant une porte
    // ouverte (même règle que `salon-info.tsx`).
    render(<SalonAside tenant={{ ...SALON, openingHours: [] }} />);
    expect(screen.queryByText('Aujourd’hui')).toBeNull();
  });

  it('disparaît quand le salon n’a rien publié du tout', () => {
    // Un cadre vide se lit comme une page incomplète : la carte se retire.
    const { container } = render(<SalonAside tenant={tenant} />);

    expect(container.querySelector('.spa-account__aside')).toBeNull();
  });
});
