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
import type { AccountPresence } from '@/lib/account-presence';
import { emptyBookingDraft, readBookingDraft, writeBookingDraft } from '@/lib/booking/draft';

import { contact, contactAccount, presence as connectee, service, tenant } from './fixtures';

const loadAvailabilityAction = vi.fn();
// Ni la réservation (#1207) ni l'annulation (#1201) ne sont plus des actions de
// ce tunnel : les deux partent vers une adresse de l'espace client, seule à
// recevoir les cookies de session. Ce sont leurs modules d'appel qu'on tient
// ici — `requestBooking` garde le nom `bookAppointmentAction` dans ces suites,
// parce que ce que chacune vérifie est le **geste**, pas son transport.
const bookAppointmentAction = vi.fn();
const requestCancellation = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  loadAvailabilityAction: (...args: unknown[]) => loadAvailabilityAction(...args),
}));

vi.mock('@/app/(booking)/[tenantSlug]/reservation/booking-request', () => ({
  requestBooking: (...args: unknown[]) => bookAppointmentAction(...args),
}));

vi.mock(
  '@/app/(account)/[tenantSlug]/compte/rendez-vous/[appointmentId]/annulation/cancellation-request',
  () => ({ requestCancellation: (...args: unknown[]) => requestCancellation(...args) }),
);

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
const CONNEXION = `/${tenant.slug}/compte/connexion?retour=${encodeURIComponent(ADRESSE)}`;
const INSCRIPTION = `/${tenant.slug}/compte/inscription?retour=${encodeURIComponent(ADRESSE)}`;

/**
 * Ce que la cliente laisse au salon à l'étape « Coordonnées ».
 *
 * C'est la saisie que les scénarios suivent d'un écran à l'autre : connectée,
 * la cliente n'a plus à taper ses nom et adresse — le compte les connaît —, et
 * ce mot est le seul champ de l'étape qu'elle remplit à coup sûr.
 */
const MOT = 'Arrivée à 9 h 10';

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
  requestCancellation.mockReset();
});

/**
 * `presence` vaut la **cliente connectée** par défaut.
 *
 * Réserver exige un compte depuis le 2026-09-22 : sans présence, le tunnel
 * s'arrête à l'écran de connexion et n'atteint jamais le récapitulatif. C'est
 * donc l'état sous lequel le parcours se déroule, et les cas qui parlent d'une
 * visiteuse sans compte passent `null` explicitement.
 */
function renderTunnel(presence: AccountPresence | null = connectee) {
  render(
    <BookingTunnel
      tenant={tenant}
      services={[service]}
      exitHref={`/${tenant.slug}`}
      presence={presence}
      loginHref={CONNEXION}
      registerHref={INSCRIPTION}
      // L'état de départ que le serveur lit dans l'adresse (#1055). Ces cas-ci
      // arrivent tous par la première étape : c'est le brouillon vierge, et
      // l'effet d'hydratation prend ensuite le relais sur `sessionStorage`.
      initialDraft={emptyBookingDraft()}
    />,
  );

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

  // Connectée, la cliente ne retape ni son nom ni son adresse : l'encart
  // « Réservé au nom de … » les résume (#1050). Elle laisse un mot au salon.
  await user.type(screen.getByLabelText(/Un mot pour le salon/), MOT);
  // Le consentement est bloquant depuis #734 : sans lui, l'étape ne rend pas la
  // main au récapitulatif. Ce qu'il refuse est éprouvé par
  // `booking-consent.test.tsx` ; ici il n'est qu'un préalable du parcours.
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

  await screen.findByRole('button', { name: /Confirmer la réservation/ });
}

/**
 * Quelqu'un d'autre prend 09:00 — **à l'instant du refus**, et pas avant.
 *
 * Le départ du créneau est daté par le 409 lui-même : c'est à partir de là, et
 * seulement à partir de là, que les chargements cessent de le proposer. Poser
 * cet état d'avance avec un `mockResolvedValueOnce` revenait à parier que la
 * cliente cliquerait avant la deuxième interrogation du serveur — un pari que
 * la revalidation à cinq secondes de #1153 fait perdre dès que la machine
 * traîne : 09:00 s'effaçait sous la souris, et le scénario échouait avant même
 * d'atteindre la collision qu'il décrit.
 *
 * `beforeEach` sert les deux horaires ; celui-ci n'en retire qu'un, au bon moment.
 */
/**
 * Le calendrier rouvert derrière une collision, attendu le temps qu'il faut.
 *
 * `findBy*` accorde **une seconde**, et cette borne-là n'est pas celle que
 * `vitest.config.mts` a relevée à trente : `testTimeout` couvre le test entier,
 * `asyncUtilTimeout` chaque attente. Or ce que celle-ci attend est un
 * aller-retour complet — refus de l'API, retour à l'étape créneau, nouveau
 * chargement —, et une vague de jalon fait tourner plusieurs agents sur les
 * mêmes cœurs : le worker affamé rend la main après la seconde, et le test
 * échoue sur la famine au lieu du comportement. Le même constat que le
 * relèvement de `testTimeout` documente, à l'autre bout de la même course.
 */
function creneauApresCollision(nom: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: nom }, { timeout: 15_000 });
}

function perdLeCreneauDuMatin(): void {
  bookAppointmentAction.mockImplementation(() => {
    loadAvailabilityAction.mockResolvedValue({ ok: true, data: availability([APRES_MIDI]) });

    return Promise.resolve({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: MESSAGE_API,
    });
  });
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
    // Le créneau part **au moment du 409**, et les chargements suivants ne le
    // rendent plus. Dater ainsi le départ plutôt que de le poser d'avance avec
    // un `mockResolvedValueOnce` n'est pas un détail de forme : l'étape créneau
    // revalide toutes les cinq secondes depuis #1153, si bien qu'un premier
    // chargement « une seule fois » se consommait avant même que la cliente
    // n'ait cliqué — et 09:00 disparaissait sous sa souris, sur une machine
    // lente. Le scénario décrit maintenant ce qui se passe vraiment.
    perdLeCreneauDuMatin();

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    const avantLaCollision = loadAvailabilityAction.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await creneauApresCollision('14 h 00')).toBeDefined();
    // Sur l'existence d'un rechargement après la collision, et non sur un total :
    // compter les appels reviendrait à compter les battements de revalidation,
    // donc le temps que la machine met à jouer le test.
    expect(loadAvailabilityAction.mock.calls.length).toBeGreaterThan(avantLaCollision);
    expect(screen.queryByRole('button', { name: '09 h 00' })).toBeNull();
  });

  it('conserve la prestation et les coordonnées déjà saisies', async () => {
    perdLeCreneauDuMatin();

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    // Un seul geste sépare la cliente de sa réservation : reprendre un horaire.
    await user.click(await creneauApresCollision('14 h 00'));

    expect(screen.getByText(`${contact.firstName} ${contact.lastName}`)).toBeDefined();
    expect(screen.getByLabelText(/Un mot pour le salon/)).toHaveProperty('value', MOT);

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
      clientNote: MOT,
    });
    // Et aucune coordonnée : le contrat a perdu le champ avec #1222, et il est
    // `.strict()` — le réémettre ferait rendre 400 à toute réservation.
    expect(bookAppointmentAction.mock.calls[1]?.[1]).not.toHaveProperty('client');
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

    // Le point de comparaison est pris ici, et non à zéro : l'étape créneau
    // revalide toutes les cinq secondes depuis #1153, et le nombre de
    // battements qu'elle a eu le temps de faire avant ce clic ne dit rien du
    // comportement éprouvé — seulement de la vitesse de la machine.
    const avantLaPanne = loadAvailabilityAction.mock.calls.length;
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByText('La réservation n’a pas abouti')).toBeDefined();
    // Toujours au récapitulatif : ni retour au calendrier, ni rechargement.
    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.queryByRole('button', { name: '14 h 00' })).toBeNull();
    // Le récapitulatif ne monte pas l'étape créneau : rien n'a pu recharger.
    expect(loadAvailabilityAction.mock.calls.length).toBe(avantLaPanne);
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
    // Un compte dont le cookie ne porte pas encore d'adresse (#1086) : le
    // champ est ouvert, et c'est la cliente qui la tape.
    const user = renderTunnel({ ...connectee, email: '' });

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
    await user.type(screen.getByLabelText(/Un mot pour le salon/), MOT);
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
    expect(await screen.findByLabelText(/Un mot pour le salon/)).toHaveProperty('value', MOT);
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

    // Le praticien se change depuis une puce qui ouvre un panneau de cartes
    // (#1049, `BM-PRATICIEN-04`), et non plus depuis une liste déroulante.
    await user.click(screen.getByRole('button', { name: /^Praticien :/ }));
    await user.click(screen.getByRole('radio', { name: new RegExp(service.staff[0]?.displayName ?? '') }));

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

    // L'onglet n'a aucun brouillon : tout ce que le tunnel sait vient du lien —
    // et, pour les coordonnées, du compte.
    expect(await screen.findByText('Réservé au nom de')).toBeDefined();
    expect(screen.getByLabelText(/Un mot pour le salon/)).toHaveProperty('value', '');
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
    await screen.findByText('C’est réservé !');
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
    await screen.findByText('C’est réservé !');

    // L'écran terminal prend la place du récapitulatif qui l'a produit plutôt
    // que d'ajouter un arrêt : il n'y a rien à revenir confirmer deux fois.
    expect(window.history.length).toBe(avant);
    expect(query().get('etape')).toBe('confirmation');

    await retourNavigateur();

    expect(screen.getByText('C’est réservé !')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirmer la réservation/ })).toBeNull();
  });
});

describe('l’écran terminal rend la main au tunnel (#732)', () => {
  it('repart d’un brouillon vierge, et non de la réservation précédente', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    await screen.findByText('C’est réservé !');
    await user.click(screen.getByRole('button', { name: 'Réserver à nouveau' }));

    // Première étape, catalogue en main : le tunnel n'est plus bloqué sur la
    // confirmation précédente.
    expect(await screen.findByRole('radio', { name: CARTE })).toHaveProperty('checked', false);
    expect(screen.queryByText('C’est réservé !')).toBeNull();

    // Les coordonnées aussi sont reparties : une nouvelle réservation n'est pas
    // forcément pour la même personne. Ce que l'étape reprend vient du compte,
    // et le mot laissé la fois précédente ne resservira pas.
    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '14 h 00' }));

    expect(screen.getByLabelText(/Un mot pour le salon/)).toHaveProperty('value', '');
    expect(readBookingDraft(tenant.slug).contact.email).toBe('');
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
        // Le brouillon de la cliente qui rouvre le tunnel, et non celui d'une
        // autre (#1151) : sans propriétaire, le rendez-vous tomberait avec les
        // coordonnées et il n'y aurait plus d'écran de confirmation à juger.
        contactAccount,
        appointment: rendezVous(),
      }),
    );

    renderTunnel();

    expect(await screen.findByText('Votre dernière réservation dans cet onglet')).toBeDefined();
    expect(screen.queryByText('C’est réservé !')).toBeNull();
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
    // Et ce n'est pas une perte : la carte du récapitulatif les redit tous,
    // durée comprise depuis ce même ticket — en retrait de la plage horaire
    // depuis #1051, et non plus en rangée « Durée / 1 h ».
    expect(screen.getByText('· 1 h')).toBeDefined();
  });
});

/**
 * L'en-tête et la progression du tunnel (#740, #1047).
 *
 * `BM-TUNNEL-09` veut que *« la cliente sache combien il reste à faire »*,
 * `BM-TUNNEL-10` que l'en-tête se réduise à *« un "←" (étape précédente) et un
 * "×" (quitter) »*, et `BM-TUNNEL-11` que *« chaque écran dise ce qu'il
 * demande »*. Le tunnel affichait à la place un fil de cinq pastilles sur trois
 * lignes à 360 px, sous un titre unique — « Prendre rendez-vous » — qui ne
 * changeait jamais (audit `d20260918-1`).
 *
 * Ce qui s'éprouve ici est ce que le **composant** décide : le compte, le titre,
 * ce que « ← Retour » rouvre, et ce que « ✕ Quitter » demande. La peinture qui
 * s'y accroche — le filet segmenté — est hors de portée de jsdom, qui ne charge
 * aucune feuille de style.
 */
describe('l’en-tête et la progression du tunnel (#1047)', () => {
  /** Le compte affiché, ou `null` à la confirmation, qui n'en porte pas. */
  function compte(): string | null {
    return screen.queryByText(/^Étape \d+ sur \d+$/)?.textContent ?? null;
  }

  /** Le titre de l'étape — le seul `<h1>` de l'écran. */
  function titre(): string {
    return screen.getByRole('heading', { level: 1 }).textContent ?? '';
  }

  it('compte les étapes parcourues, et n’en compte que quatre', async () => {
    const user = renderTunnel();

    await waitFor(() => {
      expect(compte()).toBe('Étape 1 sur 4');
    });

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(compte()).toBe('Étape 2 sur 4');

    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    expect(compte()).toBe('Étape 3 sur 4');
  });

  it('ne compte pas la confirmation, qui n’est pas une étape à franchir', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    expect(compte()).toBe('Étape 4 sur 4');

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));
    await screen.findByText('C’est réservé !');

    expect(compte()).toBeNull();
  });

  it('donne à chaque étape le titre de ce qu’elle demande', async () => {
    const user = renderTunnel();

    await waitFor(() => {
      expect(titre()).toBe('Quelle prestation ?');
    });

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    expect(titre()).toBe('Quand souhaitez-vous venir ?');

    await user.click(await screen.findByRole('button', { name: '09 h 00' }));

    expect(titre()).toBe('Comment vous joindre ?');
  });

  it('n’offre pas de retour là où il n’y a rien derrière', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: rendezVous() });

    const user = renderTunnel();

    // Première étape : rien à rouvrir. Un bouton grisé laisserait croire qu'il
    // manque une condition à remplir.
    await waitFor(() => {
      expect(compte()).toBe('Étape 1 sur 4');
    });
    expect(screen.queryByRole('button', { name: 'Retour' })).toBeNull();

    await allerJusquAuRecapitulatif(user, '09 h 00');

    expect(screen.getByRole('button', { name: 'Retour' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));
    await screen.findByText('C’est réservé !');

    // L'écran terminal (#732) : le rendez-vous est pris, et revenir au
    // récapitulatif y réserverait une seconde fois.
    expect(screen.queryByRole('button', { name: 'Retour' })).toBeNull();
  });

  it('ramène à l’étape précédente sans rien faire perdre de la saisie', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    await user.click(screen.getByRole('button', { name: 'Retour' }));

    // Le formulaire est rendu tel qu'il a été quitté : le retour est un
    // raccourci, pas une remise à zéro.
    expect(screen.getByLabelText(/Un mot pour le salon/)).toHaveProperty('value', MOT);
    expect(titre()).toBe('Comment vous joindre ?');

    // Et l'adresse suit, comme elle suit les boutons du bas (#733) : l'en-tête
    // n'ouvre pas un second chemin d'étape qui lui échapperait.
    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });
  });

  it('rend le focus au titre de l’étape rouverte', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    await user.click(screen.getByRole('button', { name: 'Retour' }));

    // Le bouton peut disparaître avec l'étape — c'est le cas du retour vers la
    // première —, et sans rattrapage le focus retomberait sur `<body>` : la
    // tabulation repartirait du haut du document (skill web-frontend §7).
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('remonte jusqu’au calendrier, dont les créneaux sont rechargés', async () => {
    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');

    // Pris avant les retours, pour la même raison qu'ailleurs dans ce fichier :
    // ce qui est éprouvé est le rechargement **au remontage**, pas le nombre de
    // battements de revalidation qu'une machine lente aura laissé passer (#1153).
    const avantLeRetour = loadAvailabilityAction.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Retour' }));
    await user.click(screen.getByRole('button', { name: 'Retour' }));

    // `SlotStep` est remonté, et interroge les disponibilités à son montage : la
    // cliente ne choisit pas dans la liste d'il y a trois écrans.
    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(loadAvailabilityAction.mock.calls.length).toBeGreaterThan(avantLeRetour);
  });

  it('laisse sortir sans rien demander tant que rien n’a été choisi', async () => {
    renderTunnel();

    // Un lien, et non un bouton : il n'y a rien à perdre, la sortie est une
    // navigation ordinaire.
    const sortie = await screen.findByRole('link', { name: 'Quitter' });

    expect(sortie.getAttribute('href')).toBe(`/${tenant.slug}`);
  });

  it('demande confirmation avant de quitter dès qu’un choix existe', async () => {
    const user = renderTunnel();

    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));

    // Le lien a laissé la place à un bouton : le brouillon vit dans
    // `sessionStorage` et meurt avec l'onglet.
    expect(screen.queryByRole('link', { name: 'Quitter' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Quitter' }));

    const confirmation = screen.getByRole('dialog');

    expect(within(confirmation).getByRole('link', { name: 'Quitter sans réserver' })).toBeDefined();
    expect(within(confirmation).getByRole('button', { name: 'Rester' })).toBeDefined();
  });
});

/**
 * Réserver exige un compte — décision du PO du 2026-09-22.
 *
 * La visiteuse sans compte parcourt le catalogue et les disponibilités ; c'est
 * au moment de réserver, une fois le créneau choisi, qu'elle est arrêtée pour se
 * connecter ou ouvrir un compte. Ce qui s'éprouve ici est ce que le tunnel en
 * décide : l'écran qui remplace les coordonnées, ce qu'il rappelle, où il mène,
 * et qu'aucun chemin ne le contourne — ni un brouillon ancien, ni un lien, ni un
 * cookie disparu depuis le chargement.
 */
describe('réserver exige un compte (2026-09-22)', () => {
  function titre(): string {
    return screen.getByRole('heading', { level: 1 }).textContent ?? '';
  }

  /** Prestation → créneau, sans compte : l'arrêt est à l'étape suivante. */
  async function allerJusquAuCreneauChoisi(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await choisirLaPrestation(user);
    await user.click(screen.getByRole('button', { name: 'Choisir un créneau' }));
    await user.click(await screen.findByRole('button', { name: '09 h 00' }));
  }

  it('laisse choisir prestation et créneau, puis arrête la visiteuse sans compte', async () => {
    const user = renderTunnel(null);

    await allerJusquAuCreneauChoisi(user);

    expect(titre()).toBe('Identifiez-vous');
    // C'est bien l'étape des coordonnées qu'elle a atteinte — le compte le dit
    // —, mais sans un seul champ à remplir.
    expect(screen.getByText('Étape 3 sur 4')).toBeDefined();
    expect(screen.queryByLabelText(/Prénom/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Vérifier ma réservation/ })).toBeNull();
  });

  it('mène à la connexion et à l’inscription du salon, le tunnel en retour', async () => {
    const user = renderTunnel(null);

    await allerJusquAuCreneauChoisi(user);

    expect(screen.getByRole('link', { name: 'Se connecter' }).getAttribute('href')).toBe(
      CONNEXION,
    );
    expect(screen.getByRole('link', { name: 'Créer un compte' }).getAttribute('href')).toBe(
      INSCRIPTION,
    );
  });

  it('rappelle la prestation et l’horaire choisis, là où Booker les perd', async () => {
    const user = renderTunnel(null);

    await allerJusquAuCreneauChoisi(user);

    const rappel = screen.getByRole('complementary', { name: 'Votre réservation' });

    expect(rappel.textContent).toContain(service.name);
    expect(rappel.textContent).toContain('1 septembre 2026');
    expect(rappel.textContent).toContain('09:00');
  });

  it('rend le calendrier sur « Changer de créneau »', async () => {
    const user = renderTunnel(null);

    await allerJusquAuCreneauChoisi(user);
    await user.click(screen.getByRole('button', { name: 'Changer de créneau' }));

    expect(await screen.findByRole('button', { name: '09 h 00' })).toBeDefined();
    expect(titre()).toBe('Quand souhaitez-vous venir ?');
  });

  it('ne rouvre pas le récapitulatif d’un brouillon complet à qui n’est pas connectée', async () => {
    // Un brouillon d'avant la règle : coordonnées complètes, consentement
    // donné, et l'adresse du récapitulatif. `reachableStep` l'ouvrirait.
    writeBookingDraft(tenant.slug, {
      ...emptyBookingDraft(),
      step: 'recapitulatif',
      serviceId: service.id,
      startsAt: MATIN,
      contact,
    });
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=recapitulatif&prestation=${service.id}&creneau=${MATIN}`,
    );

    renderTunnel(null);

    expect(await screen.findByRole('link', { name: 'Se connecter' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Confirmer la réservation/ })).toBeNull();
    await waitFor(() => {
      expect(query().get('etape')).toBe('coordonnees');
    });
  });

  it('ramène à la connexion quand la session a pris fin depuis le chargement', async () => {
    // Le cookie de présence a disparu — une déconnexion dans un autre onglet —,
    // et seule l'action de réservation le constate.
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Connectez-vous pour réserver.',
    });

    const user = renderTunnel();
    await allerJusquAuRecapitulatif(user, '09 h 00');
    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(await screen.findByText('Votre session a pris fin')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Se connecter' })).toBeDefined();
    expect(titre()).toBe('Identifiez-vous');
    // Et rien n'est perdu pour le retour : le brouillon garde créneau et saisie.
    const brouillon = readBookingDraft(tenant.slug);

    expect(brouillon.startsAt).toBe(MATIN);
    expect(brouillon.contact.clientNote).toBe(MOT);
  });
});

/**
 * Le changement de compte dans le même onglet (#1151).
 *
 * `sessionStorage` meurt avec l'onglet, pas avec la session : entre les deux, il
 * y a la place d'une déconnexion suivie d'une connexion sous un autre compte.
 * La campagne du 22/09/2026 a relevé ce que le tunnel en faisait — connectée en
 * Clara, l'étape 3 annonçait « Réservé au nom de Zoé … · qa.cliente1@… », case
 * de consentement déjà cochée.
 *
 * Le rendez-vous, lui, part au bon compte depuis #1136 et #1222 : la route
 * publique exige le jeton de la cliente, et la demande ne porte plus aucune
 * coordonnée. Ce qui reste à prouver ici est **ce que l'écran montre**.
 */
describe('un brouillon laissé par une autre cliente (#1151)', () => {
  /** La cliente d'avant, qui a traversé le tunnel dans cet onglet. */
  const AUTRE = {
    firstName: 'Zoé',
    lastName: 'Ranaivo',
    email: 'zoe@example.test',
    phone: '+261340000000',
    clientNote: 'Allergique au monoï',
    consent: true,
  };

  /** Son brouillon, tel que `sessionStorage` le garde après sa déconnexion. */
  function brouillonDeLAutre(step: 'coordonnees' | 'confirmation'): void {
    writeBookingDraft(tenant.slug, {
      ...emptyBookingDraft(),
      step,
      serviceId: service.id,
      startsAt: MATIN,
      contact: AUTRE,
      contactAccount: AUTRE.email,
      appointment: step === 'confirmation' ? rendezVous() : null,
    });
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=${step}&prestation=${service.id}&creneau=${MATIN}`,
    );
  }

  it('ne présente pas les coordonnées de la précédente à celle qui vient de se connecter', async () => {
    brouillonDeLAutre('coordonnees');

    renderTunnel();

    // L'encart résume le compte **de la session**, et les champs repliés
    // portent ce que la soumission emportera.
    expect(await screen.findByText(`${contact.firstName} ${contact.lastName}`)).toBeDefined();
    expect(screen.queryByText(new RegExp(AUTRE.firstName))).toBeNull();
    expect(screen.queryByText(new RegExp(AUTRE.email))).toBeNull();
    expect(screen.getByLabelText(/Prénom/)).toHaveProperty('value', contact.firstName);
    expect(screen.getByLabelText(/Adresse e-mail/)).toHaveProperty('value', contact.email);
  });

  it('ne reprend ni le mot au salon ni le consentement d’une autre personne', async () => {
    // Le consentement au traitement des données est donné par quelqu'un, pas
    // par un onglet (CDC §5.1) : le réutiliser enverrait à l'API un accord que
    // la cliente en place n'a jamais donné.
    brouillonDeLAutre('coordonnees');

    renderTunnel();

    expect(await screen.findByLabelText(/Un mot pour le salon/)).toHaveProperty('value', '');
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
  });

  it('ne montre pas à la suivante le rendez-vous pris par la précédente', async () => {
    // Référence citable, horaire, prestation : l'écran de confirmation donnerait
    // à lire un rendez-vous dont celle qui tient l'écran n'est pas la cliente.
    brouillonDeLAutre('confirmation');

    renderTunnel();

    expect(await screen.findByLabelText(/Prénom/)).toBeDefined();
    expect(screen.queryByText(/RDV-8F3K-27/)).toBeNull();
    expect(readBookingDraft(tenant.slug).appointment).toBeNull();
  });

  it('garde la prestation et le créneau, qui ne décrivent personne', async () => {
    // Ils sont déjà dans l'adresse, qu'un lien partage : celle qui vient de se
    // connecter reprend le parcours de l'onglet là où il en était.
    brouillonDeLAutre('coordonnees');

    renderTunnel();

    await screen.findByLabelText(/Prénom/);

    const brouillon = readBookingDraft(tenant.slug);

    expect(brouillon.serviceId).toBe(service.id);
    expect(brouillon.startsAt).toBe(MATIN);
  });

  it('laisse intact le brouillon de la cliente qui l’a écrit', async () => {
    writeBookingDraft(tenant.slug, {
      ...emptyBookingDraft(),
      step: 'coordonnees',
      serviceId: service.id,
      startsAt: MATIN,
      contact: { ...contact, clientNote: MOT },
      contactAccount,
    });
    window.history.replaceState(
      null,
      '',
      `${ADRESSE}?etape=coordonnees&prestation=${service.id}&creneau=${MATIN}`,
    );

    renderTunnel();

    expect(await screen.findByLabelText(/Un mot pour le salon/)).toHaveProperty('value', MOT);
    expect(readBookingDraft(tenant.slug).contact.clientNote).toBe(MOT);
  });
});
