import { ERROR_CODES, LOCALES, errorMessage, type Locale } from '@spa/shared';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * L'étape « Créneau » nomme l'établissement — #1391, troisième critère.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * `etablissement-inconnu-tunnel-public.test.ts` exerce la **vraie**
 * `loadAvailabilityAction` : elle prouve qu'elle rend `TENANT_NOT_FOUND`. Celle-ci
 * monte l'écran qui reçoit ce refus et le lui tend, elle prouve qu'il le **nomme**,
 * dans les deux langues. Aucune des deux ne suffit seule — la première laisse ouverte
 * la possibilité d'un écran qui écraserait la phrase, la seconde celle d'un refus
 * qu'aucune action ne produit.
 *
 * ## Pourquoi un écran qui n'a pas changé d'une ligne se mesure quand même
 *
 * C'est le résultat du ticket, et non son angle mort : `slot-step.tsx` lit le refus
 * par `refusalMessage(failure, locale, own)` depuis #1354, dont le repli est
 * `errorMessage(code, locale)`. Un code distinct suffit donc à lui faire dire la
 * phrase qui nomme l'établissement — comme aux dix-neuf écrans de #1375, qui n'ont
 * rien changé non plus.
 *
 * Ce qu'il n'a pas changé est précisément ce qu'il faut garder : son `own` nomme
 * `VALIDATION_ERROR` **et lui seul**. Rien dans ce fichier-là ne dit qu'il ne
 * nommerait pas un code de plus demain, et c'est ce que le second cas de chaque
 * langue ferme — le refus de l'établissement ne doit pas se mettre à emprunter la
 * phrase du refus de saisie, qui est exactement le défaut que ce ticket corrige.
 *
 * ## Le sélecteur de langue, et pourquoi il est rejoué plutôt que supposé
 *
 * Le refus est rangé en état sous la forme de son **code** (#1327), et la phrase se
 * calcule au rendu. Le second rendu de chaque cas est donc la moitié qui compte : un
 * écran qui aurait rangé la phrase resterait vert sur le premier et bilingue sur le
 * second.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat, les
 * catalogues du dépôt pour le libellé — et jamais recopiées : un littéral resterait
 * vert le jour où l'écran cesserait de consulter la table.
 */

const loadAvailabilityAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
}));

vi.mock('next-intl', () => nextIntlMobile());

import { SlotStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/slot-step';

import { service, tenant } from './fixtures';

/**
 * Le refus tel que `unknownTenant()` du tunnel le rend — code du contrat, et sa
 * phrase lue dans la table bilingue.
 *
 * Le `message` est posé pour être **ignoré** : l'écran garde le code et réécrit la
 * phrase au rendu. Le poser dans la langue d'avant le sélecteur est ce qui rend le
 * second rendu de chaque cas concluant.
 */
function refusEtablissement(locale: Locale) {
  return {
    ok: false,
    code: ERROR_CODES.TENANT_NOT_FOUND,
    message: errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale),
  } as const;
}

/** La phrase du contrat pour ce code, dans la langue du rendu. */
function phraseAttendue(locale: Locale): string {
  return errorMessage(ERROR_CODES.TENANT_NOT_FOUND, locale);
}

/**
 * Un libellé du catalogue, lu là où l'écran le lit — le même `loadMessages` que
 * le serveur emploie.
 */
function libelle(locale: Locale, chemin: string): string {
  const trouve = chemin
    .split('.')
    .reduce<string | MessageTree | undefined>(
      (noeud, cle) => (typeof noeud === 'object' ? noeud[cle] : undefined),
      loadMessages(locale),
    );

  if (typeof trouve !== 'string') {
    throw new Error(`libellé absent du catalogue « ${locale} » : ${chemin}`);
  }

  return trouve;
}

/** Celle que cet écran disait à sa place, faute d'un code qui le nomme — son `own`. */
function phraseEvincee(locale: Locale): string {
  return libelle(locale, 'booking.tunnel.actions.availabilityIncomplete');
}

/** L'encart rouge de l'étape, texte normalisé — titre compris. */
function refus(): string {
  return (document.querySelector('.spa-notification--danger')?.textContent ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function monter(): void {
  render(
    <SlotStep
      tenant={tenant}
      service={service}
      staffId={null}
      startsAt={null}
      summary={null}
      onBack={vi.fn()}
      onStaffChange={vi.fn()}
      onChoose={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  loadAvailabilityAction.mockReset();
  fixerLangue('fr');
});

describe.each([...LOCALES])('l’étape « Créneau », en « %s »', (locale) => {
  it('nomme l’établissement plutôt que la demande de créneaux', async () => {
    fixerLangue(locale);
    loadAvailabilityAction.mockResolvedValue(refusEtablissement(locale));

    monter();

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue(locale));
    });
    // La moitié qu'on oublie : la phrase du geste ne doit pas s'y ajouter. Sans
    // elle, un écran qui afficherait les deux resterait vert.
    expect(refus()).not.toContain(phraseEvincee(locale));
  });

  it('garde sa propre phrase pour le refus de la demande de créneaux', async () => {
    fixerLangue(locale);
    loadAvailabilityAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'ce que le serveur a écrit, et que rien n’affiche',
    });

    monter();

    await waitFor(() => {
      expect(refus()).toContain(phraseEvincee(locale));
    });
    // L'inverse du cas précédent : `own` ne doit pas avoir été vidé en chemin, sans
    // quoi ce refus-là retomberait sur la tournure générique du contrat.
    expect(refus()).not.toContain(phraseAttendue(locale));
  });
});

/**
 * Le sélecteur de langue emporte la phrase déjà affichée — #1327, rejoué pour le
 * code que ce ticket introduit sur cette surface.
 *
 * Un seul sens suffit ici : ce qui est en cause est la **forme de l'état**, et
 * `setFailure({ code })` la tient pour tous les codes à la fois. Le premier rendu est
 * en français, le second en anglais, et c'est la même notification qui est relue.
 */
describe('la phrase se réécrit quand la langue change sous l’écran', () => {
  it('passe au contrat anglais sans repasser par le français', async () => {
    fixerLangue('fr');
    // Le `message` reste français : s'il atteignait l'écran, le second rendu le
    // montrerait encore.
    loadAvailabilityAction.mockResolvedValue(refusEtablissement('fr'));

    monter();

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue('fr'));
    });

    cleanup();
    fixerLangue('en');
    monter();

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue('en'));
    });
    expect(refus()).not.toContain(phraseAttendue('fr'));
  });
});
