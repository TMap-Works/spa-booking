/**
 * Le conflit de créneau, vu du tunnel entier (#46).
 *
 * Ce cas ne s'éprouve pas étape par étape : ce qu'il faut prouver, c'est qu'un
 * 409 arrivé au récapitulatif ramène au calendrier **avec des créneaux frais**
 * et **sans rien perdre** de ce qui a été saisi trois écrans plus tôt. Il faut
 * donc le tunnel au complet, monté avec son brouillon.
 *
 * Les actions serveur sont remplacées : sous test, ce sont des modules Next qui
 * n'existent pas hors du serveur. Ce qu'on éprouve ici est l'enchaînement des
 * étapes, pas le transport.
 */

import type {
  AvailabilityResponse,
  BookedAppointment,
  CalendarDate,
  UtcInstant,
} from '@spa/shared';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingTunnel } from '@/app/(booking)/[tenantSlug]/reservation/booking-tunnel';

import { service, tenant } from './fixtures';

const loadAvailabilityAction = vi.fn();
const bookAppointmentAction = vi.fn();
const cancelAppointmentAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
  bookAppointmentAction: (...args: unknown[]) => bookAppointmentAction(...args),
  cancelAppointmentAction: (...args: unknown[]) => cancelAppointmentAction(...args),
}));

/** Le salon est à Antananarivo (UTC+3) : 06:00 UTC s'affiche « 09:00 ». */
const MATIN = '2026-09-01T06:00:00.000Z' as UtcInstant;
const APRES_MIDI = '2026-09-01T11:00:00.000Z' as UtcInstant;
const JOURNEE = '2026-09-01' as CalendarDate;

/**
 * Le message que l'API accompagne au 409.
 *
 * Volontairement technique et anglophone : s'il apparaissait à l'écran, c'est
 * que le tunnel relaie la prose du serveur au lieu d'écrire la sienne.
 */
const MESSAGE_API = 'Slot lock 7f3a is already held by another transaction.';

function availability(slots: readonly UtcInstant[]): AvailabilityResponse {
  return {
    serviceId: service.id,
    timezone: tenant.timezone,
    days: [
      {
        date: JOURNEE,
        slots: slots.map((startsAt) => ({
          startsAt,
          endsAt: startsAt,
          staffId: service.staff[0]?.id ?? '',
        })),
      },
    ],
  };
}

/** Le rendez-vous obtenu à la seconde tentative, celle qui aboutit. */
function rendezVous(): BookedAppointment {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '',
    clientId: '66666666-6666-4666-8666-666666666666',
    startsAt: APRES_MIDI,
    endsAt: APRES_MIDI,
    price: service.price,
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };
}

const ADRESSE = `/${tenant.slug}/reservation`;

beforeEach(() => {
  // Le brouillon vit dans `sessionStorage` : sans ce nettoyage, un test
  // reprendrait le tunnel là où le précédent l'a laissé.
  window.sessionStorage.clear();
  // Depuis #733 la progression vit aussi dans l'adresse : elle se remet à celle
  // d'un visiteur qui arrive, sans quoi un test rouvrirait l'étape du précédent.
  window.history.replaceState(null, '', ADRESSE);
  loadAvailabilityAction.mockResolvedValue({ ok: true, data: availability([MATIN, APRES_MIDI]) });
});

/** Ce que l'adresse dit de la progression, à cet instant. */
function query(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/**
 * Le geste retour du navigateur.
 *
 * `history.back()` rend la main **avant** que la navigation n'ait lieu :
 * l'événement `popstate` est distribué plus tard. On attend donc l'événement
 * lui-même, et non un délai — un `setTimeout` suffisait tant que le test
 * passait, et laissait sinon la navigation s'exécuter au milieu du test
 * suivant, sur un tunnel fraîchement monté qui se retrouvait à l'étape d'un
 * autre scénario.
 */
async function retourNavigateur(): Promise<void> {
  await act(async () => {
    const arrivee = new Promise<void>((resolve) => {
      window.addEventListener(
        'popstate',
        () => {
          resolve();
        },
        { once: true },
      );
    });

    window.history.back();
    await arrivee;
    // L'écouteur du tunnel est enregistré avant celui-ci : son `setState` est
    // posé, il reste à laisser React le rendre.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

afterEach(() => {
  cleanup();
  loadAvailabilityAction.mockReset();
  bookAppointmentAction.mockReset();
  cancelAppointmentAction.mockReset();
});

function renderTunnel() {
  render(<BookingTunnel tenant={tenant} services={[service]} />);

  return userEvent.setup();
}

/**
 * La carte de prestation de l'étape 1 — un bouton radio depuis #741.
 *
 * Le nom accessible de la carte est **tout** ce qu'elle porte : le nom de la
 * prestation, puis sa durée et son prix formatés en `fr-FR`. Seul le premier est
 * cherché ici — l'espace insécable d'un montant et la forme d'une durée varient
 * d'une version d'ICU à l'autre, et un libellé complet ferait échouer la suite
 * sur le poste ou sur la CI selon le moteur.
 */
const CARTE = new RegExp(`^${service.name}`);

/** Le geste de l'étape 1 : cocher la carte. Le CTA reste à l'appelant. */
async function choisirLaPrestation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('radio', { name: CARTE }));
}

/** Prestation → créneau → coordonnées → récapitulatif, prêt à confirmer. */
async function allerJusquAuRecapitulatif(
  user: ReturnType<typeof userEvent.setup>,
  creneau: string,
): Promise<void> {
  await choisirLaPrestation(user);
  await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

  await user.click(await screen.findByRole('button', { name: creneau }));

  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  // Le consentement est bloquant depuis #734 : sans lui, l'étape ne rend pas la
  // main au récapitulatif. Ce qu'il refuse est éprouvé par
  // `booking-consent.test.tsx` ; ici il n'est qu'un préalable du parcours.
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

  await screen.findByRole('button', { name: /Confirmer la réservation/ });
}

describe('un créneau pris pendant la saisie', () => {
  it('explique la situation avec l’horaire perdu, sans reprendre le message de l’API', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const avis = await screen.findByRole('alert');

    // L'horaire perdu est nommé, dans le fuseau du salon : entre le clic et
    // l'écran, la cliente ne sait plus toujours lequel elle visait.
    expect(avis.textContent).toContain('1 septembre 2026');
    expect(avis.textContent).toContain('09:00');
    expect(avis.textContent).toContain('conservé');
    // Le contrat, c'est le code ; le message du serveur n'atteint pas l'écran.
    expect(avis.textContent).not.toContain(MESSAGE_API);
    expect(avis.textContent).not.toContain('7f3a');
  });

  it('recharge les créneaux plutôt que de réafficher la liste périmée', async () => {
    // Le second chargement ne rend plus 09:00 : c'est le créneau que quelqu'un
    // d'autre vient d'obtenir. S'il restait proposé, la cliente se heurterait au
    // même 409 en boucle.
    loadAvailabilityAction
      .mockResolvedValueOnce({ ok: true, data: availability([MATIN, APRES_MIDI]) })
      .mockResolvedValue({ ok: true, data: availability([APRES_MIDI]) });
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByRole('button', { name: '14 h 00' })).toBeDefined();
    expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '09 h 00' })).toBeNull();
  });

  it('conserve la prestation et les coordonnées déjà saisies', async () => {
    loadAvailabilityAction
      .mockResolvedValueOnce({ ok: true, data: availability([MATIN, APRES_MIDI]) })
      .mockResolvedValue({ ok: true, data: availability([APRES_MIDI]) });
    bookAppointmentAction.mockResolvedValueOnce({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    // Un seul geste sépare la cliente de sa réservation : reprendre un horaire.
    await user.click(await screen.findByRole('button', { name: '14 h 00' }));

    expect(screen.getByLabelText(/Prénom/)).toHaveProperty('value', 'Camille');
    expect(screen.getByLabelText(/^Nom/)).toHaveProperty('value', 'Rakoto');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty(
      'value',
      'camille@example.test',
    );

    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));
    // La prestation aussi a survécu : le récapitulatif la nomme sans repasser
    // par la première étape.
    expect(await screen.findByText(service.name)).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(bookAppointmentAction).toHaveBeenCalledTimes(2);
    expect(bookAppointmentAction.mock.calls[1]?.[1]).toMatchObject({
      serviceId: service.id,
      startsAt: APRES_MIDI,
      client: { firstName: 'Camille', lastName: 'Rakoto', email: 'camille@example.test' },
    });
  });

  it('rend le focus à l’explication, que le bouton confirmé vient d’emporter', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const avis = await screen.findByRole('alert');

    // Sans ce déplacement, le focus retomberait sur `<body>` : la navigation au
    // clavier repartirait du haut du document au pire moment.
    //
    // L'assertion porte sur l'enveloppe elle-même, pas sur un `contains` :
    // `document.body` contient l'avis, et un test écrit ainsi passerait
    // précisément dans le cas qu'il prétend écarter.
    const enveloppe = avis.closest('[tabindex="-1"]');

    expect(enveloppe).not.toBeNull();
    expect(document.activeElement).toBe(enveloppe);
  });
});

describe('le tunnel trie sur le code d’erreur, jamais sur le message', () => {
  it('ne renvoie pas au calendrier une panne dont le message parle de créneau', async () => {
    // Le message est exactement celui d'un conflit ; le code, non. Trier sur la
    // prose ferait traiter une panne comme un créneau perdu — et perdrait le
    // créneau que la cliente tient encore.
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'Ce créneau vient d’être réservé.',
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByText('La réservation n’a pas abouti')).toBeDefined();
    // Toujours au récapitulatif : ni retour au calendrier, ni rechargement.
    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('button', { name: '14 h 00' })).toBeNull();
    expect(loadAvailabilityAction).toHaveBeenCalledTimes(1);
  });
});

describe('la progression est portée par l’adresse (#733)', () => {
  it('nomme l’étape et les choix, à chaque étape', async () => {
    const user = renderTunnel();

    await waitFor(() => {
      expect(query().get('etape')).toBe('prestation');
    });

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    await waitFor(() => {
      expect(query().get('etape')).toBe('creneau');
    });
    expect(query().get('prestation')).toBe(service.id);

    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });
    expect(query().get('creneau')).toBe(MATIN);
    // Le doublon tient toujours : l'adresse porte la progression, le stockage
    // porte tout le reste (docs/design/appointments/README.md).
    expect(window.sessionStorage.getItem(`spa.booking.${tenant.slug}`)).toContain('coordonnees');
  });

  it('ne met pas les coordonnées dans une adresse qu’on partage', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '09 h 00' }));
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');

    expect(window.location.search).not.toContain('camille');
    expect(window.location.search).not.toContain('%40');
  });

  it('revient d’une étape au geste retour, sans rendre le formulaire à remplir', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '09 h 00' }));
    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    // Le formulaire reporte sa saisie au brouillon quand le champ rend la main
    // (`ContactStep`) : sans ce passage au champ suivant, rien n'aurait encore
    // été saisi du point de vue du tunnel.
    await user.tab();

    await retourNavigateur();

    // Une étape en arrière — et non la vitrine, où le tunnel déposait le
    // visiteur avant que l'adresse ne porte l'étape.
    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(query().get('etape')).toBe('creneau');

    // Et le formulaire retrouvé intact : il n'a jamais quitté le brouillon.
    await user.click(screen.getByRole('button', { name: '09 h 00' }));
    expect(await screen.findByLabelText(/Prénom/)).toHaveProperty('value', 'Camille');
  });

  /**
   * L'entrée qu'on quitte décrit l'étape telle qu'on l'a **laissée** (#947).
   *
   * Elle avait été écrite en y arrivant, avant que le choix qu'on y fait
   * n'existe : l'entrée de l'étape « Créneau » ne portait donc pas le créneau,
   * qui n'est retenu qu'au clic qui la quitte. Le geste retour rendait une étape
   * amnésique, et la barre de résumé perdait sa date — l'inverse de ce que
   * `BM-TUNNEL-08` décrit : « la cliente retrouve la même étape avec les mêmes
   * choix ».
   */
  it('rend l’étape « Créneau » avec le créneau qu’on y avait retenu', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });

    await retourNavigateur();

    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(query().get('etape')).toBe('creneau');
    expect(query().get('creneau')).toBe(MATIN);

    // Ce que la cliente voit du choix retrouvé : la barre de résumé le redit,
    // là où elle n'affichait plus que la prestation et son prix.
    const barre = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(barre.textContent).toContain('1 septembre 2026');
    expect(barre.textContent).toContain('09:00');
  });

  it('n’empile pas une entrée par praticien essayé', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await screen.findByRole('button', { name: '09 h 00' });

    const avant = window.history.length;

    await user.selectOptions(
      screen.getByLabelText(/Praticien/),
      service.staff[0]?.id ?? '',
    );

    await waitFor(() => {
      expect(query().get('praticien')).toBe(service.staff[0]?.id);
    });
    // L'étape n'a pas changé : l'adresse se corrige sur place, sinon le bouton
    // « retour » deviendrait inutilisable.
    expect(window.history.length).toBe(avant);
    expect(query().get('etape')).toBe('creneau');
  });

  it('ouvre l’étape que décrit un lien partagé', async () => {
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=coordonnees&prestation=${service.id}&creneau=${MATIN}`,
    );

    renderTunnel();

    // L'onglet n'a aucun brouillon : tout ce que le tunnel sait vient du lien.
    expect(await screen.findByLabelText(/Prénom/)).toHaveProperty('value', '');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty('value', '');
  });

  it('ramène à l’étape utile ce qu’un lien ne suffit pas à ouvrir', async () => {
    // Le récapitulatif mis en favori, rouvert dans un onglet neuf : il ne reste
    // personne à qui écrire, et « Confirmer » partirait en 400.
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=recapitulatif&prestation=${service.id}&creneau=${MATIN}`,
    );

    renderTunnel();

    expect(await screen.findByLabelText(/Prénom/)).toBeDefined();
    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });
  });

  it('n’empile pas une entrée en arrivant sur une adresse qu’elle doit corriger', async () => {
    // La prestation du lien ne figure plus au catalogue : l'écran revient à la
    // première étape et l'adresse avec lui. Cette correction-là n'est pas un
    // changement d'étape — la pousser volerait au visiteur son premier geste
    // retour, qui ne ferait alors rien de visible.
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=coordonnees&prestation=11111111-1111-4111-8111-111111111111&creneau=${MATIN}`,
    );

    const pousse = vi.spyOn(window.history, 'pushState');

    try {
      renderTunnel();

      expect(await screen.findByRole('radio', { name: CARTE })).toBeDefined();
      await waitFor(() => {
        expect(query().get('etape')).toBe('prestation');
      });
      expect(pousse).not.toHaveBeenCalled();
    } finally {
      pousse.mockRestore();
    }
  });

  it('n’empile pas une entrée sur la correction qui suit un retour arrière', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));
    await screen.findByText('Votre rendez-vous est enregistré');
    await user.click(screen.getByRole('button', { name: 'Réserver à nouveau' }));

    await waitFor(() => {
      expect(query().get('etape')).toBe('prestation');
    });

    const pousse = vi.spyOn(window.history, 'pushState');

    try {
      // L'entrée retrouvée décrit une confirmation dont le rendez-vous est
      // reparti avec le brouillon : `reachableStep` la corrige. Empiler une
      // entrée pour cette correction ferait grossir la pile à l'appui même où
      // le visiteur demande qu'elle diminue.
      await retourNavigateur();

      expect(pousse).not.toHaveBeenCalled();
    } finally {
      pousse.mockRestore();
    }
  });

  it('ne laisse pas revenir confirmer un rendez-vous déjà pris', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    const avant = window.history.length;

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));
    await screen.findByText('Votre rendez-vous est enregistré');

    // L'écran terminal prend la place du récapitulatif qui l'a produit plutôt
    // que d'ajouter un arrêt : il n'y a rien à revenir confirmer deux fois.
    expect(window.history.length).toBe(avant);
    expect(query().get('etape')).toBe('confirmation');

    await retourNavigateur();

    expect(screen.getByText('Votre rendez-vous est enregistré')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirmer la réservation/ })).toBeNull();
  });
});

describe('l’écran terminal rend la main au tunnel (#732)', () => {
  it('repart d’un brouillon vierge, et non de la réservation précédente', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    await screen.findByText('Votre rendez-vous est enregistré');
    await user.click(screen.getByRole('button', { name: 'Réserver à nouveau' }));

    // Première étape, catalogue en main : le tunnel n'est plus bloqué sur la
    // confirmation précédente.
    expect(await screen.findByRole('radio', { name: CARTE })).toHaveProperty('checked', false);
    expect(screen.queryByText('Votre rendez-vous est enregistré')).toBeNull();

    // Les coordonnées aussi sont reparties : une nouvelle réservation n'est pas
    // forcément pour la même personne.
    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '14 h 00' }));

    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty('value', '');
  });

  it('cesse d’annoncer « enregistré » quand il ne fait que relire le brouillon', async () => {
    // Le tunnel rouvert plus tard dans la même session : c'est exactement la
    // situation où le rendez-vous a pu être reporté ou annulé ailleurs, sans que
    // le brouillon en sache rien.
    window.sessionStorage.setItem(
      `spa.booking.${tenant.slug}`,
      JSON.stringify({
        step: 'confirmation',
        serviceId: service.id,
        staffId: null,
        startsAt: APRES_MIDI,
        contact: {
          firstName: 'Camille',
          lastName: 'Rakoto',
          email: 'camille@example.test',
          phone: '',
          clientNote: '',
        },
        appointment: rendezVous(),
      }),
    );

    renderTunnel();

    expect(await screen.findByText('Votre dernière réservation dans cet onglet')).toBeDefined();
    expect(screen.queryByText('Votre rendez-vous est enregistré')).toBeNull();
    // La sortie reste offerte, elle : c'est par là qu'on vérifie l'état réel.
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' })).toBeDefined();
  });
});

/**
 * La barre de résumé, vue du tunnel (#735).
 *
 * Ce que `booking-summary-bar.test.tsx` ne peut pas dire : **à quelles étapes**
 * elle apparaît. C'est le tunnel qui en décide, et c'est là qu'était l'écart
 * relevé par l'audit — le prix disparaissait au passage de « Prestation » à
 * « Créneau », et plus rien ne le rappelait jusqu'au récapitulatif.
 */
describe('la barre de résumé collante (#735)', () => {
  /** La barre, ou `null` si l'étape courante ne la rend pas. */
  function barre(): HTMLElement | null {
    return screen.queryByRole('complementary', { name: 'Votre réservation' });
  }

  it('rappelle le prix et la durée dès l’étape « Créneau », où l’écran ne les portait plus', async () => {
    const user = renderTunnel();

    // Étape « Prestation » : le choix n'est pas encore retenu, et le sélecteur
    // porte déjà durée et prix sur chacune de ses options.
    await waitFor(() => {
      expect(query().get('etape')).toBe('prestation');
    });
    expect(barre()).toBeNull();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    const creneau = barre();

    expect(creneau).not.toBeNull();
    expect(creneau?.textContent).toContain('35,00');
    expect(creneau?.textContent).toContain('1 h');
    // Aucun créneau retenu à cet instant : la date n'est pas encore un fait.
    expect(creneau?.textContent).not.toContain('septembre');
  });

  it('rappelle l’horaire retenu à l’étape « Coordonnées », où rien ne le redisait', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    const coordonnees = barre();

    expect(coordonnees?.textContent).toContain(service.name);
    expect(coordonnees?.textContent).toContain('1 septembre 2026');
    expect(coordonnees?.textContent).toContain('09:00');
    expect(coordonnees?.textContent).toContain('35,00');
  });

  it('s’efface au récapitulatif, qui porte les mêmes faits en entier', async () => {
    const user = renderTunnel();

    await allerJusquAuRecapitulatif(user, '09 h 00');

    expect(barre()).toBeNull();
    // Et ce n'est pas une perte : le récapitulatif les redit tous, durée
    // comprise depuis ce même ticket.
    expect(screen.getByText('Durée')).toBeDefined();
  });
});

/**
 * L'indicateur d'étape, vu du tunnel (#740).
 *
 * `docs/design/appointments/wireframes.md` — « Structure commune à toutes les
 * étapes » — lui demande deux choses : *« étape courante mise en avant »*, et
 * *« permet de revenir à une étape déjà franchie (les étapes futures ne sont pas
 * cliquables) »*. L'audit de conception n'en a trouvé aucune des deux : les cinq
 * libellés sortaient à l'identique, et aucun ne se cliquait.
 *
 * Ce qui s'éprouve ici est donc l'**état** et la **navigation** — ce que le
 * composant décide. La peinture qui s'y accroche est tenue ailleurs, par
 * `tests/booking-step-indicator.test.mjs` : aucune feuille de style n'est
 * chargée sous jsdom, et un `aria-current` de nouveau nu passerait ces
 * assertions-ci sans broncher — c'est exactement la panne que l'audit a relevée.
 */
describe('l’indicateur d’étape (#740)', () => {
  /** Les cinq rangées du fil, dans l'ordre du parcours. */
  function fil(): HTMLElement[] {
    return within(
      screen.getByRole('list', { name: 'Étapes de la réservation' }),
    ).getAllByRole('listitem');
  }

  /** Le libellé d'une rangée, débarrassé de ce que seul le lecteur d'écran entend. */
  function libelle(element: Element): string {
    return (element.textContent ?? '').replace('Revenir à l’étape ', '').trim();
  }

  /** Les étapes que le fil annonce comme courantes — une, normalement. */
  function courantes(): string[] {
    return fil()
      .filter((etape) => etape.getAttribute('aria-current') === 'step')
      .map(libelle);
  }

  /** Les étapes qu'un clic rouvre, dans l'ordre du fil. */
  function rouvrables(): string[] {
    return screen.queryAllByRole('button', { name: /^Revenir à l’étape / }).map(libelle);
  }

  it('désigne une étape courante, et une seule, à chaque étape', async () => {
    const user = renderTunnel();

    await waitFor(() => {
      expect(courantes()).toEqual(['Prestation']);
    });

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(courantes()).toEqual(['Créneau']);

    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    expect(courantes()).toEqual(['Coordonnées']);
  });

  it('ne rend cliquables que les étapes déjà franchies', async () => {
    const user = renderTunnel();

    // Première étape : rien derrière soi, donc rien à rouvrir.
    await waitFor(() => {
      expect(courantes()).toEqual(['Prestation']);
    });
    expect(rouvrables()).toEqual([]);

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(rouvrables()).toEqual(['Prestation']);

    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    // Ni l'étape courante, ni celles qui restent : le wireframe est explicite
    // sur les secondes, et la première n'a nulle part où ramener.
    expect(rouvrables()).toEqual(['Prestation', 'Créneau']);
  });

  it('ramène à l’étape cliquée sans rien faire perdre de la saisie', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    expect(courantes()).toEqual(['Récapitulatif']);

    await user.click(screen.getByRole('button', { name: 'Revenir à l’étape Coordonnées' }));

    // Le formulaire est rendu tel qu'il a été quitté : le fil est un raccourci,
    // pas une remise à zéro.
    expect(screen.getByLabelText(/Prénom/)).toHaveProperty('value', 'Camille');
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty(
      'value',
      'camille@example.test',
    );
    expect(courantes()).toEqual(['Coordonnées']);

    // Et l'adresse suit, comme elle suit les boutons du bas (#733) : le fil
    // n'ouvre pas un second chemin d'étape qui lui échapperait.
    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });
  });

  it('rend le focus à l’étape rouverte, que le bouton cliqué vient d’emporter', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    await user.click(screen.getByRole('button', { name: 'Revenir à l’étape Coordonnées' }));

    // Le bouton cliqué n'existe plus : l'étape franchie est devenue l'étape
    // courante, qui n'est pas un bouton. Sans rattrapage, le focus retomberait
    // sur `<body>` et la tabulation repartirait du haut du document (skill
    // web-frontend §7).
    const [courante] = fil().filter((etape) => etape.getAttribute('aria-current') === 'step');

    expect(document.activeElement).toBe(courante);
  });

  it('remonte jusqu’au calendrier, dont les créneaux sont rechargés', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    await user.click(screen.getByRole('button', { name: 'Revenir à l’étape Créneau' }));

    // `SlotStep` est remonté, et interroge les disponibilités à son montage : la
    // cliente ne choisit pas dans la liste d'il y a trois écrans.
    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(loadAvailabilityAction).toHaveBeenCalledTimes(2);
  });

  it('ne rouvre aucune étape une fois le rendez-vous pris', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));
    await screen.findByText('Votre rendez-vous est enregistré');

    // L'écran terminal (#732) : `step` vaut `confirmation` quoi que porte le
    // brouillon, et rouvrir une étape n'afficherait donc rien de neuf. Un bouton
    // qui ne fait rien est pire que pas de bouton.
    expect(courantes()).toEqual(['Confirmation']);
    expect(rouvrables()).toEqual([]);
  });
});
