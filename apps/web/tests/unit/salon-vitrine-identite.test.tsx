/**
 * La vitrine refondue — bandeau d'identité, prestation réservable d'un geste,
 * équipe, barre collante (#1046).
 *
 * L'audit de conception `d20260918-1` relève au titre de `ds:standard` que la
 * vitrine « se lit comme une fiche technique » : ni adresse ni état d'ouverture
 * en tête (BM-VITRINE-01, BM-VITRINE-02), des cartes sans action d'où l'on ne
 * choisit rien (BM-VITRINE-05, BM-SERVICE-01), et un appel à l'action qui part
 * au premier défilement à 360 px (BM-VITRINE-04).
 *
 * Les trois critères d'acceptation du ticket sont vérifiés ici :
 *
 * 1. le nom, l'état d'ouverture et l'appel à l'action tiennent ensemble en tête ;
 * 2. une prestation se choisit depuis la vitrine et ouvre le tunnel **à l'étape
 *    du créneau** ;
 * 3. aucune couleur littérale — ce troisième-là est tenu par
 *    `tests/tokens.test.mjs`, qui balaie toutes les feuilles de style.
 */

import type { PublicService, PublicTenant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { serviceBookingHref } from '@/components/salon/booking-link';
import { SalonBookingBar } from '@/components/salon/salon-booking-bar';
import { SalonHeader } from '@/components/salon/salon-header';
import { SalonTeam, teamFromServices } from '@/components/salon/salon-team';
import { ServiceCatalog } from '@/components/salon/service-catalog';
import { BOOKING_QUERY_KEYS } from '@/lib/booking/draft';
import fr from '@/messages/fr/booking.json';

import { service, tenant } from './fixtures';

// `useLinkStatus` ne répond que sous le routeur de l'App Router, que cette suite
// n'a pas — même traitement que `link-pending.test.tsx`, dont c'est le sujet.
vi.mock('next/link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/link')>()),
  useLinkStatus: () => ({ pending: false }),
}));

afterEach(cleanup);

const RESERVATION_HREF = `/${tenant.slug}/reservation`;

/** Un mardi à 12 h 00 chez le tenant des fixtures (Indian/Antananarivo, UTC+3). */
const MARDI_MIDI = new Date('2026-09-15T09:00:00.000Z');

/** Le salon complet : adresse, téléphone, horaires — ce que BM-VITRINE-01 attend. */
const salonComplet: PublicTenant = {
  ...tenant,
  contactPhone: '+261 34 12 345 67',
  address: {
    line1: '12 rue des Lilas',
    postalCode: '69003',
    city: 'Lyon',
    country: 'FR',
  },
  openingHours: [{ weekday: 2, opensAt: '09:00', closesAt: '19:00' }],
};

describe('bandeau d’identité', () => {
  it('porte le nom, la ville et l’état d’ouverture, et l’appel à l’action (BM-VITRINE-01)', () => {
    const { container } = render(
      <SalonHeader tenant={salonComplet} reservationHref={RESERVATION_HREF} now={MARDI_MIDI} />,
    );

    // Le `<header>` du bandeau vit **sous** le `<main>` de la page : ce n'est
    // donc pas un repère `banner` — celui-là est l'en-tête du gabarit (#1045),
    // et deux repères de ce nom se disputeraient la navigation d'un lecteur
    // d'écran. On interroge l'élément, pas un rôle qu'il n'a pas en place.
    const banniere = container.querySelector('header');

    expect(banniere).not.toBeNull();
    expect(within(banniere as HTMLElement).getByRole('heading', { level: 1 }).textContent).toBe(
      'Maison Lotus',
    );
    expect(screen.getByText('Lyon')).toBeDefined();
    // BM-VITRINE-02 : un état calculé pour maintenant, pas un tableau à lire.
    expect(screen.getByText('Ouvert — ferme à 19:00')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Prendre rendez-vous' }).getAttribute('href')).toBe(
      RESERVATION_HREF,
    );
  });

  it('mène à l’itinéraire depuis la ville (BM-VITRINE-07)', () => {
    render(
      <SalonHeader tenant={salonComplet} reservationHref={RESERVATION_HREF} now={MARDI_MIDI} />,
    );

    const itineraire = screen.getByRole('link', { name: /Lyon/ });

    expect(itineraire.getAttribute('href')).toContain('google.com/maps');
    // Le nom du salon est dans la requête : deux salons de la même rue ne se
    // distinguent que par lui.
    expect(itineraire.getAttribute('href')).toContain(encodeURIComponent('Maison Lotus'));
    expect(itineraire.getAttribute('rel')).toContain('noopener');
  });

  it('propose d’appeler quand le salon a publié un numéro, en second rôle', () => {
    render(
      <SalonHeader tenant={salonComplet} reservationHref={RESERVATION_HREF} now={MARDI_MIDI} />,
    );

    // La destination est resserrée — RFC 3966 n'admet pas les espaces — tandis
    // que le libellé reste court : c'est un second bouton, pas le numéro.
    expect(screen.getByRole('link', { name: 'Appeler' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
  });

  it('se tait sur l’ouverture quand le salon n’a publié aucun horaire', () => {
    // On ne dit pas « Fermé » d'un salon qui n'a rien saisi : ce serait inventer
    // une fermeture que personne n'a déclarée.
    render(<SalonHeader tenant={tenant} reservationHref={RESERVATION_HREF} now={MARDI_MIDI} />);

    expect(screen.queryByText(/Ouvert/)).toBeNull();
    expect(screen.queryByText(/Fermé/)).toBeNull();
  });

  it('retire « Prendre rendez-vous » quand rien n’est réservable (#773)', () => {
    render(<SalonHeader tenant={salonComplet} reservationHref={null} now={MARDI_MIDI} />);

    expect(screen.queryByRole('link', { name: 'Prendre rendez-vous' })).toBeNull();
    // L'identité, elle, reste : la page dit toujours où l'on est.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Maison Lotus');
    expect(screen.getByText('Ouvert — ferme à 19:00')).toBeDefined();
  });
});

describe('choisir une prestation depuis la vitrine', () => {
  it('ouvre le tunnel sur la prestation, à l’étape du créneau (BM-VITRINE-05)', () => {
    render(<ServiceCatalog services={[service]} reservationPath={RESERVATION_HREF} />);

    const choisir = screen.getByRole('link', { name: /Choisir/ });
    const url = new URL(choisir.getAttribute('href') ?? '', 'https://reservation.test');

    expect(url.pathname).toBe(RESERVATION_HREF);
    expect(url.searchParams.get(BOOKING_QUERY_KEYS.step)).toBe('creneau');
    expect(url.searchParams.get(BOOKING_QUERY_KEYS.service)).toBe(service.id);
  });

  it('nomme la prestation dans le lien, et pas seulement « Choisir » (WCAG 2.4.4)', () => {
    render(<ServiceCatalog services={[service]} reservationPath={RESERVATION_HREF} />);

    expect(screen.getByRole('link', { name: 'Choisir — Massage suédois' })).toBeDefined();
  });

  it('n’offre rien à choisir sur une prestation que personne ne pratique (#765)', () => {
    // Le moteur de disponibilité ne proposera aucun créneau pour elle : l'y
    // envoyer serait offrir une action qui ne peut pas s'exercer.
    render(
      <ServiceCatalog services={[{ ...service, staff: [] }]} reservationPath={RESERVATION_HREF} />,
    );

    expect(screen.queryByRole('link', { name: /Choisir/ })).toBeNull();
    // La prestation reste affichée, avec son prix : le catalogue dit l'offre.
    expect(screen.getByText(/35,00/)).toBeDefined();
  });

  it('reste sans action dans l’aperçu du back-office, qui ne passe aucun chemin', () => {
    render(<ServiceCatalog services={[service]} />);

    expect(screen.queryByRole('link', { name: /Choisir/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Massage suédois' })).toBeDefined();
  });

  it('emprunte les clés du tunnel plutôt que de les réécrire', () => {
    // Un renommage côté `lib/booking/draft.ts` doit casser ici, pas en
    // production : c'est tout l'intérêt de lire le registre.
    const href = serviceBookingHref('/maison-lotus/reservation', service.id);

    expect(href.startsWith('/maison-lotus/reservation?')).toBe(true);
    expect(href).toContain(`${BOOKING_QUERY_KEYS.step}=creneau`);
  });
});

describe('barre de réservation collante (BM-VITRINE-04)', () => {
  it('porte le nombre de prestations et l’appel à l’action', () => {
    render(<SalonBookingBar href={RESERVATION_HREF} serviceCount={4} />);

    expect(screen.getByText('4 prestations')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Prendre rendez-vous' }).getAttribute('href')).toBe(
      RESERVATION_HREF,
    );
  });

  it('accorde le compte au singulier', () => {
    render(<SalonBookingBar href={RESERVATION_HREF} serviceCount={1} />);

    expect(screen.getByText('1 prestation')).toBeDefined();
  });

  it('disparaît quand il n’y a rien à réserver', () => {
    const { container } = render(<SalonBookingBar href={null} serviceCount={3} />);

    expect(container.firstChild).toBeNull();
  });

  it('disparaît aussi sur un catalogue vide, même si le chemin existe', () => {
    const { container } = render(<SalonBookingBar href={RESERVATION_HREF} serviceCount={0} />);

    expect(container.firstChild).toBeNull();
  });
});

describe('l’équipe (BM-VITRINE-06)', () => {
  const soinVisage: PublicService = {
    ...service,
    id: '66666666-6666-4666-8666-666666666666',
    slug: 'soin-visage',
    name: 'Soin du visage',
    category: { id: '77777777-7777-4777-8777-777777777777', slug: 'visage', name: 'Soins du visage' },
    staff: [
      { id: '44444444-4444-4444-8444-444444444444', displayName: 'Hery' },
      { id: '99999999-9999-4999-8999-999999999999', displayName: 'Lila' },
    ],
  };

  it('réunit les praticiens du catalogue sans les compter deux fois', () => {
    // Le titre des prestations non classées est passé explicitement depuis #1142 :
    // `group-services.ts` ne lit plus le catalogue, et `teamFromServices` non plus.
    // Les deux prestations de ce cas portent une rubrique, il n'est donc jamais lu.
    const team = teamFromServices([service, soinVisage], fr.salon.catalog.unclassified);

    expect(team.map((member) => member.displayName)).toEqual(['Hery', 'Lila']);
    // Hery tient les deux rubriques ; elles le qualifient, faute d'un métier
    // dans le contrat public (`staffMemberSummarySchema` n'a que le nom).
    expect(team[0]?.practices).toEqual(['Massages', 'Soins du visage']);
    expect(team[1]?.practices).toEqual(['Soins du visage']);
  });

  it('rend une rangée nommée, avec le nom et ce que chacun pratique', () => {
    render(<SalonTeam services={[service, soinVisage]} />);

    const equipe = screen.getByRole('region', { name: 'L’équipe' });

    expect(within(equipe).getByText('Lila')).toBeDefined();
    expect(within(equipe).getByText('Massages · Soins du visage')).toBeDefined();
  });

  it('disparaît quand aucun praticien ne ressort du catalogue', () => {
    // Un « L'équipe » suivi d'un état vide dirait qu'il n'y a personne dans le
    // salon ; la mention de chaque ligne du catalogue le dit déjà, sans
    // généraliser.
    const { container } = render(<SalonTeam services={[{ ...service, staff: [] }]} />);

    expect(container.firstChild).toBeNull();
  });
});
