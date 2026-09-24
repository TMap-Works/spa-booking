/**
 * La saisie **non quittée** survit au rechargement (#737).
 *
 * Le brouillon n'était versé qu'au `focusout` du champ : les quatre premiers
 * champs de l'étape « Coordonnées » revenaient d'un rafraîchissement, et « Un mot
 * pour le salon » — le dernier, celui qu'on est encore en train de taper —
 * revenait vide. `docs/design/appointments/README.md`, « Le modèle en six
 * étapes », promet l'inverse : l'état est « doublé en `sessionStorage`, pour
 * qu'un rafraîchissement ne perde jamais la saisie ».
 *
 * Deux niveaux ici, et c'est délibéré :
 *
 * - le **crochet de report**, avec un faux temporisateur : c'est là que se décide
 *   *quand* on écrit, et c'est ce qui ne s'éprouve pas à travers un formulaire
 *   sans rendre le test tributaire du temps réel ;
 * - le **tunnel monté**, pour la seule chose qu'un test d'unité du crochet ne
 *   peut pas dire : que ce qui est écrit atterrit bien dans `sessionStorage`, et
 *   que le champ le retrouve au montage suivant — c'est-à-dire après le
 *   rechargement que le ticket reproduit.
 *
 * Les actions serveur sont remplacées, comme dans `booking-tunnel.test.tsx` :
 * hors du serveur, ce sont des modules Next qui n'existent pas. Aucune n'est
 * appelée par ce scénario, qui n'atteint jamais le récapitulatif.
 */

import type { UtcInstant } from '@spa/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingTunnel } from '@/app/(booking)/[tenantSlug]/reservation/booking-tunnel';
import {
  DRAFT_AUTOSAVE_DELAY_MS,
  useDraftAutosave,
} from '@/app/(booking)/[tenantSlug]/reservation/use-draft-autosave';
import { emptyBookingDraft, readBookingDraft, writeBookingDraft } from '@/lib/booking/draft';

import { contact, contactAccount, presence, service, tenant } from './fixtures';

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: vi.fn(),
}));

// La réservation part vers l'espace client depuis #1207 : c'est ce module-là
// que le tunnel importe désormais, et qu'il faut neutraliser ici.
vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-request', () => ({
  requestBooking: vi.fn(),
}));

/** Le mot laissé au salon, celui que le rechargement emportait. */
const NOTE = 'Allergie à l’huile d’amande douce';
const CRENEAU = '2026-09-01T06:00:00.000Z' as UtcInstant;
const ADRESSE = `/${tenant.slug}/reservation`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('le crochet de report du brouillon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /**
   * Un composant qui n'a que le crochet pour objet.
   *
   * Éprouver le report à travers le formulaire entier mêlerait deux questions —
   * *quand* on écrit, et *ce que* le formulaire donne à écrire. La seconde est
   * celle du test du tunnel, plus bas.
   */
  function SondeDeReport({ save }: { readonly save: () => void }) {
    const autosave = useDraftAutosave(save);

    return (
      <>
        <button type="button" onClick={autosave.schedule}>
          reporter
        </button>
        <button type="button" onClick={autosave.cancel}>
          annuler
        </button>
      </>
    );
  }

  function monterSonde() {
    const save = vi.fn();
    const { unmount } = render(<SondeDeReport save={save} />);

    return {
      save,
      unmount,
      frapper: () => {
        fireEvent.click(screen.getByRole('button', { name: 'reporter' }));
      },
      annuler: () => {
        fireEvent.click(screen.getByRole('button', { name: 'annuler' }));
      },
      attendre: (ms: number) => {
        act(() => {
          vi.advanceTimersByTime(ms);
        });
      },
    };
  }

  /** Le masquage de la page, tel qu'un navigateur le distribue au départ. */
  function masquerLaPage(): void {
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
  }

  /** L'onglet qui passe en arrière-plan — l'OS peut le recharger sans prévenir. */
  function passerEnArrierePlan(): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Supprimé, et non redéfini sur la valeur lue avant la bascule : rendre
    // l'accesseur du prototype laisse `document` dire la vérité ensuite. Figer
    // « visible » en propriété propre ferait passer un crochet qui aurait cessé
    // de regarder l'état réel.
    Reflect.deleteProperty(document, 'visibilityState');
  }

  it('n’écrit qu’une fois pour une rafale de frappes', () => {
    const { save, frapper, attendre } = monterSonde();

    frapper();
    frapper();
    frapper();
    // Le brouillon est réécrit en entier à chaque fois : une écriture par
    // caractère coûterait une sérialisation et un rendu du tunnel par lettre.
    attendre(DRAFT_AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();

    attendre(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('verse ce qui est en attente quand la page s’en va', () => {
    const { save, frapper, attendre } = monterSonde();

    frapper();
    masquerLaPage();

    // C'est le cas du ticket : le rechargement tombe **avant** l'échéance du
    // report, et sans ce filet la frappe partirait avec la page.
    expect(save).toHaveBeenCalledTimes(1);

    // Le report a été consommé, pas seulement doublé : l'échéance passée ne
    // provoque pas une seconde écriture.
    attendre(DRAFT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('verse ce qui est en attente quand l’onglet passe en arrière-plan', () => {
    const { save, frapper } = monterSonde();

    frapper();
    passerEnArrierePlan();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('n’écrit rien quand la page se masque sans frappe en attente', () => {
    const { save } = monterSonde();

    masquerLaPage();
    passerEnArrierePlan();

    // Sans cette garde, chaque changement d'onglet réécrirait un brouillon
    // identique et ferait rendre le tunnel pour rien.
    expect(save).not.toHaveBeenCalled();
  });

  it('le démontage de l’étape n’emporte pas la frappe en attente', () => {
    const { save, frapper, unmount } = monterSonde();

    frapper();
    // Le geste retour du navigateur change d'étape sans passer par nos boutons :
    // le temporisateur partirait avec le composant.
    act(() => {
      unmount();
    });

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('abandonne le report quand l’appelant vient d’écrire lui-même', () => {
    const { save, frapper, annuler, attendre } = monterSonde();

    frapper();
    annuler();
    attendre(DRAFT_AUTOSAVE_DELAY_MS);

    expect(save).not.toHaveBeenCalled();
  });
});

describe('« Un mot pour le salon » face à un rechargement', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', ADRESSE);
    // Une cliente arrivée à l'étape « Coordonnées » : prestation et créneau
    // retenus, les quatre champs de contact déjà remplis — l'état exact de la
    // capture du ticket, juste avant qu'elle ne tape son mot au salon.
    writeBookingDraft(tenant.slug, {
      ...emptyBookingDraft(),
      step: 'coordonnees',
      serviceId: service.id,
      startsAt: CRENEAU,
      contact: { ...contact, clientNote: '' },
      // Le brouillon est celui de la cliente connectée, et le dit (#1151) :
      // sans propriétaire, le tunnel le tiendrait pour celui d'une autre et en
      // viderait les champs avant même le premier rendu de l'étape.
      contactAccount,
    });
    vi.useFakeTimers();
  });

  // `<textarea>` depuis #748 : le champ est le seul du formulaire dont le
  // contrat est `longTextSchema`, et le design system lui donne `TextArea`.
  function champDuMot(): HTMLTextAreaElement {
    return screen.getByLabelText<HTMLTextAreaElement>(/Un mot pour le salon/);
  }

  /**
   * Le mot tapé dans le champ, **sans le quitter** : ni `focusout`, ni
   * soumission, ni clic ailleurs.
   *
   * `fireEvent` plutôt que `userEvent` : le faux temporisateur est ici tout le
   * sujet, et la frappe simulée de `userEvent` attend de vrais intervalles entre
   * les touches. Ce qu'il faut éprouver n'est pas le clavier — c'est l'instant où
   * le brouillon est écrit, et il doit rester sous le contrôle du test.
   */
  function taperLeMot(): HTMLTextAreaElement {
    const champ = champDuMot();

    act(() => {
      champ.focus();
    });
    fireEvent.input(champ, { target: { value: NOTE } });

    return champ;
  }

  /** Ce que porte le brouillon relu — c'est-à-dire ce qu'un rechargement retrouve. */
  function motEnregistre(): string {
    return readBookingDraft(tenant.slug).contact.clientNote;
  }

  it('est enregistré sans que le champ ait été quitté', () => {
    render(<BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={emptyBookingDraft()}
      />);

    const champ = taperLeMot();

    expect(document.activeElement).toBe(champ);

    act(() => {
      vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS);
    });

    expect(motEnregistre()).toBe(NOTE);
  });

  it('est retrouvé dans le champ au montage suivant', () => {
    render(<BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={emptyBookingDraft()}
      />);

    taperLeMot();
    act(() => {
      vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS);
    });

    // Le rechargement de `/spa-lumiere/reservation` du ticket : le tunnel repart
    // de l'adresse et du stockage, sans rien de l'arbre précédent.
    cleanup();
    render(<BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={emptyBookingDraft()}
      />);

    expect(champDuMot().value).toBe(NOTE);
    // Les quatre champs qui survivaient déjà survivent toujours : la correction
    // n'a pas déplacé le problème.
    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe(contact.firstName);
  });

  it('est enregistré tout de suite si la page se masque pendant la frappe', () => {
    render(<BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={emptyBookingDraft()}
      />);

    taperLeMot();
    // Le report n'a pas encore couru : c'est le rechargement qui tombe pendant
    // la frappe, celui du ticket.
    expect(motEnregistre()).toBe('');

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    // Sans avancer le temporisateur, et sans laisser React rendre : le
    // navigateur qui s'en va n'exécute plus d'effet passif, donc l'écriture dans
    // `sessionStorage` doit avoir eu lieu dans le geste lui-même.
    expect(motEnregistre()).toBe(NOTE);
  });
});

/**
 * La soumission **refusée** ne jette pas la frappe en attente.
 *
 * Une soumission qui passe emporte la saisie entière au récapitulatif, et le
 * report en attente n'a plus rien à verser. Refusée, elle laisse la cliente sur
 * l'étape — et `shouldFocusError` de react-hook-form redonne le focus au champ
 * fautif, qui est justement celui qu'elle tapait : aucun `focusout` n'a eu lieu,
 * et le report est la seule copie de ses dernières lettres. Les abandonner les
 * perdrait au premier rafraîchissement, c'est-à-dire exactement la perte que
 * #737 corrige.
 */
describe('une soumission refusée sur le champ en cours de frappe', () => {
  /**
   * Un numéro commencé : trop court pour le pays du drapeau — les États-Unis,
   * ce salon n'ayant pas publié d'adresse —, `e164PhoneSchemaFor` le refuse et
   * le champ garde le focus.
   */
  const NUMERO_REFUSE = '415 555';
  /** Ce que le brouillon en garde : l'E.164 que le champ émet depuis #825. */
  const NUMERO_REFUSE_E164 = '+1415555';

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', ADRESSE);
    writeBookingDraft(tenant.slug, {
      ...emptyBookingDraft(),
      step: 'coordonnees',
      serviceId: service.id,
      startsAt: CRENEAU,
      contact: { ...contact, phone: '' },
      // Même raison qu'au bloc précédent : le brouillon appartient à la cliente
      // connectée (#1151).
      contactAccount,
    });
    vi.useFakeTimers();
  });

  it('verse la saisie en attente au lieu de l’abandonner', async () => {
    render(<BookingTunnel
        tenant={tenant}
        services={[service]}
        exitHref={`/${tenant.slug}`}
        presence={presence}
        loginHref={`/${tenant.slug}/compte/connexion`}
        registerHref={`/${tenant.slug}/compte/inscription`}
        initialDraft={emptyBookingDraft()}
      />);

    const champ = screen.getByLabelText<HTMLInputElement>(/Téléphone/);

    act(() => {
      champ.focus();
    });
    fireEvent.input(champ, { target: { value: NUMERO_REFUSE } });

    // Soumission sans quitter le champ — la touche « Entrée », ou le bouton
    // tapé sur un navigateur mobile qui ne déplace pas le focus.
    fireEvent.submit(champ.closest('form') as HTMLFormElement);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS);
    });

    // La cliente est restée sur l'étape : la validation a bien refusé.
    expect(screen.queryByLabelText(/Téléphone/)).not.toBeNull();
    expect(readBookingDraft(tenant.slug).contact.phone).toBe(NUMERO_REFUSE_E164);
  });
});
