import type { Appointment, Service } from '@spa/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentPanel,
  type DeskTarget,
} from '@/app/(admin)/[tenantSlug]/admin/components/appointment-panel';
import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';
import {
  DESK_CANCEL_QUESTION,
  DESK_NO_SLOT_MESSAGE,
  DESK_ROUTE_MISSING_MESSAGE,
  DESK_SLOTS_UNREADABLE_MESSAGE,
} from '@/lib/admin/appointment-desk';

import { deskSlot, deskSlots } from './admin-desk-fixtures';

/**
 * Le tiroir de rendez-vous du comptoir (#50, les cinq critères).
 *
 * Les actions serveur sont doublées : ce qui est exercé ici est l'écran — ce
 * qu'un clic ouvre, ce qu'un refus affiche, ce qu'un bouton envoie —, pas le
 * transport. Le transport a sa recette.
 *
 * Le cas le plus important est le **créneau perdu** : c'est le seul où l'écran
 * doit se comporter autrement que devant une panne, et le seul que la
 * concurrence produit tous les jours dans un salon à plusieurs postes.
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
const push = vi.fn();

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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const TIMEZONE = 'Indian/Antananarivo';
const SLUG = 'maison-lotus';

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
};

const RINA = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  firstName: 'Rina',
  lastName: 'Andriamana',
  email: 'rina@example.com',
  phone: '+261320000000',
  isActive: true,
};

/** 09:00 – 10:00 au salon d'Antananarivo, le mercredi 26 août 2026. */
const CONFIRME: Appointment = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  reference: 'RDV-8F3K-27',
  status: 'confirmed',
  client: { id: RINA.id, firstName: RINA.firstName, lastName: RINA.lastName },
  staff: { id: 'staff-hasina', displayName: 'Hasina' },
  service: { id: MASSAGE.id, name: MASSAGE.name, durationMinutes: 60, price: MASSAGE.price },
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
  price: MASSAGE.price,
  createdAt: '2026-08-01T08:00:00.000Z',
};

function renderPanel(target: DeskTarget, services: readonly Service[] = [MASSAGE]) {
  const onClose = vi.fn();
  const onReload = vi.fn();
  const onExpired = vi.fn();

  render(
    <AppointmentPanel
      onClose={onClose}
      onExpired={onExpired}
      onReload={onReload}
      services={services}
      target={target}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
    />,
  );

  return { onClose, onReload, onExpired };
}

/**
 * Le bouton de validation, une fois que le tiroir a lu ses créneaux (#611).
 *
 * Il reste désactivé tant qu'aucun créneau réel n'est retenu : un clic posé
 * avant la lecture ne déclencherait rien, et le scénario passerait sans avoir
 * rien exercé.
 */
async function enregistrerArme(nom: string): Promise<HTMLElement> {
  const bouton = screen.getByRole('button', { name: nom });

  await waitFor(() => {
    expect(bouton.hasAttribute('disabled')).toBe(false);
  });

  return bouton;
}

const CREATION: DeskTarget = {
  kind: 'create',
  day: '2026-08-26',
  time: '14:30',
  staffId: 'staff-hasina',
};

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
  loadDeskServiceStaffAction.mockResolvedValue({
    ok: true,
    data: { staff: [{ id: 'staff-hasina', displayName: 'Hasina', isActive: true }] },
  });
  searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [RINA] } });
  loadAppointmentNotificationsAction.mockResolvedValue({ ok: true, data: { notifications: [] } });
  // Les créneaux que le moteur rend vraiment : au quart d'heure, alignés sur
  // 07:10, donc aucun à la minute 00 (#611). Celui de 09:00 au salon s'y ajoute
  // — c'est celui du rendez-vous de `CONFIRME`, que `excludeAppointmentId` rend
  // à nouveau libre dès qu'on ouvre le tiroir pour le déplacer (#442).
  loadDeskAvailabilityAction.mockResolvedValue({
    ok: true,
    data: { slots: [deskSlot('2026-08-26T06:00:00.000Z'), ...deskSlots('2026-08-26')] },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('premier critère — le tiroir s’ouvre sur le créneau cliqué', () => {
  it('amorce la date et l’heure du créneau libre choisi dans le planning', async () => {
    const user = userEvent.setup();

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadError={null}
        services={[MASSAGE]}
        // Ces deux cas partent d'une journée déjà occupée : la colonne vient du
        // rendez-vous posé, pas du répertoire (#507).
        staff={[]}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        view="jour"
      />,
    );

    // Le premier créneau libre de la colonne d'Hasina — 08 h 00, la grille
    // s'ouvrant par défaut à 8 h.
    await user.click(screen.getByRole('button', { name: /08 h 00.*poser un rendez-vous/ }));

    expect(screen.getByRole('heading', { name: 'Nouveau rendez-vous' })).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>(/^Date/).value).toBe('2026-08-26');
    // 08:10 et non 08:00 : la rangée cliquée est une intention, et le tiroir la
    // résout sur le premier créneau que le moteur propose réellement (#611).
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('08:10');
    });
  });

  it('ouvre en édition sur le rendez-vous cliqué', async () => {
    const user = userEvent.setup();

    render(
      <CalendarBoard
        date="2026-08-26"
        initialPeriods={{ 'jour:2026-08-26': [CONFIRME] }}
        loadError={null}
        services={[MASSAGE]}
        // Ces deux cas partent d'une journée déjà occupée : la colonne vient du
        // rendez-vous posé, pas du répertoire (#507).
        staff={[]}
        tenantSlug={SLUG}
        timeZone={TIMEZONE}
        view="jour"
      />,
    );

    // Le bloc lui-même, désigné par son heure : depuis #51 il a une poignée pour
    // sœur — « Déplacer Rina Andriamana » —, et le seul nom du client ne suffit
    // plus à les distinguer.
    await user.click(screen.getByRole('button', { name: /^09:00 – 10:00 Rina Andriamana/ }));

    expect(screen.getByRole('heading', { name: 'Rina Andriamana' })).toBeDefined();
    // 06:00 UTC = 09:00 au salon : c'est l'heure du salon qui doit s'afficher.
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('09:00');
    });
  });
});

describe('deuxième critère — la fiche cliente', () => {
  it('cherche, laisse choisir, et n’autorise la création qu’une fois choisie', async () => {
    const user = userEvent.setup();
    renderPanel(CREATION);

    const enregistrer = screen.getByRole('button', { name: 'Créer le rendez-vous' });
    expect(enregistrer.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));

    expect(searchDeskClientsAction).toHaveBeenCalledWith(SLUG, 'Rina');
    expect(
      screen.getByRole('button', { name: 'Créer le rendez-vous' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('propose de créer la fiche quand la recherche ne rend rien', async () => {
    const user = userEvent.setup();
    searchDeskClientsAction.mockResolvedValue({ ok: true, data: { clients: [] } });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Zafy');

    expect(await screen.findByText(/Aucune fiche pour/)).toBeDefined();
  });
});

describe('#796 — la référence citable au comptoir', () => {
  it('affiche « Réf. RDV-XXXX-NN » sur un rendez-vous posé', () => {
    // Le geste que le ticket sert : une cliente appelle en citant son code, et
    // la personne qui décroche doit le retrouver sous les yeux. Le libellé est
    // celui de l'écran de confirmation de la cliente — les deux surfaces
    // montrent le même code, et le nommer autrement aurait obligé à traduire au
    // téléphone.
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(screen.getByText('Réf.')).toBeDefined();
    expect(screen.getByText(CONFIRME.reference)).toBeDefined();
  });

  it('ne l’annonce pas à la création — le serveur ne l’a pas encore tirée', () => {
    // La référence est posée à l'insertion, par le serveur. Afficher une
    // amorce ici aurait montré un code qu'aucun rendez-vous ne porte.
    renderPanel(CREATION);

    expect(screen.queryByText('Réf.')).toBeNull();
  });
});

/**
 * La note jointe au rendez-vous, lisible au comptoir — #757.
 *
 * L'écart relevé par l'audit : le champ n'était rendu qu'à la création, et une
 * consigne d'allergie écrite par la cliente à la réservation — lisible dans son
 * espace client — n'apparaissait nulle part au back-office. Ce qui est éprouvé
 * ici est donc le **texte à l'écran** sur un rendez-vous posé, l'absence dite
 * plutôt que muette, et la frontière avec la note interne du salon.
 */
describe('#757 — la note du rendez-vous se lit dans le tiroir', () => {
  const ALLERGIE =
    'Allergie aux huiles essentielles d’agrumes, merci d’en tenir compte pour le gommage.';

  it('affiche le texte joint à la réservation sur un rendez-vous posé', () => {
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, clientNote: ALLERGIE } });

    expect(screen.getByRole('heading', { name: 'Note jointe au rendez-vous' })).toBeDefined();
    expect(screen.getByText(ALLERGIE)).toBeDefined();
  });

  it('dit l’absence de note au lieu de se taire', () => {
    // Se taire laisserait la question d'avant le ticket ouverte — la cliente n'a
    // rien écrit, ou l'écran ne le montre pas ? Sur une consigne d'allergie, le
    // doute coûte plus cher que la ligne.
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(screen.getByRole('heading', { name: 'Note jointe au rendez-vous' })).toBeDefined();
    expect(screen.getByText('Aucune note jointe à ce rendez-vous')).toBeDefined();
  });

  it('traite une note blanche comme une absence, et non comme un bloc vide', () => {
    // `longTextSchema` n'a pas de `.min(1)` : une remarque tapée en espaces
    // traverse le tunnel (l'étape de contact soumet `getValues()`, valeur brute)
    // et l'API la range à `''`. S'arrêter à `null` titrerait « Visible de la
    // cliente » au-dessus d'un paragraphe vide — le tiroir affirmerait une note
    // qu'il ne montre pas.
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, clientNote: '   ' } });

    expect(screen.getByText('Aucune note jointe à ce rendez-vous')).toBeDefined();
    expect(screen.queryByText(/Visible de la cliente/)).toBeNull();
  });

  it('dit que la note est visible de la cliente, et qu’elle n’est pas celle du salon', () => {
    // Les deux textes libres du produit ne se confondent sous aucun prétexte :
    // celui-ci est repris dans la confirmation, la note interne de la fiche ne
    // sort par aucune route. L'appartenance est écrite, jamais portée par une
    // teinte (WCAG 1.4.1).
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, clientNote: ALLERGIE } });

    expect(screen.getByText(/Visible de la cliente/)).toBeDefined();
    expect(screen.getByText(/ce n’est pas la note interne du salon/)).toBeDefined();
  });

  it('ne rend pas la note interne de séance du rendez-vous', () => {
    // `staffNote` voyage sur la même charge — la route est gardée `STAFF` — mais
    // l'afficher dans ce bloc aurait reproduit la confusion qu'il lève.
    renderPanel({
      kind: 'edit',
      appointment: { ...CONFIRME, clientNote: ALLERGIE, staffNote: 'Arrive souvent en retard.' },
    });

    expect(screen.queryByText('Arrive souvent en retard.')).toBeNull();
  });

  it('n’en rend aucun bloc à la création — le champ de saisie y tient déjà la note', () => {
    renderPanel(CREATION);

    expect(screen.queryByRole('heading', { name: 'Note jointe au rendez-vous' })).toBeNull();
    // Le champ, lui, reste : c'est par lui que le comptoir joint une remarque.
    expect(screen.getByLabelText(/Note jointe au rendez-vous/)).toBeDefined();
  });
});

describe('quatrième critère — le créneau perdu n’est pas une panne', () => {
  it('avertit, redemande le planning et conserve toutes les autres saisies', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Ce créneau vient d’être réservé.',
    });

    const { onReload, onClose } = renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    await user.click(screen.getByRole('button', { name: 'Créer le rendez-vous' }));

    // Le message ne nomme plus de cause : le 409 en couvre cinq et n'en
    // distingue aucune (#611).
    expect(await screen.findByText(/n’est pas — ou n’est plus — réservable/)).toBeDefined();
    expect(screen.queryByText(/vient d’être pris depuis un autre poste/)).toBeNull();
    // Le planning est relu — le créneau perdu doit se voir occupé…
    await waitFor(() => {
      expect(onReload).toHaveBeenCalledTimes(1);
    });
    // …mais le tiroir reste ouvert, et la saisie avec lui.
    expect(onClose).not.toHaveBeenCalled();
    // 14:40 : le premier créneau réel à partir de la rangée cliquée à 14:30.
    expect(screen.getByLabelText<HTMLSelectElement>(/Heure de début/).value).toBe('14:40');
    expect(screen.getByText(/Rina Andriamana/)).toBeDefined();
  });
});

describe('cinquième critère — marquer honoré et non présenté', () => {
  it('n’offre les deux gestes que depuis un rendez-vous confirmé', () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(screen.getByRole('button', { name: 'Marquer honoré' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Marquer non présenté' })).toBeDefined();
  });

  it('n’en offre aucun sur un rendez-vous déjà soldé', () => {
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, status: 'completed' } });

    expect(screen.queryByRole('button', { name: 'Marquer honoré' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marquer non présenté' })).toBeNull();
  });

  it('envoie le statut du contrat, puis referme et relit le planning', async () => {
    const user = userEvent.setup();
    markDeskAppointmentStatusAction.mockResolvedValue({
      ok: true,
      data: { ...CONFIRME, status: 'no_show' },
    });

    const { onReload, onClose } = renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Marquer non présenté' }));

    await waitFor(() => {
      expect(markDeskAppointmentStatusAction).toHaveBeenCalledWith(SLUG, CONFIRME.id, {
        status: 'no_show',
      });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * L'annulation par le salon — #754.
 *
 * Le tiroir invitait à « annuler et reposer le rendez-vous » sans offrir
 * d'annulation : la route existait, l'écran manquait, et le geste de comptoir le
 * plus courant — « j'appelle pour annuler » — n'avait nulle part où se faire.
 *
 * Ce qui est éprouvé ici est le geste complet : la question posée avant tout
 * envoi, le motif qui l'accompagne, et l'absence du bouton là où le cycle de vie
 * refuserait la transition.
 */
describe('#754 — le salon annule depuis le tiroir', () => {
  it('offre l’annulation sur un rendez-vous encore annulable, et sur lui seul', () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });
    expect(screen.getByRole('button', { name: 'Annuler le rendez-vous' })).toBeDefined();

    cleanup();

    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, status: 'completed' } });
    expect(screen.queryByRole('button', { name: 'Annuler le rendez-vous' })).toBeNull();
  });

  it('n’en offre aucune à la création — il n’y a rien à annuler', () => {
    renderPanel(CREATION);

    expect(screen.queryByRole('button', { name: 'Annuler le rendez-vous' })).toBeNull();
  });

  it('pose la question au premier clic au lieu d’annuler', async () => {
    const user = userEvent.setup();
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));

    expect(screen.getByText(DESK_CANCEL_QUESTION)).toBeDefined();
    expect(screen.getByLabelText(/Motif de l’annulation/)).toBeDefined();
    expect(cancelDeskAppointmentAction).not.toHaveBeenCalled();
    // Le pied ne porte plus que la réponse : « Enregistrer » déplacerait le
    // rendez-vous qu'on est en train d'annuler.
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Marquer honoré' })).toBeNull();
  });

  it('revient au pied ordinaire sans rien envoyer quand on garde le rendez-vous', async () => {
    const user = userEvent.setup();
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.click(screen.getByRole('button', { name: 'Garder ce rendez-vous' }));

    expect(screen.queryByText(DESK_CANCEL_QUESTION)).toBeNull();
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDefined();
    expect(cancelDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('envoie le motif élagué, referme et relit le planning', async () => {
    const user = userEvent.setup();
    cancelDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: { ...CONFIRME, status: 'cancelled' },
    });

    const { onReload, onClose } = renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.type(screen.getByLabelText(/Motif de l’annulation/), '  Cliente souffrante  ');
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));

    await waitFor(() => {
      expect(cancelDeskAppointmentAction).toHaveBeenCalledWith(SLUG, CONFIRME.id, {
        reason: 'Cliente souffrante',
      });
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('n’envoie aucun motif quand le champ est resté vide', async () => {
    const user = userEvent.setup();
    cancelDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: { ...CONFIRME, status: 'cancelled' },
    });

    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));

    // `{}` et non `{ reason: '' }` : un motif présent et vide ferait compter
    // comme motivée une annulation qui ne l'est pas.
    await waitFor(() => {
      expect(cancelDeskAppointmentAction).toHaveBeenCalledWith(SLUG, CONFIRME.id, {});
    });
  });

  it('laisse la question posée quand l’annulation échoue, motif compris', async () => {
    const user = userEvent.setup();
    cancelDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      message: 'Rendez-vous déjà annulé.',
    });

    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.type(screen.getByLabelText(/Motif de l’annulation/), 'Fermeture exceptionnelle');
    await user.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));

    expect(await screen.findByText('Rendez-vous déjà annulé.')).toBeDefined();
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Motif de l’annulation/).value).toBe(
      'Fermeture exceptionnelle',
    );
  });

  it('ne renvoie plus le champ Prestation à un geste que le tiroir n’offre pas', () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    // L'invite relevée par l'audit : elle ordonnait « Annulez et reposez le
    // rendez-vous » depuis un tiroir sans annulation.
    expect(screen.queryByText(/Annulez et reposez le rendez-vous/)).toBeNull();
    expect(screen.getByText(/annulez ce rendez-vous au pied du tiroir/)).toBeDefined();
  });

  it('retombe au constat seul quand l’annulation n’est plus possible', () => {
    renderPanel({ kind: 'edit', appointment: { ...CONFIRME, status: 'completed' } });

    expect(screen.queryByText(/annulez ce rendez-vous au pied du tiroir/)).toBeNull();
    expect(screen.getByText(/son prix et sa durée sont figés à la réservation\.$/)).toBeDefined();
  });
});

describe('la dégradation, tant que l’API ne sert pas l’écriture', () => {
  it('nomme la route absente au lieu de recracher le cadre HTTP', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'HTTP_404',
      message: 'Cannot POST /api/v1/appointments/…/reschedule',
    });

    renderPanel({ kind: 'edit', appointment: CONFIRME });
    // Le bouton ne s'arme qu'une fois les créneaux lus (#611) : cliquer avant
    // ne déclencherait rien, et le test passerait sans rien prouver.
    await user.click(await enregistrerArme('Enregistrer'));

    expect(await screen.findByText(DESK_ROUTE_MISSING_MESSAGE)).toBeDefined();
  });

  it('dit que le catalogue est vide plutôt que d’offrir un sélecteur muet', () => {
    renderPanel(CREATION, []);

    expect(screen.getByText('Le catalogue est vide')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Créer le rendez-vous' })).toBeNull();
  });
});

/**
 * L'écran ne propose plus que ce que le moteur peut honorer (#611).
 *
 * C'était le défaut le plus coûteux de cet écran : la grille du planning trace
 * des heures rondes, le moteur n'en rend aucune, et chaque case « libre » menait
 * donc à un `409 SLOT_NO_LONGER_AVAILABLE` — six refus d'affilée relevés au
 * comptoir sur une journée qui ne portait pas un seul rendez-vous.
 */
describe('#611 — le tiroir n’offre que des créneaux réservables', () => {
  it('n’offre que les créneaux de la journée interrogée — pas une seule heure ronde', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { slots: deskSlots('2026-08-26') },
    });
    renderPanel(CREATION);

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    // La journée, la prestation et le praticien retenus — les trois font la liste.
    expect(loadDeskAvailabilityAction).toHaveBeenCalledWith(SLUG, {
      serviceId: MASSAGE.id,
      day: '2026-08-26',
      staffId: 'staff-hasina',
    });

    const proposees = [...heures.options].map((option) => option.value);
    expect(proposees).toContain('14:40');
    // Le cœur du ticket : la grille de 30 minutes du planning n'a rien à voir
    // avec le pas de 15 minutes du moteur, aligné sur 07:10.
    expect(proposees.filter((heure) => heure.endsWith(':00'))).toEqual([]);
  });

  it('envoie l’instant exact rendu par le moteur, et non une reconversion de l’heure civile', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({ ok: true, data: CONFIRME });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    await user.click(await enregistrerArme('Créer le rendez-vous'));

    await waitFor(() => {
      expect(createDeskAppointmentAction).toHaveBeenCalledWith(
        SLUG,
        // 14:40 au salon d'Antananarivo, qui est à UTC+3 — c'est bien la chaîne
        // que le moteur a rendue qui repart, à l'identique.
        expect.objectContaining({ startsAt: '2026-08-26T11:40:00.000Z' }),
      );
    });
  });

  it('dit la journée complète et refuse d’envoyer plutôt que de provoquer un 409', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({ ok: true, data: { slots: [] } });
    renderPanel(CREATION);

    expect(await screen.findByText(DESK_NO_SLOT_MESSAGE)).toBeDefined();
    // Le bouton reste hors d'atteinte : ce qui manque est un créneau, et aucune
    // saisie ne peut y remédier.
    expect(
      screen.getByRole('button', { name: 'Créer le rendez-vous' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(createDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('retombe sur la saisie libre quand la disponibilité n’a pas pu être lue', async () => {
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Une erreur inattendue est survenue.',
    });
    renderPanel(CREATION);

    expect(await screen.findByText(DESK_SLOTS_UNREADABLE_MESSAGE)).toBeDefined();

    // Un champ de saisie, et non un sélecteur vide : une disponibilité illisible
    // ne ferme pas le comptoir, et c'est l'API qui juge le créneau.
    const heure = screen.getByLabelText<HTMLInputElement>(/Heure de début/);
    expect(heure.tagName).toBe('INPUT');
    expect(heure.value).toBe('14:30');
  });

  it('relit les créneaux quand l’API refuse celui qu’on vient d’envoyer', async () => {
    const user = userEvent.setup();
    createDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Ce créneau vient d’être réservé.',
    });
    renderPanel(CREATION);

    await user.type(screen.getByLabelText(/^Client/), 'Rina');
    await user.click(await screen.findByRole('button', { name: /Rina Andriamana/ }));
    const appelsAvant = loadDeskAvailabilityAction.mock.calls.length;
    await user.click(await enregistrerArme('Créer le rendez-vous'));

    // Le créneau refusé n'a plus à figurer dans la liste : sans cette relecture,
    // l'opératrice renvoie la même heure et reçoit le même refus (#611).
    await waitFor(() => {
      expect(loadDeskAvailabilityAction.mock.calls.length).toBeGreaterThan(appelsAvant);
    });
  });

  it('exclut le rendez-vous déplacé de sa propre disponibilité', async () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    await waitFor(() => {
      expect(loadDeskAvailabilityAction).toHaveBeenCalledWith(
        SLUG,
        expect.objectContaining({ excludeAppointmentId: CONFIRME.id }),
      );
    });
  });

  it('garde l’heure d’un rendez-vous posé que le moteur n’offre plus', async () => {
    // Le cas courant : les horaires du praticien ont changé depuis la
    // réservation, et 09:00 n'est plus un créneau. Le tiroir ne doit pas pour
    // autant afficher une **autre** heure que celle du rendez-vous — le
    // récapitulatif suivrait, et un « Enregistrer » cliqué de confiance
    // déplacerait un rendez-vous que personne n'a demandé à déplacer.
    loadDeskAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { slots: deskSlots('2026-08-26') },
    });
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    expect(heures.value).toBe('09:00');
    // Affichée, mais pas réservable : c'est bien un créneau de la liste qu'il
    // faut choisir pour envoyer le report.
    expect(screen.getByRole('button', { name: 'Enregistrer' }).hasAttribute('disabled')).toBe(true);
  });

  it('dit encore l’heure du rendez-vous sur une journée sans créneau', async () => {
    // La journée d'un rendez-vous **passé** n'offre rien : le moteur filtre le
    // passé et le préavis. Ouvrir le tiroir pour marquer « honoré » ne doit pas
    // effacer de l'écran l'heure à laquelle ce rendez-vous a eu lieu.
    loadDeskAvailabilityAction.mockResolvedValue({ ok: true, data: { slots: [] } });
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    expect(await screen.findByText(DESK_NO_SLOT_MESSAGE)).toBeDefined();

    const heures = screen.getByLabelText<HTMLSelectElement>(/Heure de début/);
    expect(heures.value).toBe('09:00');
  });

  it('n’interroge pas la disponibilité sur une date en cours de frappe', async () => {
    renderPanel({ kind: 'edit', appointment: CONFIRME });

    const heures = await screen.findByLabelText<HTMLSelectElement>(/Heure de début/);
    await waitFor(() => {
      expect(heures.options.length).toBeGreaterThan(1);
    });

    const appelsAvant = loadDeskAvailabilityAction.mock.calls.length;
    // Un `<input type="date">` rend une valeur vide tant que ses trois segments
    // ne sont pas tous saisis. L'interroger là-dessus ne rapporterait qu'un
    // refus de validation, que l'écran traduirait en « disponibilité illisible »
    // — donc en retour à la saisie libre, c'est-à-dire au 409 qu'on supprime.
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(/^Date/), { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/Lecture des créneaux disponibles/)).toBeDefined();
    });
    expect(loadDeskAvailabilityAction.mock.calls.length).toBe(appelsAvant);
    expect(screen.queryByText(DESK_SLOTS_UNREADABLE_MESSAGE)).toBeNull();
  });
});
