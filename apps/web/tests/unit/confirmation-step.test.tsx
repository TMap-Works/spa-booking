/**
 * L'écran terminal du tunnel — ce qui en sort, et ce qu'il a le droit d'affirmer
 * (#732, #1051).
 *
 * Trois choses lui étaient reprochées par l'audit de conception `d20260916-1` :
 *
 * - **il ne sortait nulle part.** La seule action offerte était « Annuler ce
 *   rendez-vous », alors que `docs/design/appointments/wireframes.md` — Étape 6
 *   — prescrit des prochaines actions : réserver à nouveau, rejoindre le
 *   rendez-vous là où il se modifie ;
 * - **il affirmait un état qu'il ne relit pas.** Le brouillon est écrit une fois,
 *   à la réservation ; reporté ou annulé depuis l'espace client, le rendez-vous
 *   restait annoncé « enregistré » à son ancien horaire ;
 * - **sa preuve de réservation ne se lisait pas** (#736). Un UUID de trente-six
 *   caractères en gris atténué, et le conseil de conserver une page qui ne
 *   survit pas à son onglet.
 *
 * `d20260918-1` en ajoute une quatrième, que #1051 traite : **le moment « c'est
 * réservé » ne se voyait pas**. Un encart vert de douze lignes de texte ouvrait
 * l'écran, la date était noyée dans une liste de définitions, et trois actions
 * s'y présentaient dans trois styles différents. L'écran annonce désormais
 * l'issue — pastille, titre, une phrase —, montre la carte du rendez-vous, et
 * hiérarchise ses sorties autour d'un seul bouton plein.
 */

import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PENDING_CONFIRMATION_LABEL } from '@/lib/appointment-status';
import { ConfirmationStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/confirmation-step';

import { contact, service, tenant } from './fixtures';

const cancelAppointmentAction = vi.fn();

vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  cancelAppointmentAction: (...args: unknown[]) => cancelAppointmentAction(...args),
}));

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
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
    ...overrides,
  };
}

function renderConfirmation(
  options: {
    readonly restored?: boolean;
    readonly cancelled?: boolean;
    readonly pending?: boolean;
  } = {},
) {
  const onRestart = vi.fn();
  const onCancelled = vi.fn();

  const { container } = render(
    <ConfirmationStep
      tenant={tenant}
      service={service}
      appointment={
        options.cancelled === true
          ? appointment({ status: 'cancelled', cancelledAt: '2026-08-31T10:00:00.000Z' })
          : options.pending === true
            ? appointment({ status: 'pending' })
            : appointment()
      }
      contact={contact}
      restored={options.restored ?? false}
      onCancelled={onCancelled}
      onRestart={onRestart}
    />,
  );

  return { container, onRestart, onCancelled, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  cancelAppointmentAction.mockReset();
});

describe('l’écran terminal est une sortie', () => {
  it('propose de réserver à nouveau, et repart alors d’un brouillon vierge', async () => {
    const { onRestart, user } = renderConfirmation();

    await user.click(screen.getByRole('button', { name: 'Réserver à nouveau' }));

    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('mène à l’espace client, où le rendez-vous se reporte et s’annule', () => {
    renderConfirmation();

    const lien = screen.getByRole('link', { name: 'Voir mes rendez-vous' });

    // Un lien et non un bouton : c'est une navigation, elle doit s'ouvrir dans
    // un onglet et se copier comme n'importe quelle adresse.
    expect(lien.getAttribute('href')).toBe('/maison-lotus/compte');
  });

  /*
   * `BM-RDV-03` — « le rendez-vous rejoint l'agenda du téléphone, ce qui réduit
   * les oublis ». C'est l'action que l'écran met en avant depuis #1051 :
   * « Voir mes rendez-vous » mène à une surface que la moitié des clientes — celles
   * qui ont réservé sans compte — ne peuvent pas ouvrir, là où le fichier
   * d'agenda fonctionne pour tout le monde, tout de suite.
   */
  it('donne l’accent à l’ajout à l’agenda, et un seul bouton plein à l’écran', () => {
    const { container } = renderConfirmation();

    const agenda = screen.getByRole('link', { name: 'Ajouter à mon agenda' });

    expect(agenda.className).toContain('spa-button--accent');
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' }).className).toContain(
      'spa-button--neutral',
    );
    expect(screen.getByRole('button', { name: 'Réserver à nouveau' }).className).toContain(
      'spa-button--quiet',
    );
    // BM-VISUEL-02 : un seul bouton plein par écran.
    expect(container.querySelectorAll('.spa-button--accent')).toHaveLength(1);
  });

  it('télécharge un fichier d’agenda nommé par la référence, pas par un UUID', () => {
    renderConfirmation();

    const agenda = screen.getByRole('link', { name: 'Ajouter à mon agenda' });

    expect(agenda.getAttribute('download')).toBe('rendez-vous-RDV-8F3K-27.ics');

    const href = agenda.getAttribute('href') ?? '';

    expect(href.startsWith('data:text/calendar;charset=utf-8,')).toBe(true);

    const ics = decodeURIComponent(href.slice('data:text/calendar;charset=utf-8,'.length));

    // ADR 0006 : l'instant est écrit en UTC — la seule écriture qui désigne sans
    // ambiguïté l'heure du salon, quel que soit le fuseau de l'agenda qui
    // l'ouvre. 06:00 UTC, c'est bien le 09:00 affiché à Antananarivo.
    expect(ics).toContain('DTSTART:20260901T060000Z');
    expect(ics).toContain('DTEND:20260901T070000Z');
    expect(
      new Intl.DateTimeFormat('fr-FR', {
        timeZone: tenant.timezone,
        timeStyle: 'short',
      }).format(new Date('2026-09-01T06:00:00.000Z')),
    ).toBe('09:00');
    expect(ics).toContain('SUMMARY:Massage suédois — Maison Lotus');
  });

  it('range l’annulation en action secondaire, le rouge restant au geste destructif', async () => {
    const { user } = renderConfirmation();

    const annuler = screen.getByRole('button', { name: 'Annuler ce rendez-vous' });

    // L'entrée dans l'annulation n'est pas l'action mise en avant de l'écran.
    expect(annuler.className).toContain('spa-button--quiet');

    await user.click(annuler);

    // Le rouge reparaît là où il compte : sur la confirmation elle-même.
    expect(screen.getByRole('button', { name: 'Confirmer l’annulation' }).className).toContain(
      'spa-button--danger',
    );
  });

  it('écarte les sorties tant que la question de l’annulation attend sa réponse', async () => {
    const { user } = renderConfirmation();

    await user.click(screen.getByRole('button', { name: 'Annuler ce rendez-vous' }));

    // Deux boutons face à une question, et rien qui invite à passer à côté sans
    // y répondre.
    expect(screen.queryByRole('button', { name: 'Réserver à nouveau' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Voir mes rendez-vous' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ajouter à mon agenda' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Garder mon rendez-vous' })).toBeDefined();
  });

  it('garde ses deux sorties une fois le rendez-vous annulé, sans reproposer l’annulation', () => {
    renderConfirmation({ cancelled: true });

    expect(screen.getByRole('button', { name: 'Réserver à nouveau' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Annuler ce rendez-vous' })).toBeNull();
    // Rien à ajouter à un agenda : le rendez-vous ne figure plus nulle part.
    // Le bouton n'est pas rendu, plutôt que désactivé.
    expect(screen.queryByRole('link', { name: 'Ajouter à mon agenda' })).toBeNull();
    // L'accent passe alors à la seule action qui reste utile.
    expect(screen.getByRole('button', { name: 'Réserver à nouveau' }).className).toContain(
      'spa-button--accent',
    );
  });

  it('nomme la reprise d’un seul libellé, celui du wireframe', () => {
    // Le même geste en portait deux selon l'état du rendez-vous : « Réserver à
    // nouveau » confirmé, « Prendre un nouveau rendez-vous » annulé. Le
    // wireframe — Étape 6 — n'en connaît qu'un, et un écran qui renomme son
    // action selon l'état apprend deux fois la même chose au visiteur.
    renderConfirmation({ cancelled: true });

    expect(screen.queryByRole('button', { name: 'Prendre un nouveau rendez-vous' })).toBeNull();
  });
});

/**
 * L'issue annoncée en tête d'écran (#1051, #948).
 *
 * `BM-CONFIRM-01` veut qu'on sache immédiatement où l'on en est ; #948 veut que
 * ce soit honnête. Les deux se tiennent dans le même bloc : la pastille suit le
 * **statut réel** du rendez-vous, et les mots de l'attente sont ceux de la
 * pastille de l'espace client (#743, #917).
 */
describe('ce que l’écran a le droit d’affirmer', () => {
  it('annonce la réservation faite quand le salon a confirmé', () => {
    renderConfirmation();

    expect(screen.getByRole('heading', { name: 'C’est réservé !' })).toBeDefined();
  });

  it('n’annonce qu’une demande tant que le salon n’a pas confirmé', () => {
    // Le rendez-vous naît `pending` côté API : c'est le cas courant à la sortie
    // du tunnel, et l'annoncer « réservé » ferait mentir l'écran.
    renderConfirmation({ pending: true });

    expect(screen.getByRole('heading', { name: 'Demande envoyée' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'C’est réservé !' })).toBeNull();

    const ligne = screen.getByText(new RegExp(PENDING_CONFIRMATION_LABEL));

    // Ce que l'attente attend, et ce qu'elle ne coûte pas : le créneau est déjà
    // retenu — `pending` bloque le créneau côté API — et rien n'est demandé à la
    // cliente. La phrase est celle de `appointment-brief.ts`, partagée avec la
    // carte du prochain rendez-vous de l'espace client.
    expect(ligne.textContent).toContain('Votre créneau est retenu');
    expect(ligne.textContent).toContain('rien à faire de votre côté');
  });

  it('n’affirme plus rien quand il ne fait que resservir le brouillon', () => {
    renderConfirmation({ restored: true });

    // Une pastille de succès est une affirmation sur l'agenda du salon, que le
    // front n'a aucun moyen de vérifier : aucune lecture publique d'un
    // rendez-vous n'existe côté API.
    expect(screen.queryByRole('heading', { name: 'C’est réservé !' })).toBeNull();

    const avis = screen.getByText('Votre dernière réservation dans cet onglet');

    expect(avis).toBeDefined();
    // L'autorité nommée est celle qui vaut pour tout le monde : une cliente qui
    // a réservé sans compte n'a pas d'espace client à consulter.
    expect(avis.parentElement?.textContent).toContain('agenda du salon');
    // La sortie, elle, reste offerte à celles qui en ont un.
    expect(screen.getByRole('link', { name: 'Voir mes rendez-vous' })).toBeDefined();
  });

  it('dit annulé ce que l’API vient d’annuler, même restitué depuis le brouillon', () => {
    // L'annulation, elle, est un état que le brouillon ne peut pas inventer :
    // il n'y arrive que par la réponse de l'API.
    renderConfirmation({ restored: true, cancelled: true });

    expect(screen.getByRole('heading', { name: 'Votre rendez-vous est annulé' })).toBeDefined();
  });
});

/**
 * La preuve de réservation se lit et se dicte (#736).
 *
 * Troisième reproche du même audit : l'écran rendait « Référence :
 * 8425dc59-e63d-4ff5-b679-5714157cb046 », en gris atténué, sur deux lignes à
 * 360 px — et conseillait de conserver une page qui ne survit pas à son onglet.
 */
describe('la référence du rendez-vous', () => {
  it('est la référence courte du wireframe, et non l’identifiant', () => {
    renderConfirmation();

    // `docs/design/appointments/wireframes.md` — Étape 6 : « Réf. RDV-8F3K-27 ».
    // Depuis #796, la valeur affichée est celle que l'API rend
    // (`BookedAppointment.reference`), et non plus une dérivation de l'identifiant.
    expect(screen.getByText('Réf.')).toBeDefined();
    expect(screen.getByText('RDV-8F3K-27')).toBeDefined();
    expect(screen.queryByText(/55555555-5555-4555-8555-555555555555/)).toBeNull();
  });

  it('garde l’identifiant en attribut, puisque la ligne ne le montre plus', () => {
    const { container } = renderConfirmation();

    // Rien de secret : c'est la donnée du brouillon de cet onglet, et celle que
    // l'annulation envoie déjà à l'API. Mais c'est aussi ce dont le parcours
    // critique se sert pour retrouver en API le rendez-vous qu'il vient de
    // prendre (`tests/e2e/support/scene.ts`).
    expect(
      container.querySelector('[data-appointment-id]')?.getAttribute('data-appointment-id'),
    ).toBe('55555555-5555-4555-8555-555555555555');
  });

  it('reste affichée une fois le rendez-vous annulé', () => {
    // C'est la preuve de ce qui a eu lieu : elle vaut aussi pour réclamer une
    // annulation qu'on conteste.
    renderConfirmation({ cancelled: true });

    expect(screen.getByText('RDV-8F3K-27')).toBeDefined();
  });
});

describe('ce que l’écran demande de faire de lui', () => {
  it('annonce l’e-mail et l’espace client en une ligne, sans demander de conserver la page', () => {
    const { container } = renderConfirmation();

    const ligne = container.querySelector('.spa-booking__sent')?.textContent ?? '';

    // « Conservez cette page : c'est d'ici que vous pouvez annuler » promettait
    // une permanence que la fermeture de l'onglet emporte —
    // `notification-content.ts` le dit lui-même en expliquant pourquoi le
    // `{{lien_annulation}}` de l'e-mail pointe l'espace client et pas cet écran.
    expect(ligne).not.toContain('Conservez cette page');
    // L'accusé automatique du CDC §1.4 part sur un rendez-vous encore `PENDING` :
    // l'appeler « e-mail de confirmation » sous une pastille « à confirmer par le
    // salon » ferait croire que la confirmation attendue est arrivée.
    expect(ligne).toContain('e-mail récapitulatif');
    expect(ligne).not.toContain('e-mail de confirmation');
    expect(ligne).toContain('camille@example.test');
    // Et le second message, qui part quand le salon confirme (#800).
    expect(ligne).toContain('un second quand le salon aura confirmé');
    // La condition reste dite : une réservation d'invitée crée une fiche sans
    // mot de passe, et l'espace client n'est pas promis à qui n'a pas de compte.
    expect(ligne).toContain('compte client');
  });

  it('ne promet plus rien de l’e-mail une fois le rendez-vous annulé', () => {
    const { container } = renderConfirmation({ cancelled: true });

    expect(container.querySelector('.spa-booking__sent')).toBeNull();
  });
});

/**
 * La carte du rendez-vous (#735, #1051).
 *
 * La durée manquait à la liste : la cliente ne la lisait que parce que les
 * prestations du jeu d'essai la portent dans leur nom. Depuis #1051 elle
 * qualifie la plage horaire, en retrait typographique (`BM-VISUEL-03`).
 */
describe('la carte du rendez-vous', () => {
  it('donne la plage horaire dans le fuseau du salon, au premier écran', () => {
    renderConfirmation();

    // 06:00 → 07:00 UTC, lus à Antananarivo (UTC+3).
    expect(screen.getByText(/09:00 – 10:00/)).toBeDefined();
  });

  it('déduit la durée de l’intervalle du rendez-vous, et non de la prestation reçue', () => {
    // Le catalogue de ce rendu annonce 60 minutes, l'intervalle en porte 90 :
    // c'est bien le second qui s'affiche. Ce n'est pas une garantie de gel —
    // l'API recalcule `endsAt` avec la durée courante (`billed-interval.ts`) —
    // mais la source lue, celle qui reste disponible quand la prestation a quitté
    // le catalogue public et que `service` arrive à `null`.
    render(
      <ConfirmationStep
        tenant={tenant}
        service={service}
        appointment={appointment({ endsAt: '2026-09-01T07:30:00.000Z' })}
        contact={contact}
        restored={false}
        onCancelled={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    expect(screen.getByText('· 1 h 30')).toBeDefined();
  });

  it('s’omet plutôt que de rendre une durée que l’intervalle ne donne pas', () => {
    // Un intervalle dégénéré ne doit produire ni « 0 min » ni « NaN min » sur
    // l'écran qui sert de preuve de réservation.
    render(
      <ConfirmationStep
        tenant={tenant}
        service={service}
        appointment={appointment({ endsAt: '2026-09-01T06:00:00.000Z' })}
        contact={contact}
        restored={false}
        onCancelled={vi.fn()}
        onRestart={vi.fn()}
      />,
    );

    expect(screen.queryByText(/^·/)).toBeNull();
    // L'heure de début reste écrite : c'est la borne dont on est sûr.
    expect(screen.getByText('09:00')).toBeDefined();
  });

  it('n’offre aucune correction : le créneau est pris', () => {
    renderConfirmation();

    expect(screen.queryByRole('button', { name: /^Modifier/ })).toBeNull();
  });
});
