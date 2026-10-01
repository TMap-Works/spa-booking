import { ERROR_CODES, LOCALES, errorMessage, type BookedAppointment, type Locale } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Les deux écrans qui lisent les refus des Route Handlers de l'espace client
 * nomment l'établissement — #1394, quatrième critère.
 *
 * ## Ce que cette suite prouve, et ce qu'elle laisse à l'autre
 *
 * `etablissement-inconnu-routes-espace-client.test.ts` exerce les **vraies** routes :
 * elle prouve qu'elles rendent `TENANT_NOT_FOUND` en 404. Celle-ci monte les deux
 * écrans qui reçoivent ces refus et les leur tend, elle prouve qu'ils les
 * **nomment**, dans les deux langues. Aucune des deux ne suffit seule — la première
 * laisse ouverte la possibilité d'un écran qui écraserait la phrase, la seconde
 * celle d'un refus qu'aucune route ne produit.
 *
 * ## Pourquoi des écrans qui n'ont pas changé d'une ligne se mesurent quand même
 *
 * C'est le résultat du ticket, et non son angle mort : `summary-step.tsx` et
 * `confirmation-step.tsx` lisent leur refus par `refusalMessage(refusal, locale)`
 * depuis #1327 et #1354, **sans table `own`** — leur phrase est donc toujours celle
 * du contrat. Un code distinct suffit à leur faire dire « Cet établissement est
 * introuvable. » là où ils disaient la tournure générique du refus de saisie, comme
 * aux dix-neuf écrans de #1375 et à l'étape « Créneau » de #1391.
 *
 * Et c'est précisément pourquoi la phrase **évincée** est celle du contrat et non
 * celle d'un catalogue : ces deux écrans n'ont jamais nommé `VALIDATION_ERROR` en
 * propre. Ce qu'ils affichaient pour un segment d'URL que personne n'avait tapé était
 * « Certaines informations sont incomplètes ou mal formées. » — la phrase d'un
 * formulaire fautif sous un refus qui n'en était pas un.
 *
 * ## Le sélecteur de langue, et pourquoi il est rejoué plutôt que supposé
 *
 * Le refus est rangé en état sous la forme de son **code** (#1327, #1354), et la
 * phrase se calcule au rendu. Le second rendu de chaque cas est donc la moitié qui
 * compte : un écran qui aurait rangé la phrase resterait vert sur le premier et
 * bilingue sur le second. `rerender` et non un second `render`, parce que c'est le
 * geste réel — le même arbre se rend à nouveau, **avec son état**.
 *
 * Les phrases attendues sont **lues** — `errorMessage` pour celles du contrat, les
 * catalogues du dépôt pour les libellés des boutons — et jamais recopiées : un
 * littéral resterait vert le jour où un écran cesserait de consulter la table.
 */

const requestBooking = vi.fn();
const requestCancellation = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-request', () => ({
  requestBooking: (...args: unknown[]) => requestBooking(...args),
}));

vi.mock(
  '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/cancellation-request',
  () => ({ requestCancellation: (...args: unknown[]) => requestCancellation(...args) }),
);

vi.mock('next-intl', () => nextIntlMobile());

import { ConfirmationStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/confirmation-step';
import { SummaryStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/summary-step';

import { contact, service, tenant } from './fixtures';

const RENDEZ_VOUS: BookedAppointment = {
  id: '55555555-5555-4555-8555-555555555555',
  reference: 'RDV-8F3K-27',
  status: 'confirmed',
  serviceId: service.id,
  staffId: service.staff[0]?.id ?? '',
  clientId: '66666666-6666-4666-8666-666666666666',
  startsAt: '2026-09-01T06:00:00.000Z',
  endsAt: '2026-09-01T07:00:00.000Z',
  price: service.price,
  clientNote: null,
  rescheduledFromId: null,
  cancelledAt: null,
  cancelledBy: null,
};

/**
 * Le refus tel que les deux routes le rendent — code du contrat, et sa phrase lue
 * dans la table bilingue.
 *
 * Le `message` est posé pour être **ignoré** : les écrans gardent le code et
 * réécrivent la phrase au rendu. Le poser dans la langue d'avant le sélecteur est ce
 * qui rend le second rendu concluant.
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
 * Celle que ces écrans disaient à sa place, faute d'un code qui nomme
 * l'établissement — la tournure générique du refus de saisie.
 */
function phraseEvincee(locale: Locale): string {
  return errorMessage(ERROR_CODES.VALIDATION_ERROR, locale);
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

/** L'encart rouge de l'écran, texte normalisé — titre compris. */
function refus(): string {
  return (document.querySelector('.spa-notification--danger')?.textContent ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function recapitulatif(): ReactElement {
  return (
    <SummaryStep
      tenant={tenant}
      service={service}
      staffId={null}
      startsAt="2026-09-01T06:00:00.000Z"
      contact={contact}
      onBack={vi.fn()}
      onEditSlot={vi.fn()}
      onEditService={vi.fn()}
      onBooked={vi.fn()}
      onSlotLost={vi.fn()}
      onSignInRequired={vi.fn()}
    />
  );
}

function confirmation(): ReactElement {
  return (
    <ConfirmationStep
      tenant={tenant}
      service={service}
      appointment={RENDEZ_VOUS}
      contact={contact}
      restored={false}
      onCancelled={vi.fn()}
      onRestart={vi.fn()}
    />
  );
}

/** Confirme la réservation, et rend de quoi rejouer l'écran dans l'autre langue. */
async function refuserLaReservation(locale: Locale): Promise<() => void> {
  const user = userEvent.setup();
  const { rerender } = render(recapitulatif());

  await user.click(
    screen.getByRole('button', { name: libelle(locale, 'booking.tunnel.summaryStep.submit') }),
  );

  return () => {
    fixerLangue('en');
    rerender(recapitulatif());
  };
}

/** Demande l'annulation, la confirme, et rend de quoi rejouer l'écran. */
async function refuserLAnnulation(locale: Locale): Promise<() => void> {
  const user = userEvent.setup();
  const { rerender } = render(confirmation());

  await user.click(
    screen.getByRole('button', { name: libelle(locale, 'booking.tunnel.confirmationStep.cancel') }),
  );
  await user.click(
    screen.getByRole('button', {
      name: libelle(locale, 'booking.tunnel.confirmationStep.confirmCancel'),
    }),
  );

  return () => {
    fixerLangue('en');
    rerender(confirmation());
  };
}

afterEach(() => {
  cleanup();
  requestBooking.mockReset();
  requestCancellation.mockReset();
  fixerLangue('fr');
});

describe.each([...LOCALES])('le récapitulatif de la réservation, en « %s »', (locale) => {
  it('nomme l’établissement plutôt que les informations de réservation', async () => {
    fixerLangue(locale);
    requestBooking.mockResolvedValue(refusEtablissement(locale));

    await refuserLaReservation(locale);

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue(locale));
    });
    // La moitié qu'on oublie : la tournure du refus de saisie ne doit pas s'y
    // ajouter. Sans elle, un écran qui afficherait les deux resterait vert.
    expect(refus()).not.toContain(phraseEvincee(locale));
  });
});

describe.each([...LOCALES])('l’écran de confirmation du tunnel, en « %s »', (locale) => {
  it('nomme l’établissement plutôt que la demande d’annulation', async () => {
    fixerLangue(locale);
    requestCancellation.mockResolvedValue(refusEtablissement(locale));

    await refuserLAnnulation(locale);

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue(locale));
    });
    expect(refus()).not.toContain(phraseEvincee(locale));
  });
});

/**
 * Le sélecteur de langue emporte la phrase déjà affichée — #1327 et #1354, rejoués
 * pour le code que ce ticket porte sur ces deux surfaces.
 *
 * Un seul sens suffit : ce qui est en cause est la **forme de l'état**, et
 * `setRefusal({ code })` la tient pour tous les codes à la fois. Le `message` du
 * refus reste français ; s'il atteignait l'écran, le second rendu le montrerait
 * encore.
 */
describe('la phrase se réécrit quand la langue change sous l’écran', () => {
  it('au récapitulatif de la réservation', async () => {
    fixerLangue('fr');
    requestBooking.mockResolvedValue(refusEtablissement('fr'));

    const enAnglais = await refuserLaReservation('fr');

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue('fr'));
    });

    enAnglais();

    expect(refus()).toContain(phraseAttendue('en'));
    expect(refus()).not.toContain(phraseAttendue('fr'));
    // Le titre suit le rendu depuis toujours : c'est le couple qui était faux, et
    // n'en vérifier qu'une moitié laisserait passer l'écran mixte.
    expect(refus()).toContain(libelle('en', 'booking.tunnel.summaryStep.failureTitle'));
  });

  it('à l’écran de confirmation', async () => {
    fixerLangue('fr');
    requestCancellation.mockResolvedValue(refusEtablissement('fr'));

    const enAnglais = await refuserLAnnulation('fr');

    await waitFor(() => {
      expect(refus()).toContain(phraseAttendue('fr'));
    });

    enAnglais();

    expect(refus()).toContain(phraseAttendue('en'));
    expect(refus()).not.toContain(phraseAttendue('fr'));
    expect(refus()).toContain(libelle('en', 'booking.tunnel.confirmationStep.cancelFailedTitle'));
  });
});
