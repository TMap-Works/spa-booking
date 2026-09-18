/**
 * Le squelette de l'étape, avant hydratation (#1055).
 *
 * `BM-ECRAN-01` : *« pendant le chargement, la page a déjà sa forme — des blocs
 * gris aux formes des cartes, du récapitulatif et du bouton final »*. Ce que
 * cette suite tient est ce qu'un rendu peut prouver : chaque étape dessine **sa**
 * forme et non un cadre unique, l'attente est annoncée à qui ne voit pas
 * l'écran, et la liste de prestations porte le compte réel du catalogue — sans
 * quoi la page sauterait à l'arrivée du contenu, ce que le squelette est
 * précisément là pour empêcher.
 *
 * Les hauteurs, elles, ne se voient pas sous jsdom, qui ne charge aucune feuille
 * de style : c'est `tests/booking-skeleton-reserve.test.mjs` qui les compare,
 * jeton par jeton.
 */

import type { PublicService } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BookingStepSkeleton } from '@/components/booking/step-skeleton';

import { service } from './fixtures';

/** Une seconde prestation, dans une **autre** rubrique : deux, donc des onglets. */
const soin: PublicService = {
  ...service,
  id: '77777777-7777-4777-8777-777777777777',
  slug: 'soin-visage',
  name: 'Soin du visage',
  category: { id: '88888888-8888-4888-8888-888888888888', slug: 'soins', name: 'Soins' },
};

/** Une troisième, dans la rubrique de la première : la rubrique en a deux. */
const massageProfond: PublicService = {
  ...service,
  id: '99999999-9999-4999-8999-999999999999',
  slug: 'massage-profond',
  name: 'Massage profond',
};

afterEach(cleanup);

describe('BookingStepSkeleton', () => {
  it('annonce l’attente de chaque étape à qui ne voit pas l’écran', () => {
    const { container } = render(
      <BookingStepSkeleton step="creneau" services={[service]} selectedServiceId={service.id} />,
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText('Chargement des disponibilités…')).toBeTruthy();
  });

  it('dit ce qui charge, et pas « chargement » tout court', () => {
    render(<BookingStepSkeleton step="prestation" services={[service]} selectedServiceId={null} />);

    expect(screen.getByText('Chargement des prestations…')).toBeTruthy();
  });

  /*
   * Le cœur du ticket : une ligne grise par prestation réellement attendue. Le
   * catalogue d'essai a deux prestations dans « Massages » — c'est la rubrique
   * que `ServiceChoice` ouvre par défaut, et c'est donc deux lignes.
   */
  it('dessine autant de lignes que la rubrique ouverte a de prestations', () => {
    const { container } = render(
      <BookingStepSkeleton
        step="prestation"
        services={[service, massageProfond, soin]}
        selectedServiceId={null}
      />,
    );

    expect(container.querySelectorAll('.spa-booking__service')).toHaveLength(2);
  });

  /* Même lecture que `ServiceChoice` : la rubrique ouverte est celle qui porte
   * le choix déjà fait, et non la première. */
  it('ouvre la rubrique de la prestation que l’adresse désigne', () => {
    const { container } = render(
      <BookingStepSkeleton
        step="prestation"
        services={[service, massageProfond, soin]}
        selectedServiceId={soin.id}
      />,
    );

    expect(container.querySelectorAll('.spa-booking__service')).toHaveLength(1);
  });

  it('n’ouvre la rangée d’onglets qu’à partir de deux rubriques', () => {
    const une = render(
      <BookingStepSkeleton step="prestation" services={[service]} selectedServiceId={null} />,
    );

    expect(une.container.querySelector('.spa-booking__skeleton-tabs')).toBeNull();

    cleanup();

    const deux = render(
      <BookingStepSkeleton
        step="prestation"
        services={[service, soin]}
        selectedServiceId={null}
      />,
    );

    expect(deux.container.querySelector('.spa-booking__skeleton-tabs')).not.toBeNull();
  });

  /* `states.md` étape 3 : la bande de jours **puis** la grille d'horaires. Un
   * cadre unique, à cette étape, ne ressemblerait à rien de ce qui arrive. */
  it('dessine la bande de jours et les pastilles d’horaires à l’étape « créneau »', () => {
    const { container } = render(
      <BookingStepSkeleton step="creneau" services={[service]} selectedServiceId={service.id} />,
    );

    expect(container.querySelectorAll('.spa-booking__skeleton-day').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.spa-booking__skeleton-slot').length).toBeGreaterThan(0);
  });

  it('dessine les champs du formulaire à l’étape « coordonnées »', () => {
    const { container } = render(
      <BookingStepSkeleton
        step="coordonnees"
        services={[service]}
        selectedServiceId={service.id}
      />,
    );

    // Deux noms, l'e-mail, le téléphone, le mot pour le salon.
    expect(container.querySelectorAll('.spa-field')).toHaveLength(5);
    expect(container.querySelector('.spa-booking__skeleton-control--tall')).not.toBeNull();
  });

  it('dessine la carte du récapitulatif à l’étape « récapitulatif »', () => {
    const { container } = render(
      <BookingStepSkeleton
        step="recapitulatif"
        services={[service]}
        selectedServiceId={service.id}
      />,
    );

    expect(container.querySelector('.spa-card')).not.toBeNull();
    expect(container.querySelectorAll('.spa-booking__recap-row').length).toBeGreaterThan(0);
  });

  /* `wireframes.md` étape 6 : *« Plus d'indicateur d'étape ni de barre
   * collante : le tunnel est terminé »*. Le squelette ne promet donc pas une
   * action primaire qui n'arrivera pas. */
  it('ne dessine la barre basse qu’avant la confirmation', () => {
    const avant = render(
      <BookingStepSkeleton
        step="recapitulatif"
        services={[service]}
        selectedServiceId={service.id}
      />,
    );

    expect(avant.container.querySelector('.spa-booking__bar')).not.toBeNull();

    cleanup();

    const apres = render(
      <BookingStepSkeleton
        step="confirmation"
        services={[service]}
        selectedServiceId={service.id}
      />,
    );

    expect(apres.container.querySelector('.spa-booking__bar')).toBeNull();
  });
});
