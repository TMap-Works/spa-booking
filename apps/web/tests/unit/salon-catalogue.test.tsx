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
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { groupServicesByCategory } from '@/components/salon/group-services';
import { SalonInfo } from '@/components/salon/salon-info';
import { ServiceCatalog, UNSTAFFED_SERVICE_LABEL } from '@/components/salon/service-catalog';
import fr from '@/messages/fr/booking.json';

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

/**
 * Le titre de la rubrique fictive, passé explicitement (#1142).
 *
 * `groupServicesByCategory` ne lit plus le catalogue elle-même — elle est
 * atteignable depuis le tunnel, côté client, et en embarquait les deux langues
 * entières dans le bundle. C'est donc l'appelant qui le fournit, et cette suite
 * le lit là où les écrans le lisent plutôt que de le recopier : le mot changerait
 * dans le catalogue que le cas continuerait de dire ce qu'il vérifie — le
 * **classement** des sections, et non la traduction.
 *
 * Un test n'est pas empaqueté pour le navigateur : l'import direct du catalogue
 * n'a ici aucun des inconvénients qui l'ont fait retirer des modules.
 */
const UNCLASSIFIED_TITLE = fr.salon.catalog.unclassified;

describe('groupement par rubrique', () => {
  it('range les prestations d’une même rubrique sous une seule section', () => {
    const sections = groupServicesByCategory(
      [service, soinVisage, massageAssis],
      UNCLASSIFIED_TITLE,
    );

    expect(sections.map((section) => section.title)).toEqual(['Massages', 'Soins du visage']);
    expect(sections[0]?.services.map((item) => item.name)).toEqual([
      'Massage suédois',
      'Massage assis',
    ]);
  });

  it('suit l’ordre de l’API, et non l’alphabet', () => {
    const sections = groupServicesByCategory([soinVisage, service], UNCLASSIFIED_TITLE);

    expect(sections.map((section) => section.title)).toEqual(['Soins du visage', 'Massages']);
  });

  it('renvoie les prestations non classées en dernière section', () => {
    const sections = groupServicesByCategory([forfait, service], UNCLASSIFIED_TITLE);

    expect(sections.map((section) => section.title)).toEqual(['Massages', UNCLASSIFIED_TITLE]);
    expect(sections.at(-1)?.category).toBeNull();
  });

  it('ne fabrique aucune section pour un catalogue vide', () => {
    expect(groupServicesByCategory([], UNCLASSIFIED_TITLE)).toEqual([]);
  });
});

describe('rendu du catalogue', () => {
  it('coiffe une rubrique unique de son titre et porte durée et prix', () => {
    render(<ServiceCatalog services={[service, massageAssis]} />);

    const massages = screen.getByRole('region', { name: 'Massages' });

    expect(within(massages).getByRole('heading', { name: 'Massage suédois' })).toBeDefined();
    // « 1 h » pour 60 minutes, « 35,00 € » pour 3500 centimes : la mise en forme
    // vient de `lib/format.ts`, aucun montant n'est divisé dans un composant.
    expect(within(massages).getByText(/1 h/)).toBeDefined();
    expect(within(massages).getByText(/35,00/)).toBeDefined();
    expect(within(massages).getByText(/30 min/)).toBeDefined();
    expect(within(massages).getByText(/20,00/)).toBeDefined();
  });

  it('range plusieurs rubriques en onglets, chacun avec son effectif (#1046)', () => {
    // BM-SERVICE-02 et BM-SERVICE-05 : « une rangée de pastilles de catégories
    // qui défile », et « un compteur — Épilation (3) ».
    render(<ServiceCatalog services={[service, massageAssis, soinVisage]} />);

    const massages = screen.getByRole('tab', { name: /Massages/ });

    expect(massages.textContent).toContain('2');
    expect(massages.getAttribute('aria-selected')).toBe('true');

    const visage = screen.getByRole('tab', { name: /Soins du visage/ });

    expect(visage.textContent).toContain('1');
    // La première rubrique est ouverte d'emblée ; les autres attendent un geste.
    expect(visage.getAttribute('aria-selected')).toBe('false');
  });

  it('ouvre la rubrique qu’on touche, et referme la précédente', async () => {
    const user = userEvent.setup();

    render(<ServiceCatalog services={[service, soinVisage]} />);

    await user.click(screen.getByRole('tab', { name: /Soins du visage/ }));

    const visage = screen.getByRole('tabpanel');

    expect(within(visage).getByRole('heading', { name: 'Soin du visage' })).toBeDefined();
    expect(within(visage).getByText(/45 min/)).toBeDefined();
    expect(within(visage).getByText(/49,00/)).toBeDefined();
    expect(within(visage).getByText('Nettoyage et hydratation.')).toBeDefined();
    // Un seul panneau visible à la fois : `getByRole` ignore ce qui est `hidden`.
    expect(screen.queryByRole('heading', { name: 'Massage suédois' })).toBeNull();
  });

  it('sert toutes les rubriques dans le document, panneaux fermés compris', () => {
    // Le catalogue est la partie indexable de la page : un moteur de recherche
    // doit trouver les prestations des rubriques qui ne sont pas à l'écran, et
    // les données structurées les publient de toute façon.
    render(<ServiceCatalog services={[service, soinVisage]} />);

    expect(document.getElementById('soin-visage')).not.toBeNull();
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(2);
  });

  it('ancre chaque prestation sur son slug — les données structurées y renvoient', () => {
    render(<ServiceCatalog services={[service]} />);

    expect(document.getElementById('massage-suedois')).not.toBeNull();
  });

  it('annonce les praticiens qui tiennent la prestation', () => {
    render(<ServiceCatalog services={[service]} />);

    expect(screen.getByText(/Hery/)).toBeDefined();
    expect(screen.queryByText(UNSTAFFED_SERVICE_LABEL)).toBeNull();
  });

  it('dit qu’une prestation sans praticien n’offre aucun créneau (#765)', () => {
    // Le cas de l'audit : la prestation est active — elle est donc servie par le
    // point d'entrée public —, mais personne ne la pratique. Sans la mention, sa
    // carte est indiscernable de celle d'à côté, qui est réservable.
    render(<ServiceCatalog services={[{ ...service, staff: [] }, soinVisage]} />);

    expect(screen.getByText(UNSTAFFED_SERVICE_LABEL)).toBeDefined();
    // La prestation reste affichée avec sa durée et son prix : le catalogue dit
    // ce que le salon propose, il ne masque pas une prestation en ligne.
    expect(screen.getByRole('heading', { name: 'Massage suédois' })).toBeDefined();
    expect(screen.getByText(/35,00/)).toBeDefined();
    // Et la mention ne déborde pas sur la voisine, qui a bien ses praticiens.
    expect(screen.getAllByText(UNSTAFFED_SERVICE_LABEL)).toHaveLength(1);
  });

  it('n’annonce pas de praticiens quand il n’y en a aucun', () => {
    // L'ancien rendu masquait la ligne ; le nouveau la remplace. Ni l'un ni
    // l'autre ne doit faire lire « Praticiens : aucun praticien » à un lecteur
    // d'écran, d'où l'absence de préfixe sur la mention.
    render(<ServiceCatalog services={[{ ...service, staff: [] }]} />);

    expect(screen.queryByText(/Praticiens :/)).toBeNull();
  });

  it('explique un catalogue vide au lieu de laisser la page blanche', () => {
    render(<ServiceCatalog services={[]} />);

    expect(screen.getByText('Catalogue en cours de préparation')).toBeDefined();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});

describe('informations du salon', () => {
  /** Un mardi à 10 h 00 chez le tenant des fixtures (UTC+3, sans heure d'été). */
  const MARDI_MATIN = new Date('2026-09-15T07:00:00.000Z');

  it('rend les coordonnées cliquables dans la carte « Nous trouver »', () => {
    render(
      <SalonInfo
        tenant={{ ...tenant, contactEmail: 'contact@lotus.test', contactPhone: '+261341234567' }}
        bookable
        now={MARDI_MATIN}
      />,
    );

    expect(screen.getByRole('link', { name: 'contact@lotus.test' }).getAttribute('href')).toBe(
      'mailto:contact@lotus.test',
    );
    // Lisible à l'œil, composable au doigt : le lien garde l'E.164 (#825).
    expect(screen.getByRole('link', { name: '+261 34 12 345 67' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
    expect(screen.getByRole('heading', { name: 'Nous trouver' })).toBeDefined();
  });

  it('dit l’absence d’informations plutôt que de rendre une section vide', () => {
    render(<SalonInfo tenant={tenant} bookable now={MARDI_MATIN} />);

    expect(screen.getByText('Informations non communiquées')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('rend l’adresse en lignes et la semaine entière, jours fermés compris (#343, #1046)', () => {
    render(
      <SalonInfo
        tenant={{
          ...tenant,
          address: {
            line1: '12 rue des Lilas',
            line2: 'Bâtiment B',
            postalCode: '75011',
            city: 'Paris',
            country: 'FR',
          },
          openingHours: [
            { weekday: 2, opensAt: '09:00', closesAt: '12:00' },
            { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
            { weekday: 6, opensAt: '10:00', closesAt: '24:00' },
          ],
        }}
        bookable
        now={MARDI_MATIN}
      />,
    );

    expect(screen.getByText('12 rue des Lilas')).toBeDefined();
    expect(screen.getByText('75011 Paris')).toBeDefined();
    // Le pays est rendu en toutes lettres, pas en code : « FR » ne se lit pas.
    expect(screen.getByText('France')).toBeDefined();

    // Une journée à coupure tient sur **une** ligne, ses deux plages ensemble.
    expect(screen.getByText(/09:00.*12:00.*14:00.*19:00/)).toBeDefined();
    // BM-VITRINE-03 : les sept jours, et « Fermé » écrit pour les fermetures.
    // La semaine est publiée — elle porte deux journées —, si bien que l'absence
    // du lundi veut dire « fermé » et non « pas encore saisi ».
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getAllByText('Fermé')).toHaveLength(5);
  });

  it('met le jour courant en évidence, dans le fuseau du salon (BM-VITRINE-03)', () => {
    const { container } = render(
      <SalonInfo
        tenant={{
          ...tenant,
          openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
        }}
        bookable
        now={MARDI_MATIN}
      />,
    );

    const today = container.querySelectorAll('[aria-current="date"]');

    expect(today).toHaveLength(1);
    expect(today[0]?.textContent).toContain('Mardi');
    // La graisse ne suffit pas : le repère est aussi écrit (WCAG 1.4.1).
    expect(today[0]?.textContent).toContain('aujourd’hui');
  });

  it('ne montre plus la ligne « Fuseau horaire », et nomme le fuseau sous les horaires', () => {
    // L'audit `d20260918-1` la relève comme une information d'exploitation posée
    // au milieu d'une page publique. BM-RDV-06 veut que le fuseau soit nommé là
    // où il sert — sous les heures, et nulle part ailleurs.
    render(
      <SalonInfo
        tenant={{
          ...tenant,
          openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
        }}
        bookable
        now={MARDI_MATIN}
      />,
    );

    expect(screen.queryByText('Fuseau horaire')).toBeNull();
    expect(screen.getByText(/fuseau du salon \(Indian\/Antananarivo\)/)).toBeDefined();
  });

  it('sert un salon sans adresse ni horaires, cartes comprises', () => {
    // Le critère de #343 : les deux champs sont facultatifs, et la page d'un
    // salon qui n'a rien saisi doit rester servie — c'est le cas le plus courant
    // à l'inscription.
    render(
      <SalonInfo tenant={{ ...tenant, contactPhone: '+261341234567' }} bookable now={MARDI_MATIN} />,
    );

    expect(screen.getByText('+261 34 12 345 67')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Nous trouver' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Horaires' })).toBeNull();
  });
});
