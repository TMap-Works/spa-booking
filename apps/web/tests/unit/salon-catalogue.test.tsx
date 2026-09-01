/**
 * Catalogue de la page publique du salon (#43).
 *
 * Ce qui est éprouvé ici est ce que le critère d'acceptation nomme : le
 * catalogue est **groupé par rubrique**, chaque prestation porte sa **durée** et
 * son **prix**, et les informations du salon sont celles que l'API sert
 * réellement.
 */

import type { PublicService } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UNCLASSIFIED_TITLE,
  groupServicesByCategory,
} from '@/components/salon/group-services';
import { SalonInfo } from '@/components/salon/salon-info';
import { ServiceCatalog } from '@/components/salon/service-catalog';

import { service, tenant } from './fixtures';

afterEach(cleanup);

/** Une seconde prestation de la même rubrique que celle des fixtures. */
const massageAssis: PublicService = {
  ...service,
  id: '55555555-5555-4555-8555-555555555555',
  slug: 'massage-assis',
  name: 'Massage assis',
  durationMinutes: 30,
  price: { amountMinor: 2000, currency: 'EUR' },
};

/** Une prestation d'une autre rubrique. */
const soinVisage: PublicService = {
  ...service,
  id: '66666666-6666-4666-8666-666666666666',
  slug: 'soin-visage',
  name: 'Soin du visage',
  description: 'Nettoyage et hydratation.',
  category: {
    id: '77777777-7777-4777-8777-777777777777',
    slug: 'soins-du-visage',
    name: 'Soins du visage',
  },
  durationMinutes: 45,
  price: { amountMinor: 4900, currency: 'EUR' },
};

/** Une prestation que le salon n'a rangée nulle part — le contrat l'autorise. */
const forfait: PublicService = {
  ...service,
  id: '88888888-8888-4888-8888-888888888888',
  slug: 'forfait-decouverte',
  name: 'Forfait découverte',
  category: null,
  durationMinutes: 90,
  price: { amountMinor: 7000, currency: 'EUR' },
};

describe('groupement par rubrique', () => {
  it('range les prestations d’une même rubrique sous une seule section', () => {
    const sections = groupServicesByCategory([service, soinVisage, massageAssis]);

    expect(sections.map((section) => section.title)).toEqual(['Massages', 'Soins du visage']);
    expect(sections[0]?.services.map((item) => item.name)).toEqual([
      'Massage suédois',
      'Massage assis',
    ]);
  });

  it('suit l’ordre de l’API, et non l’alphabet', () => {
    const sections = groupServicesByCategory([soinVisage, service]);

    expect(sections.map((section) => section.title)).toEqual(['Soins du visage', 'Massages']);
  });

  it('renvoie les prestations non classées en dernière section', () => {
    const sections = groupServicesByCategory([forfait, service]);

    expect(sections.map((section) => section.title)).toEqual(['Massages', UNCLASSIFIED_TITLE]);
    expect(sections.at(-1)?.category).toBeNull();
  });

  it('ne fabrique aucune section pour un catalogue vide', () => {
    expect(groupServicesByCategory([])).toEqual([]);
  });
});

describe('rendu du catalogue', () => {
  it('coiffe chaque rubrique de son titre et porte durée et prix', () => {
    render(<ServiceCatalog services={[service, soinVisage]} />);

    const massages = screen.getByRole('region', { name: 'Massages' });

    expect(within(massages).getByRole('heading', { name: 'Massage suédois' })).toBeDefined();
    // « 1 h » pour 60 minutes, « 35,00 € » pour 3500 centimes : la mise en forme
    // vient de `lib/format.ts`, aucun montant n'est divisé dans un composant.
    expect(within(massages).getByText(/1 h/)).toBeDefined();
    expect(within(massages).getByText(/35,00/)).toBeDefined();

    const visage = screen.getByRole('region', { name: 'Soins du visage' });

    expect(within(visage).getByText(/45 min/)).toBeDefined();
    expect(within(visage).getByText(/49,00/)).toBeDefined();
    expect(within(visage).getByText('Nettoyage et hydratation.')).toBeDefined();
  });

  it('ancre chaque prestation sur son slug — les données structurées y renvoient', () => {
    render(<ServiceCatalog services={[service]} />);

    expect(document.getElementById('massage-suedois')).not.toBeNull();
  });

  it('annonce les praticiens qui tiennent la prestation', () => {
    render(<ServiceCatalog services={[service]} />);

    expect(screen.getByText(/Hery/)).toBeDefined();
  });

  it('explique un catalogue vide au lieu de laisser la page blanche', () => {
    render(<ServiceCatalog services={[]} />);

    expect(screen.getByText('Catalogue en cours de préparation')).toBeDefined();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

describe('informations du salon', () => {
  it('rend les coordonnées cliquables et le fuseau de l’établissement', () => {
    render(
      <SalonInfo
        tenant={{ ...tenant, contactEmail: 'contact@lotus.test', contactPhone: '+261341234567' }}
      />,
    );

    expect(screen.getByRole('link', { name: 'contact@lotus.test' }).getAttribute('href')).toBe(
      'mailto:contact@lotus.test',
    );
    expect(screen.getByRole('link', { name: '+261341234567' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
    expect(screen.getByText(/Indian\/Antananarivo/)).toBeDefined();
  });

  it('dit l’absence de coordonnées plutôt que de rendre une section vide', () => {
    render(<SalonInfo tenant={tenant} />);

    expect(screen.getByText('Coordonnées non communiquées')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
