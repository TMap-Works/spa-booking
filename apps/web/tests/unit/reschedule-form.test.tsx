import type { AvailabilityResponse } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RescheduleForm } from '@/app/(account)/[tenantSlug]/compte/components/reschedule-form';

/**
 * L'écran de report.
 *
 * Trois choses s'y prouvent, et rien d'autre — ce que la page serveur envoie à
 * l'API (`excludeAppointmentId`) se prouve à l'intégration, côté API :
 *
 * - **#442** — la liste ainsi élargie contient les créneaux qui *chevauchent* le
 *   rendez-vous, son heure actuelle comprise, et cette heure-là ne doit pas
 *   pouvoir être choisie : l'écran proposerait sinon de déplacer un rendez-vous
 *   là où il est déjà ;
 * - **#622, #827** — le choix passe par le sélecteur du tunnel : un calendrier
 *   mensuel, puis la grille d'**une seule** journée. L'écran dépliait auparavant
 *   toutes les journées d'un coup, 4 960 px de haut à 360 px, le bouton de
 *   validation deux mille pixels sous le créneau qu'on venait de choisir. Le
 *   calendrier de #827 lui est arrivé par ce partage, sans une ligne de plus ici.
 * - **#654** — la mention du fuseau ne sort pas du rendu serveur, qui n'a aucun
 *   moyen de savoir où se trouve la visiteuse.
 */

const rescheduleOwnAppointmentAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

/**
 * Le fuseau du visiteur est piloté par le test, comme dans `slot-step.test.tsx`.
 *
 * `timeZoneMention` lit celui du navigateur : une assertion sur la mention
 * dépendrait sinon de la machine où la suite tourne — verte à Paris, rouge sur
 * un agent en UTC. Seule cette fonction est remplacée ; les mises en forme
 * d'heure restent les vraies, puisque les autres suites en dépendent.
 */
const MENTION = 'heure de UTC';

vi.mock('@/lib/format', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/format')>();

  return { ...actual, timeZoneMention: () => MENTION };
});

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  rescheduleOwnAppointmentAction: (...args: unknown[]) => rescheduleOwnAppointmentAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
}));

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const STAFF_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SERVICE_ID = 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59';

/** L'heure actuelle du rendez-vous — 14:00 UTC, un soin d'une heure. */
const CURRENT_STARTS_AT = '2026-09-01T14:00:00.000Z';

/**
 * La journée telle que l'API la rend **avec** l'exclusion : le créneau actuel,
 * et les deux quarts d'heure qui le chevauchent de part et d'autre.
 *
 * Sans l'exclusion, aucun des trois n'y figurerait — c'est tout le propos de
 * #442, et c'est ce qui rend ce jeu d'essai représentatif.
 */
const availability: AvailabilityResponse = {
  serviceId: SERVICE_ID,
  timezone: 'UTC',
  days: [
    {
      date: '2026-09-01',
      slots: [
        { startsAt: '2026-09-01T13:45:00.000Z', endsAt: '2026-09-01T14:45:00.000Z', staffId: STAFF_ID },
        { startsAt: CURRENT_STARTS_AT, endsAt: '2026-09-01T15:00:00.000Z', staffId: STAFF_ID },
        { startsAt: '2026-09-01T14:15:00.000Z', endsAt: '2026-09-01T15:15:00.000Z', staffId: STAFF_ID },
      ],
    },
  ],
};

/** Deux journées ouvertes et une complète — de quoi éprouver le calendrier. */
const troisJournees: AvailabilityResponse = {
  ...availability,
  days: [
    ...availability.days,
    { date: '2026-09-02', slots: [] },
    {
      date: '2026-09-03',
      slots: [
        { startsAt: '2026-09-03T09:30:00.000Z', endsAt: '2026-09-03T10:30:00.000Z', staffId: STAFF_ID },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  rescheduleOwnAppointmentAction.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

/**
 * Le gabarit d'adresse d'un changement de mois, tel que la page serveur le pose.
 */
const MONTH_HREF = `/salon-des-lilas/compte/rendez-vous/${APPOINTMENT_ID}/report?mois=`;

/**
 * La fenêtre de réservation que le serveur calcule — du 1er septembre au 1er
 * octobre 2026, soit les trente et un jours du contrat, bornes comprises.
 *
 * Elle couvre donc deux mois : c'est ce qui rend la navigation de mois
 * observable, et c'est aussi la borne au-delà de laquelle le chevron s'éteint.
 */
const BOUNDS = { first: '2026-09-01', last: '2026-10-01' } as const;

function form(
  days: AvailabilityResponse = availability,
  month = '2026-09',
): ReturnType<typeof RescheduleForm> {
  return (
    <RescheduleForm
      tenantSlug="salon-des-lilas"
      appointmentId={APPOINTMENT_ID}
      currentStartsAt={CURRENT_STARTS_AT}
      serviceName="Massage suédois"
      availability={days}
      timeZone="UTC"
      month={month}
      bounds={BOUNDS}
      monthHref={MONTH_HREF}
    />
  );
}

function renderForm(days: AvailabilityResponse = availability): ReturnType<typeof userEvent.setup> {
  render(form(days));

  return userEvent.setup();
}

/** Le calendrier, nommé par son mois — la grille d'heures l'est par sa journée. */
function calendrier(): HTMLElement {
  return screen.getByRole('grid', { name: /Journée/ });
}

describe('report — les créneaux qui chevauchent le rendez-vous déplacé', () => {
  it('propose les quarts d’heure qui chevauchent le rendez-vous', () => {
    renderForm();

    // Le geste que #442 rend atteignable : décaler d'un quart d'heure un soin
    // d'une heure, ce que le calendrier refusait tant qu'il comptait le
    // rendez-vous comme occupant.
    expect(screen.getByRole('button', { name: '13 h 45' }).getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByRole('button', { name: '14 h 15' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('montre l’heure actuelle, la nomme, et ne la laisse pas choisir', async () => {
    const user = renderForm();

    const current = screen.getByRole('button', { name: '14 h 00 (actuel)' });

    // Rendu — le retirer ferait un trou inexplicable dans la journée — mais
    // inerte : « déplacer au 1er septembre 14:00 » un rendez-vous déjà fixé au
    // 1er septembre 14:00 est une phrase qui se contredit.
    expect(current.getAttribute('aria-disabled')).toBe('true');
    // `aria-disabled` et non `disabled` : un bouton désactivé pour de bon ferait
    // un trou dans le parcours des flèches de la grille, et le créneau suivant
    // deviendrait inatteignable au clavier.
    expect(current).toHaveProperty('disabled', false);
    // Le mot est écrit sous l'heure : l'atténuation ne porte pas seule
    // l'information (WCAG 1.4.1).
    expect(current.textContent).toContain('actuel');

    await user.click(current);

    expect(screen.getByRole('button', { name: /Choisissez un créneau/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('n’envoie rien tant qu’aucun créneau n’est retenu', () => {
    renderForm();

    expect(screen.getByRole('button', { name: /Choisissez un créneau/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(rescheduleOwnAppointmentAction).not.toHaveBeenCalled();
  });

  it('reporte sur le créneau chevauchant retenu', async () => {
    rescheduleOwnAppointmentAction.mockResolvedValue({ ok: true });
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: '14 h 15' }));

    const confirm = screen.getByRole('button', { name: /Déplacer au/ });
    await user.click(confirm);

    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledTimes(1);
    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledWith(
      'salon-des-lilas',
      APPOINTMENT_ID,
      { startsAt: '2026-09-01T14:15:00.000Z' },
    );
  });
});

/**
 * #622, #827 — le report emploie le sélecteur du tunnel, calendrier compris, et
 * non une liste dépliée.
 */
describe('report — le sélecteur est celui du tunnel', () => {
  it('présente les créneaux en grille, une ligne par moment de la journée', () => {
    renderForm();

    // La grille composite de `keyboard-navigation.md`, et non une suite de
    // boutons : c'est elle qui donne au clavier son axe vertical.
    expect(screen.getByRole('grid', { name: /Créneaux/ })).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'Après-midi' })).toBeDefined();
  });

  it('ne déplie qu’une journée à la fois, sous un calendrier mensuel', () => {
    renderForm(troisJournees);

    // Septembre entier est à l'écran — les journées complètes comprises, faute
    // de quoi on croirait le salon fermé ce jour-là —, mais une seule grille
    // d'heures est dépliée.
    expect(within(calendrier()).getAllByRole('button')).toHaveLength(30);
    expect(screen.getByRole('button', { name: '13 h 45' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '09 h 30' })).toBeNull();
  });

  it('change de journée sans recharger la page', async () => {
    const user = renderForm(troisJournees);

    await user.click(
      within(calendrier()).getByRole('button', { name: /^jeudi 3 septembre 2026 — 1 créneau/ }),
    );

    expect(screen.getByRole('button', { name: '09 h 30' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '13 h 45' })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('n’ouvre pas une journée complète', async () => {
    const user = renderForm(troisJournees);

    const complet = within(calendrier()).getByRole('button', {
      name: /^mercredi 2 septembre 2026 — complet/,
    });

    expect(complet.getAttribute('aria-disabled')).toBe('true');

    await user.click(complet);

    // Rien à montrer dessous : la journée du 1er reste dépliée.
    expect(screen.getByRole('button', { name: '13 h 45' })).toBeDefined();
  });

  it('explique le mois vide sans emporter le calendrier', () => {
    // C'est ce qui change avec lui : la bande disparaissait, emportant la seule
    // commande qui menait ailleurs.
    renderForm({ ...availability, days: [{ date: '2026-09-01', slots: [] }] });

    expect(screen.getByText('Aucun créneau en septembre 2026')).toBeDefined();
    expect(screen.queryByRole('grid', { name: /Créneaux/ })).toBeNull();
    expect(calendrier()).toBeDefined();
  });
});

/**
 * #654 — la mention du fuseau attend le montage.
 *
 * `timeZoneMention` lit `Intl.DateTimeFormat().resolvedOptions().timeZone`,
 * c'est-à-dire le fuseau du **navigateur**. Au rendu serveur il n'y a pas de
 * navigateur : `Intl` y rend celui du conteneur, et la phrase partait donc du
 * serveur avec une mention qu'une visiteuse déjà dans le fuseau du salon ne
 * devait pas lire — puis disparaissait à l'hydratation, avec l'avertissement
 * React de divergence.
 *
 * La divergence elle-même n'est pas reproductible ici : sous jsdom, le rendu
 * serveur et le rendu client tournent dans le même processus, donc avec le même
 * `Intl`. Ce qui se prouve est sa **cause** — que le rendu serveur ne calcule
 * pas la mention du tout — et c'est exactement ce que le drapeau `mounted`
 * garantit.
 */
describe('report — la mention du fuseau attend l’hydratation (#654)', () => {
  it('ne sort pas la mention du rendu serveur', () => {
    const markup = renderToStaticMarkup(form());

    // La phrase, elle, est bien rendue par le serveur : sans cette assertion,
    // celle du dessous serait verte même si le composant ne rendait rien.
    expect(markup).toContain('actuellement le');
    expect(markup).not.toContain(MENTION);
    expect(markup).not.toContain('spa-appointment__timezone');
  });

  it('la complète une fois le composant monté', () => {
    renderForm();

    // `getByText` ne joint que les nœuds de texte **directs** : c'est bien le
    // paragraphe d'en-tête qui est retenu, pas la section qui le contient.
    expect(screen.getByText(/actuellement le/).textContent).toContain(`(${MENTION})`);
  });
});

/**
 * Le changement de mois (#738, #827).
 *
 * Il remplace « Voir plus de jours » : la fenêtre ne s'élargit plus, on tourne
 * la page du calendrier. Il passe par l'**adresse** pour la même raison que
 * l'élargissement le faisait — c'est le rendu serveur de la page qui lit le
 * calendrier, et un `useState` aurait ramené la visiteuse au mois courant au
 * premier F5.
 */
describe('report — le changement de mois passe par l’adresse', () => {
  it('ouvre le mois demandé, sans empiler d’entrée d’historique', async () => {
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: 'Mois suivant' }));

    // `replace` et non `push` : le mois qu'on vient de quitter n'est pas une
    // étape du parcours, et « Précédent » doit ramener à la liste des
    // rendez-vous.
    expect(replace).toHaveBeenCalledWith(`${MONTH_HREF}2026-10`);
  });

  it('éteint le chevron au bord de la fenêtre de réservation', () => {
    render(form(availability, '2026-10'));

    expect(screen.getByRole('button', { name: 'Mois suivant' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // Le calendrier, lui, reste rendu : c'est la sortie qui s'éteint, pas le choix.
    expect(calendrier()).toBeDefined();
  });

  it('offre la sortie jusque dans le mois vide, où elle sert le plus', async () => {
    // `states.md` étape 3 : *« Vide (aucune dispo sur toute la plage) : proposer
    // d'élargir la plage »*. La commande doit se trouver là où l'on vient de
    // lire qu'il n'y a rien, et pas seulement sur le chevron.
    const user = renderForm({ ...availability, days: [{ date: '2026-09-01', slots: [] }] });

    expect(screen.getByText('Aucun créneau en septembre 2026')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Voir le mois suivant' }));

    expect(replace).toHaveBeenCalledWith(`${MONTH_HREF}2026-10`);
  });

  it('n’offre rien à ouvrir dans le mois vide au bord de la fenêtre', () => {
    render(form({ ...availability, days: [{ date: '2026-10-01', slots: [] }] }, '2026-10'));

    expect(screen.getByText('Aucun créneau en octobre 2026')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Voir le mois suivant' })).toBeNull();
  });
});
