/**
 * L'étape que le serveur lit dans l'adresse (#1055).
 *
 * L'audit `d20260918-1` a relevé ce que coûtait de ne pas la lire : ouvrir
 * `?etape=creneau&prestation=…` affichait « Étape 1 sur 4 · Quelle
 * prestation ? » au-dessus d'un cadre vide, puis basculait sur l'étape reprise.
 * `BM-ECRAN-01` veut que la page ait déjà sa forme pendant le chargement — elle
 * ne l'aura jamais si elle commence par se tromper d'écran.
 *
 * Ce que cette suite tient, et que le rendu ne dirait pas : les quatre règles de
 * la résolution. L'adresse fait foi ; le catalogue a le dernier mot sur la
 * prestation ; ce qui n'est pas dans l'adresse n'est pas supposé ; et le
 * résultat ne promet jamais une étape que l'hydratation reprendrait aussitôt.
 */

import { describe, expect, it } from 'vitest';

import { initialBookingDraft } from '@/app/(booking)/[tenantSlug]/reservation/initial-draft';

import { service } from './fixtures';

const CATALOGUE = [service];
const CRENEAU = '2026-09-01T06:00:00.000Z';

describe('initialBookingDraft', () => {
  it('ouvre la première étape quand l’adresse ne dit rien', () => {
    const draft = initialBookingDraft({}, CATALOGUE);

    expect(draft.step).toBe('prestation');
    expect(draft.serviceId).toBeNull();
  });

  it('rend l’étape « créneau » que l’adresse demande, prestation comprise', () => {
    const draft = initialBookingDraft(
      { etape: 'creneau', prestation: service.id, praticien: service.staff[0]?.id },
      CATALOGUE,
    );

    expect(draft.step).toBe('creneau');
    expect(draft.serviceId).toBe(service.id);
    expect(draft.staffId).toBe(service.staff[0]?.id);
  });

  it('rend l’étape « coordonnées » quand l’adresse porte déjà un créneau', () => {
    const draft = initialBookingDraft(
      { etape: 'coordonnees', prestation: service.id, creneau: CRENEAU },
      CATALOGUE,
    );

    expect(draft.step).toBe('coordonnees');
    expect(draft.startsAt).toBe(CRENEAU);
  });

  /*
   * Le cas qui déplacerait le saut au lieu de le supprimer : annoncer « Étape 2
   * sur 4 » sur une prestation retirée du catalogue, que l'hydratation ramène
   * aussitôt à la première étape (`booking-tunnel.tsx`, `const step`).
   */
  it('retombe sur la prestation quand le catalogue ne résout plus celle de l’adresse', () => {
    const draft = initialBookingDraft(
      { etape: 'creneau', prestation: '99999999-9999-4999-8999-999999999999', creneau: CRENEAU },
      CATALOGUE,
    );

    expect(draft.step).toBe('prestation');
    expect(draft.serviceId).toBeNull();
    expect(draft.startsAt).toBeNull();
  });

  /*
   * Les coordonnées ne voyagent pas dans l'adresse (`lib/booking/draft.ts`) : le
   * serveur ne peut donc pas savoir si le récapitulatif a quelqu'un à qui
   * écrire. `reachableStep` tranche ici comme il tranchera à l'hydratation d'un
   * onglet neuf — l'étape précédente, celle du formulaire.
   */
  it('ramène le récapitulatif à l’étape des coordonnées, faute de les connaître', () => {
    const draft = initialBookingDraft(
      { etape: 'recapitulatif', prestation: service.id, creneau: CRENEAU },
      CATALOGUE,
    );

    expect(draft.step).toBe('coordonnees');
  });

  /* Le rendez-vous obtenu ne voyage pas non plus : `?etape=confirmation` mis en
   * favori ne peut pas ouvrir un écran terminal. */
  it('n’ouvre jamais la confirmation depuis la seule adresse', () => {
    const draft = initialBookingDraft(
      { etape: 'confirmation', prestation: service.id, creneau: CRENEAU },
      CATALOGUE,
    );

    expect(draft.step).toBe('coordonnees');
    expect(draft.appointment).toBeNull();
  });

  /* Une adresse bricolée ne fait pas planter le premier rendu : l'étape
   * illisible vaut « pas choisie », et le tunnel s'ouvre là où il y a quelque
   * chose à faire. */
  it('ignore une étape que le contrat ne connaît pas', () => {
    const draft = initialBookingDraft({ etape: 'paiement', prestation: service.id }, CATALOGUE);

    expect(draft.step).toBe('prestation');
  });

  /*
   * Next rend un tableau quand la clé paraît deux fois. La **première**
   * l'emporte, parce que c'est ce que rend le `URLSearchParams.get()` que le
   * tunnel posera sur la même adresse à l'hydratation : les deux lectures
   * doivent donner la même étape, sans quoi le premier rendu et l'hydratation
   * divergeraient — le saut que ce ticket supprime, simplement déplacé.
   */
  it('retient la première valeur quand une clé paraît deux fois', () => {
    const draft = initialBookingDraft(
      { etape: ['creneau', 'prestation'], prestation: service.id, creneau: CRENEAU },
      CATALOGUE,
    );

    expect(draft.step).toBe('creneau');
    // La lecture que le tunnel fera à l'hydratation, sur la même adresse.
    expect(
      new URLSearchParams(`etape=creneau&etape=prestation&prestation=${service.id}`).get('etape'),
    ).toBe('creneau');
  });
});
