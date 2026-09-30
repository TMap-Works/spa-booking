import {
  ERROR_CODES,
  LOCALES,
  errorMessage,
  type Appointment,
  type Locale,
  type Service,
} from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

import { deskSlot, deskSlots } from './admin-desk-fixtures';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';
import { CheckoutPanel } from '@/app/(admin)/[tenantSlug]/admin/components/checkout-panel';
import { ClientPicker } from '@/app/(admin)/[tenantSlug]/admin/components/client-picker';
import { planningWords } from '@/lib/admin/calendar-messages';
import { checkoutWords } from '@/lib/admin/checkout-summary';

/**
 * L'établissement inconnu se nomme, et ne prend la phrase d'aucun geste — #1372.
 *
 * ## Le défaut que cette suite ferme
 *
 * Les actions du back-office jugent le slug d'établissement qu'on leur passe
 * avant tout appel — il vient de l'URL, et une action serveur est un point
 * d'entrée public. Ce refus portait `VALIDATION_ERROR` et n'avait pas de
 * `details`, exactement comme les refus de **saisie** que chaque geste oppose de
 * son côté. Or c'est cette absence de `details` que les quatre écrans du
 * planning et du comptoir lisaient pour reconnaître « le refus que l'action a
 * opposé elle-même » et lui prêter la phrase de son geste (#1367, #1369) : la
 * garde sépare bien l'action de l'API, elle ne sépare pas deux refus que la
 * **même** action oppose. « Établissement inconnu » s'affichait donc
 * « Recherche invalide. », « Le report saisi est invalide. », « Date de planning
 * invalide. » — la phrase d'un geste dont il n'était pas le refus.
 *
 * Le remède est un **code** propre, `TENANT_NOT_FOUND`, et non un marqueur dans
 * `details` : la raison du choix est écrite en tête de
 * `app/(admin)/[tenantSlug]/admin/action-result.ts` et de
 * `packages/shared/src/errors/error-codes.ts`. Sa conséquence se lit dans cette
 * suite : **aucun des quatre écrans n'a eu à changer de logique**, puisqu'ils
 * trient déjà sur le code et réservent la phrase de leur geste au seul
 * `VALIDATION_ERROR`. Ce sont eux qu'on éprouve ici, pas le code.
 *
 * ## Deux langues, et la même suite
 *
 * `langue-mobile.ts` plutôt qu'une seconde suite anglaise : ce qui est éprouvé
 * est la **même** assertion dans les deux langues, et la dupliquer aurait fait
 * deux écritures qu'un ticket ultérieur n'aurait corrigées qu'à moitié. La
 * phrase attendue est lue — `errorMessage` pour celle du contrat, `planningWords`
 * et `checkoutWords` pour celles des écrans —, jamais recopiée : un littéral
 * resterait vert le jour où l'écran cesserait de consulter la table.
 *
 * ## Chaque cas exige les deux moitiés
 *
 * La phrase qui nomme l'établissement **et** l'absence de celle du geste. La
 * première seule laisserait passer un écran qui affiche les deux ; la seconde
 * seule, un écran qui n'affiche plus rien du tout.
 */

const loadCalendarRangeAction = vi.fn();
const loadDeskAvailabilityAction = vi.fn();
const loadDeskServiceStaffAction = vi.fn();
const loadAppointmentNotificationsAction = vi.fn();
const createDeskAppointmentAction = vi.fn();
const rescheduleDeskAppointmentAction = vi.fn();
const markDeskAppointmentStatusAction = vi.fn();
const cancelDeskAppointmentAction = vi.fn();
const searchDeskClientsAction = vi.fn();
const createDeskClientAction = vi.fn();
const openCheckoutTicketAction = vi.fn();
const settleTicketAction = vi.fn();
const loadReceiptAction = vi.fn();

// Le module est doublé **en entier** : le tiroir et le planning en importent
// neuf, et un module simulé qui n'en porterait qu'une partie ferait échouer
// l'import bien avant le premier rendu.
vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  loadCalendarRangeAction: (...args: unknown[]) => loadCalendarRangeAction(...args),
  loadDeskAvailabilityAction: (...args: unknown[]) => loadDeskAvailabilityAction(...args),
  loadDeskServiceStaffAction: (...args: unknown[]) => loadDeskServiceStaffAction(...args),
  loadAppointmentNotificationsAction: (...args: unknown[]) =>
    loadAppointmentNotificationsAction(...args),
  createDeskAppointmentAction: (...args: unknown[]) => createDeskAppointmentAction(...args),
  rescheduleDeskAppointmentAction: (...args: unknown[]) =>
    rescheduleDeskAppointmentAction(...args),
  markDeskAppointmentStatusAction: (...args: unknown[]) =>
    markDeskAppointmentStatusAction(...args),
  cancelDeskAppointmentAction: (...args: unknown[]) => cancelDeskAppointmentAction(...args),
  searchDeskClientsAction: (...args: unknown[]) => searchDeskClientsAction(...args),
  createDeskClientAction: (...args: unknown[]) => createDeskClientAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/encaissement/actions', () => ({
  openCheckoutTicketAction: (...args: unknown[]) => openCheckoutTicketAction(...args),
  settleTicketAction: (...args: unknown[]) => settleTicketAction(...args),
  loadReceiptAction: (...args: unknown[]) => loadReceiptAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next-intl', () => nextIntlMobile());

const SLUG = 'maison-lotus';
const TIMEZONE = 'Indian/Antananarivo';

/**
 * Le refus tel que `unknownTenant()` le rend — code du contrat, aucun `details`.
 *
 * L'absence de `details` n'est pas un oubli : c'est **la** propriété du cas. Un
 * refus opposé par l'action n'en porte pas, et c'est précisément ce qui le
 * faisait passer pour le refus de saisie du geste avant ce ticket.
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

const MASSAGE: Service = {
  id: 'cccccccc-0000-4000-8000-000000000001',
  slug: 'massage-suedois',
  name: 'Massage suédois',
  description: null,
  category: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  occupiedMinutes: 75,
  price: { amountMinor: 3500, currency: 'EUR' },
  isActive: true,
  assignedStaffCount: 1,
  activeAssignedStaffCount: 1,
};

/** 09:00 – 10:00 au salon d'Antananarivo, le mercredi 26 août 2026. */
const CONFIRME: Appointment = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  reference: 'RDV-8F3K-27',
  status: 'confirmed',
  client: { id: 'dddddddd-0000-4000-8000-000000000001', firstName: 'Rina', lastName: 'Andriamana' },
  staff: { id: 'staff-hasina', displayName: 'Hasina' },
  service: { id: MASSAGE.id, name: MASSAGE.name, durationMinutes: 60, price: MASSAGE.price },
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
  price: MASSAGE.price,
  createdAt: '2026-08-01T08:00:00.000Z',
};

const CIBLE_EDITION: DeskTarget = { kind: 'edit', appointment: CONFIRME };

/**
 * Le bouton d'encaissement en espèces, nommé dans la langue du rendu.
 *
 * Son libellé porte le montant (`action.settleCash` vaut « Encaisser {amount} en
 * espèces ») : c'est le segment qui **suit** le montant qui sert de repère, lu
 * dans le catalogue plutôt que recopié.
 */
function boutonEspeces(locale: Locale): RegExp {
  const [, suite = ''] = checkoutWords(locale).action.settleCash.split('{amount}');

  return new RegExp(suite.trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
}

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
  loadDeskServiceStaffAction.mockResolvedValue({
    ok: true,
    data: { staff: [{ id: 'staff-hasina', displayName: 'Hasina', isActive: true }] },
  });
  loadAppointmentNotificationsAction.mockResolvedValue({ ok: true, data: { notifications: [] } });
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
  createDeskClientAction.mockResolvedValue({ ok: true, data: null });
  // Les créneaux que le moteur rend vraiment (#611), plus celui du rendez-vous
  // ouvert : sans eux, le bouton « Enregistrer » du tiroir ne s'arme jamais.
  loadDeskAvailabilityAction.mockResolvedValue({
    ok: true,
    data: { slots: [deskSlot('2026-08-26T06:00:00.000Z'), ...deskSlots('2026-08-26')] },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fixerLangue('fr');
});

describe.each([...LOCALES])('l’établissement inconnu, en « %s »', (locale) => {
  it('le sélecteur de fiche cliente le nomme, plutôt que la recherche', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <ClientPicker
        onExpired={vi.fn()}
        onSelect={vi.fn()}
        selected={null}
        tenantSlug={SLUG}
      />,
    );
    await user.type(
      screen.getByLabelText(new RegExp(`^${planningWords(locale).client.label}`, 'u')),
      'Rina',
    );

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(planningWords(locale).actions.invalidSearch);
  });

  it('la bannière du planning le nomme, plutôt que la date', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    loadCalendarRangeAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadErrorCode={null}
        services={[MASSAGE]}
        staff={[]}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        view="jour"
      />,
    );
    await user.click(
      screen.getByRole('button', { name: planningWords(locale).toolbar.nextDay }),
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(phraseAttendue(locale));
    });
    expect(screen.getByRole('alert').textContent).not.toContain(
      planningWords(locale).actions.invalidDate,
    );
  });

  it('le tiroir de rendez-vous le nomme, plutôt que le report', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <AppointmentPanel
        onClose={vi.fn()}
        onExpired={vi.fn()}
        onReload={vi.fn()}
        services={[MASSAGE]}
        target={CIBLE_EDITION}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
      />,
    );

    // Le bouton ne s'arme qu'une fois les créneaux lus (#611) : cliquer avant ne
    // déclencherait rien, et le cas passerait sans rien avoir exercé.
    const enregistrer = screen.getByRole('button', { name: planningWords(locale).desk.save });

    await waitFor(() => {
      expect(enregistrer.hasAttribute('disabled')).toBe(false);
    });
    await user.click(enregistrer);

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    expect(alerte.textContent).not.toContain(planningWords(locale).actions.invalidReschedule);
  });

  it('le panneau d’encaissement le nomme, plutôt que la cible', async () => {
    fixerLangue(locale);
    const user = userEvent.setup();
    openCheckoutTicketAction.mockResolvedValue(refusEtablissement(locale));

    render(
      <CheckoutPanel
        appointment={CONFIRME}
        settlement={null}
        tenantSlug={SLUG}
        ticket={null}
        timeZone={TIMEZONE}
      />,
    );
    await user.click(screen.getByRole('button', { name: boutonEspeces(locale) }));

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(phraseAttendue(locale));
    // Elle nommait les deux — « Rendez-vous ou établissement inconnu » — et
    // tombait donc juste par coïncidence ; elle ne nomme plus que la cible.
    expect(alerte.textContent).not.toContain(checkoutWords(locale).failure.unknownTarget);
    expect(settleTicketAction).not.toHaveBeenCalled();
  });
});

/**
 * …et le refus de saisie de chaque geste n'a rien perdu.
 *
 * C'est l'autre moitié de la garde de #1367 et #1369, et elle doit rester vraie :
 * ce ticket ajoute un code, il ne redéfinit pas ce que `details === undefined`
 * veut dire. Un seul écran suffit à le prouver — la règle est la même pour les
 * quatre, et les trois autres l'éprouvent déjà chacun dans sa suite.
 */
describe('le refus de saisie du geste garde sa phrase', () => {
  it('nomme toujours la recherche quand c’est le terme qui est refusé', async () => {
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: errorMessage(ERROR_CODES.VALIDATION_ERROR, 'fr'),
    });

    render(
      <ClientPicker
        onExpired={vi.fn()}
        onSelect={vi.fn()}
        selected={null}
        tenantSlug={SLUG}
      />,
    );
    await user.type(screen.getByLabelText(/^Client/u), 'Rina');

    const alerte = await screen.findByRole('alert');

    expect(alerte.textContent).toContain(planningWords('fr').actions.invalidSearch);
    expect(alerte.textContent).not.toContain(phraseAttendue('fr'));
  });
});
