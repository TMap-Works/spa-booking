/**
 * La vitrine d'un salon qui n'a **rien publié** (#773).
 *
 * L'audit `d20260916-1` (`ds:confiance`) relève trois messages qui se
 * contredisaient sur un seul écran de 360 px : l'accroche promettait des
 * prestations, l'état vide du catalogue ordonnait de contacter un salon dont les
 * coordonnées n'étaient pas publiées, et les informations pratiques assuraient
 * que « la réservation en ligne reste ouverte » alors que l'action accentuée
 * menait à un tunnel qui refusait de démarrer.
 *
 * Ce que cette suite verrouille est la règle que la référence
 * `docs/design/appointments/states.md` énonce pour l'étape service : un état
 * vide porte une explication et **au moins une action** — et rien d'autre. Une
 * action qu'on ne peut pas exercer n'en est pas une.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { salonContactAction } from '@/components/salon/salon-contact';
import { SalonHeader } from '@/components/salon/salon-header';
import { SalonInfo } from '@/components/salon/salon-info';
import { ServiceCatalog } from '@/components/salon/service-catalog';

import { service, tenant } from './fixtures';

// `useLinkStatus` ne répond que sous le routeur de l'App Router, que cette suite
// n'a pas — même traitement que `link-pending.test.tsx`, dont c'est le sujet.
vi.mock('next/link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/link')>()),
  useLinkStatus: () => ({ pending: false }),
}));

afterEach(cleanup);

const RESERVATION_HREF = `/${tenant.slug}/reservation`;

describe('accroche et appel à l’action de l’en-tête', () => {
  it('promet les prestations et mène au tunnel quand le catalogue est publié', () => {
    render(<SalonHeader tenant={tenant} reservationHref={RESERVATION_HREF} />);

    expect(screen.getByText(/Découvrez les prestations de Maison Lotus/)).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Prendre rendez-vous' }).getAttribute('href'),
    ).toBe(RESERVATION_HREF);
  });

  it('ne promet plus de prestations quand le salon n’en a publié aucune', () => {
    render(<SalonHeader tenant={tenant} reservationHref={null} />);

    expect(screen.getByText(/La réservation en ligne de Maison Lotus/)).toBeDefined();
    expect(screen.queryByText(/leurs durées et leurs tarifs/)).toBeNull();
  });

  it('retire « Prendre rendez-vous » au lieu de le griser', () => {
    // Retiré, et non désactivé : un bouton grisé sur une page publique fait
    // chercher la condition à remplir, là où il n'y a rien à faire côté
    // visiteuse. Et surtout, plus rien ne mène au tunnel qui refuse de démarrer.
    render(<SalonHeader tenant={tenant} reservationHref={null} />);

    expect(screen.queryByRole('link', { name: 'Prendre rendez-vous' })).toBeNull();
    expect(screen.queryByText(RESERVATION_HREF)).toBeNull();
    expect(document.querySelector(`a[href="${RESERVATION_HREF}"]`)).toBeNull();
  });
});

describe('état vide du catalogue', () => {
  it('propose d’appeler le salon quand il a publié un numéro', () => {
    const contact = salonContactAction({ ...tenant, contactPhone: '+261341234567' });

    render(<ServiceCatalog services={[]} contact={contact} />);

    const action = screen.getByRole('link', { name: 'Appeler le salon' });

    expect(action.getAttribute('href')).toBe('tel:+261341234567');
    expect(screen.getByText(/Contactez-le directement/)).toBeDefined();
  });

  it('se rabat sur l’e-mail quand le salon n’a pas publié de numéro', () => {
    const contact = salonContactAction({ ...tenant, contactEmail: 'contact@lotus.test' });

    render(<ServiceCatalog services={[]} contact={contact} />);

    expect(screen.getByRole('link', { name: 'Écrire au salon' }).getAttribute('href')).toBe(
      'mailto:contact@lotus.test',
    );
  });

  it('n’ordonne pas de contacter un salon qui n’a publié aucune coordonnée', () => {
    // C'est l'écart relevé : l'unique action proposée n'avait ni numéro ni
    // adresse pour s'exercer. L'explication reste, l'ordre irréalisable part.
    render(<ServiceCatalog services={[]} contact={salonContactAction(tenant)} />);

    expect(screen.getByText('Catalogue en cours de préparation')).toBeDefined();
    expect(screen.queryByText(/Contactez-le directement/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('ne fait pas appeler la gérante son propre salon dans l’aperçu du back-office', () => {
    // L'aperçu (`admin/catalogue/apercu`) réemploie ce catalogue sans contact :
    // le constat suffit, et l'action n'aurait aucun sens de ce côté-là.
    render(<ServiceCatalog services={[]} />);

    expect(screen.getByText('Catalogue en cours de préparation')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('ne montre aucune de ces mentions quand le catalogue est plein', () => {
    render(
      <ServiceCatalog
        services={[service]}
        contact={salonContactAction({ ...tenant, contactPhone: '+261341234567' })}
      />,
    );

    expect(screen.queryByText('Catalogue en cours de préparation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Appeler le salon' })).toBeNull();
  });
});

describe('informations pratiques absentes', () => {
  it('n’assure plus que la réservation reste ouverte quand elle ne l’est pas', () => {
    render(<SalonInfo tenant={tenant} bookable={false} />);

    expect(screen.getByText('Informations non communiquées')).toBeDefined();
    expect(screen.queryByText(/La réservation en ligne reste ouverte/)).toBeNull();
  });

  it('le dit encore quand elle l’est vraiment', () => {
    render(<SalonInfo tenant={tenant} bookable />);

    expect(screen.getByText(/La réservation en ligne reste ouverte/)).toBeDefined();
  });
});

describe('moyen de joindre le salon', () => {
  it('préfère le téléphone à l’e-mail, comme le prescrit la référence', () => {
    // `states.md`, étape 1 : « proposer de contacter le salon (téléphone) ».
    expect(
      salonContactAction({
        ...tenant,
        contactEmail: 'contact@lotus.test',
        contactPhone: '+261341234567',
      }),
    ).toEqual({ href: 'tel:+261341234567', label: 'Appeler le salon' });
  });

  it('retire de la destination les séparateurs qu’un `tel:` n’admet pas', () => {
    // `storedPhoneSchema` conserve délibérément l'écriture du salon — espaces,
    // points, parenthèses. Un `href` qui les porterait ne serait pas une URI
    // valide (RFC 3966), et tous les agents utilisateurs ne les rattrapent pas.
    expect(
      salonContactAction({ ...tenant, contactPhone: '+261 34 12 345 67' })?.href,
    ).toBe('tel:+261341234567');
  });

  it('resserre aussi le numéro cliquable des informations pratiques', () => {
    // Deux `tel:` sur la même page, un seul constructeur : les laisser diverger
    // est ce que ce dossier évite déjà pour ses libellés.
    render(<SalonInfo tenant={{ ...tenant, contactPhone: '+261 34 12 345 67' }} bookable />);

    expect(screen.getByRole('link', { name: '+261 34 12 345 67' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
  });

  it('ne fabrique rien à partir d’une adresse postale, qui ne joint personne', () => {
    expect(
      salonContactAction({
        ...tenant,
        address: { line1: '12 rue des Lilas', city: 'Paris', country: 'FR' },
      }),
    ).toBeNull();
  });
});
