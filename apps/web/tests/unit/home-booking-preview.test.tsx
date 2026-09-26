import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { BookingPreview } from '@/components/home/booking-preview';

/**
 * #1300 — la devise du prix montré par l'illustration de l'accueil.
 *
 * L'aperçu affichait « €75.00 » en anglais : la mise en forme suivait bien la
 * langue — c'est ce que #846 avait branché —, mais la devise restait figée en
 * euros, alors que la clientèle du produit est nord-américaine (décision du PO
 * du 2026-09-19, dont `lib/salon-presets.ts` tire son pays par défaut).
 *
 * Ce qui est éprouvé est la **devise**, pas la mise en forme : les séparateurs
 * et la place du symbole relèvent d'`Intl`, et les redire ici ferait passer la
 * suite pour une copie de la table ICU du moteur qui l'exécute. Un test par
 * langue, et la réciproque à chaque fois — sans elle, une devise qui ne
 * changerait jamais passerait la moitié des cas.
 *
 * `BookingPreview` est un Server Component **synchrone** qui lit ses messages
 * par les crochets : seule la doublure des crochets est posée, pas celle du
 * serveur (`tests/support/langue-mobile.ts`).
 */

vi.mock('next-intl', () => nextIntlMobile());

afterEach(() => {
  cleanup();
  fixerLangue('fr');
});

/** Le prix tel que la vignette le peint. */
function prixAffiche(container: HTMLElement): string {
  return container.querySelector('.spa-home-preview__price')?.textContent ?? '';
}

describe('l’aperçu de réservation de l’accueil', () => {
  it('affiche son prix en dollars quand la page est en anglais', () => {
    fixerLangue('en');

    const prix = prixAffiche(render(<BookingPreview />).container);

    expect(prix).toContain('$');
    expect(prix).not.toContain('€');
    expect(prix).toContain('75');
  });

  it('l’affiche en euros quand la page est en français', () => {
    const prix = prixAffiche(render(<BookingPreview />).container);

    expect(prix).toContain('€');
    expect(prix).not.toContain('$');
    expect(prix).toContain('75');
  });
});
