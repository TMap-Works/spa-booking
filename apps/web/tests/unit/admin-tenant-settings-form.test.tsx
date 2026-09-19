import type { Tenant } from '@spa/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantSettingsForm } from '@/app/(admin)/[tenantSlug]/admin/components/tenant-settings-form';

const updateTenantSettingsAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  updateTenantSettingsAction: (...args: unknown[]) => updateTenantSettingsAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const tenant: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'spa-lumiere',
  name: 'Spa Lumière',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  // Toujours présente depuis #844, pour la même raison que les deux champs
  // ci-dessous : la colonne est `NOT NULL` avec un défaut. Le sélecteur de
  // langue du formulaire vient avec son propre ticket de l'épique #843.
  defaultLocale: 'en',
  isActive: true,
  // Toujours présents depuis #913 : leurs colonnes sont `NOT NULL` avec un
  // défaut, si bien qu'aucun établissement n'en est dépourvu. Le formulaire ne
  // les affiche pas encore — il vient avec son propre ticket.
  receiptPrefix: 'TIC',
  taxRateBps: 0,
  openingHours: [
    { weekday: 1, opensAt: '09:00', closesAt: '12:00' },
    { weekday: 1, opensAt: '14:00', closesAt: '19:00' },
  ],
};

/**
 * Le même salon, ouvert les sept jours.
 *
 * Depuis #764, les champs d'un jour ne sont rendus que si le jour est ouvert :
 * une journée fermée affiche son état en toutes lettres. Les 28 champs n'existent
 * donc ensemble que sur une semaine ouverte de bout en bout, et c'est ce salon-là
 * qu'il faut pour mesurer ce que #621 mesurait.
 */
const openEveryDay: Tenant = {
  ...tenant,
  openingHours: [
    { weekday: 1, opensAt: '09:00', closesAt: '12:00' },
    { weekday: 1, opensAt: '14:00', closesAt: '19:00' },
    { weekday: 2, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 3, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 4, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 5, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 6, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 7, opensAt: '09:00', closesAt: '19:00' },
  ],
};

/** Les sept jours, dans l'ordre de la grille — 1 lundi … 7 dimanche. */
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const;

/** Les 28 noms accessibles attendus : quatre bornes, sept jours. */
function expectedNames(): string[] {
  return DAYS.flatMap((day) => [
    `Ouverture 1 du ${day}`,
    `Fermeture 1 du ${day}`,
    `Ouverture 2 du ${day}`,
    `Fermeture 2 du ${day}`,
  ]);
}

afterEach(() => {
  cleanup();
  updateTenantSettingsAction.mockReset();
  refresh.mockReset();
});

describe('la grille des horaires d’ouverture — ce que le lecteur d’écran annonce', () => {
  it('donne à chacun des 28 champs un nom accessible qui nomme son jour', () => {
    // La preuve est prise dans l'arbre d'accessibilité et non dans le rendu :
    // `getByRole(…, { name })` calcule le nom accessible comme le ferait un
    // lecteur d'écran, et **échoue si deux champs le partagent**. Les 28 appels
    // qui passent disent donc à la fois la présence et l'unicité — c'est
    // exactement la mesure du constat de QA, « 28 champs pour 4 noms distincts »
    // (#621).
    render(<TenantSettingsForm tenant={openEveryDay} tenantSlug="spa-lumiere" />);

    const names = expectedNames();

    expect(new Set(names).size).toBe(28);

    for (const name of names) {
      expect(screen.getByRole('textbox', { name })).toBeDefined();
    }
  });

  it('ouvre le nom accessible par le libellé visible, que la voix peut dire', () => {
    // WCAG 2.5.3 : le nom accessible doit contenir le libellé visible, faute de
    // quoi « Ouverture 1 » prononcé à une commande vocale ne désigne plus rien.
    // Le vérifier sur le champ et non sur la constante : c'est l'attribut rendu
    // qui est lu.
    render(<TenantSettingsForm tenant={openEveryDay} tenantSlug="spa-lumiere" />);

    const field = screen.getByRole('textbox', { name: 'Fermeture 2 du dimanche' });
    const visible = document.querySelector(`label[for="${field.id}"]`);

    expect(visible?.textContent).toBe('Fermeture 2');
    expect(field.getAttribute('aria-label')).toBe('Fermeture 2 du dimanche');
  });

  it('rattache chaque jour à ses champs par un groupe qui en porte le nom', () => {
    // Sans cela le jour n'est qu'un paragraphe posé à côté de la grille : rien
    // dans l'arbre ne le relie aux quatre champs de sa ligne.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    for (const label of ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']) {
      expect(screen.getByRole('group', { name: label })).toBeDefined();
    }
  });

  it('pré-remplit la journée à coupure sans confondre ses deux plages', () => {
    // La régression qu'on redoute en renommant : des libellés justes posés sur
    // les mauvaises valeurs. Le lundi porte 09:00–12:00 puis 14:00–19:00.
    render(<TenantSettingsForm tenant={openEveryDay} tenantSlug="spa-lumiere" />);

    const value = (name: string): string =>
      (screen.getByRole('textbox', { name }) as HTMLInputElement).value;

    expect(value('Ouverture 1 du lundi')).toBe('09:00');
    expect(value('Fermeture 1 du lundi')).toBe('12:00');
    expect(value('Ouverture 2 du lundi')).toBe('14:00');
    expect(value('Fermeture 2 du lundi')).toBe('19:00');
    // Le mardi n'a qu'une plage : sa seconde reste vide, et la coupure du lundi
    // n'a donc pas débordé sur la ligne suivante.
    expect(value('Ouverture 1 du mardi')).toBe('09:00');
    expect(value('Ouverture 2 du mardi')).toBe('');
  });
});

describe('une journée de fermeture est un état, pas quatre champs vides (#764)', () => {
  /** Les plages saisies telles que l'action serveur les a reçues. */
  function savedWeek(): { weekday: number; opensAt: string; closesAt: string }[] {
    const [, changes] = updateTenantSettingsAction.mock.calls[0] as [
      string,
      { openingHours: { weekday: number; opensAt: string; closesAt: string }[] },
    ];

    return changes.openingHours;
  }

  it('écrit « Fermé » sur les jours sans plage, au lieu de leurs champs', () => {
    // Le constat de l'audit `d20260916-1` : samedi et dimanche — jours où le
    // salon est fermé — présentaient quatre champs vides dont les placeholders
    // gris affichaient « 09:00 / 12:00 ». Rien ne disait « fermé », et la lecture
    // au survol était celle d'un salon ouvert le week-end de 9 h à 12 h.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    for (const day of ['Samedi', 'Dimanche', 'Mardi']) {
      const groupe = screen.getByRole('group', { name: day });

      expect(groupe.textContent).toContain('Fermé — aucun créneau proposé');
      // Par le rôle et non par `input[type="text"]` : le champ du design system
      // ne pose pas d'attribut `type`, et le sélecteur d'attribut ne l'aurait
      // donc jamais trouvé — l'assertion aurait passé avec les quatre champs
      // toujours là.
      expect(within(groupe).queryAllByRole('textbox')).toHaveLength(0);
    }

    // Le lundi, lui, est ouvert : ses champs sont là, et rien ne le dit fermé.
    expect(screen.getByRole('group', { name: 'Lundi' }).textContent).not.toContain('Fermé');
  });

  it('coche l’interrupteur des seuls jours ouverts', () => {
    // C'est l'interrupteur qui distingue « le salon ferme le mercredi » de « le
    // mercredi n'est pas encore renseigné » (styles/admin/README.md §3.4). Son
    // état se déduit des plages : le contrat n'en porte pas d'autre.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Ouvert le lundi' }).checked).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Ouvert le samedi' }).checked,
    ).toBe(false);
  });

  it('propose une plage quand on ouvre une journée fermée', async () => {
    // « Le décocher retire les plages du jour ; le recocher en propose une »
    // (staff-schedule-editor.tsx). Rendre quatre champs vides serait rendre
    // exactement l'état qu'on vient de lever.
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('checkbox', { name: 'Ouvert le samedi' }));

    const ouverture = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Ouverture 1 du samedi',
    });

    expect(ouverture.value).toBe('09:00');
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Fermeture 1 du samedi' }).value,
    ).toBe('12:00');
  });

  it('ferme la journée pour de bon quand on décoche — plages comprises', async () => {
    // Décocher doit retirer les plages, pas seulement masquer les champs : une
    // journée « fermée » qui repartirait avec ses heures ferait mentir l'écran.
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('checkbox', { name: 'Ouvert le lundi' }));

    expect(screen.getByRole('group', { name: 'Lundi' }).textContent).toContain(
      'Fermé — aucun créneau proposé',
    );

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
    });
    expect(savedWeek()).toEqual([]);
  });

  it('n’enregistre pas une journée cochée « Ouvert » dont les plages sont vides', async () => {
    // Sans ce refus, l'interrupteur serait un décor : coché, sans heures, la
    // journée repartirait fermée — l'ambiguïté déplacée d'un cran plutôt que
    // levée. Le message se pose sur le champ par lequel on la corrige.
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.clear(screen.getByLabelText('Ouverture 1 du lundi'));
    await user.clear(screen.getByLabelText('Fermeture 1 du lundi'));
    await user.clear(screen.getByLabelText('Ouverture 2 du lundi'));
    await user.clear(screen.getByLabelText('Fermeture 2 du lundi'));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(
      await screen.findByText('renseignez une plage, ou décochez « Ouvert » pour fermer la journée'),
    ).toBeDefined();
    expect(updateTenantSettingsAction).not.toHaveBeenCalled();
  });

  it('ne reporte pas les plages surnuméraires d’une journée fermée', async () => {
    // L'écran n'édite que deux plages par jour et renvoie les autres telles
    // quelles pour ne pas les détruire. Sur une journée qu'on vient de fermer,
    // les conserver rouvrirait la journée au premier enregistrement.
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(
      <TenantSettingsForm
        tenant={{
          ...tenant,
          openingHours: [
            { weekday: 1, opensAt: '09:00', closesAt: '12:00' },
            { weekday: 1, opensAt: '14:00', closesAt: '17:00' },
            { weekday: 1, opensAt: '18:00', closesAt: '19:00' },
          ],
        }}
        tenantSlug="spa-lumiere"
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Ouvert le lundi' }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
    });
    expect(savedWeek()).toEqual([]);
  });

  it('ne ressuscite pas les plages surnuméraires quand on rouvre la journée', async () => {
    // Fermer emporte les plages invisibles ; rouvrir ne les rend pas. Sans quoi
    // décocher puis recocher le lundi renverrait la troisième plage qu'aucun
    // champ ne montre — la journée repartirait avec des heures que personne n'a
    // saisies, en plus de celle que « Ouvert » vient de proposer.
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(
      <TenantSettingsForm
        tenant={{
          ...tenant,
          openingHours: [
            { weekday: 1, opensAt: '09:00', closesAt: '12:00' },
            { weekday: 1, opensAt: '14:00', closesAt: '17:00' },
            { weekday: 1, opensAt: '18:00', closesAt: '19:00' },
          ],
        }}
        tenantSlug="spa-lumiere"
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Ouvert le lundi' }));
    await user.click(screen.getByRole('checkbox', { name: 'Ouvert le lundi' }));

    expect(
      (
        await screen.findByRole<HTMLInputElement>('textbox', { name: 'Ouverture 1 du lundi' })
      ).value,
    ).toBe('09:00');

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
    });
    expect(savedWeek()).toEqual([{ weekday: 1, opensAt: '09:00', closesAt: '12:00' }]);
  });

  it('nomme le fuseau du salon sous les champs, et non « votre horloge »', () => {
    // README §3 : toutes les heures affichées sont dans le fuseau du salon,
    // « écrit en clair dans le pied de la barre latérale et sous les champs
    // d'horaire ». « Heures de votre horloge » désignait celle du navigateur —
    // c'est-à-dire celle de qui regarde l'écran, pas celle du salon.
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    const mention = screen.getByText(/fuseau du salon/);

    expect(mention.textContent).toContain('Indian/Antananarivo');
    expect(screen.queryByText(/votre horloge/)).toBeNull();

    // « Sous les champs » : la grille précède la mention dans le document.
    const grille = document.querySelector('.spa-admin-schedule');

    expect(grille).not.toBeNull();
    expect(grille?.compareDocumentPosition(mention)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('le verdict d’enregistrement — où il se pose', () => {
  /**
   * Soumet le formulaire tel qu'il est pré-rempli et rend l'encart affiché.
   *
   * Les valeurs par défaut du `tenant` d'essai sont valides — un nom, aucune
   * adresse, une semaine à coupure —, donc le clic part sans qu'on ait à saisir
   * quoi que ce soit : ce qui est mesuré ici est la place du verdict, pas la
   * validation.
   */
  async function submitAndRead(title: string): Promise<Element> {
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const heading = await screen.findByText(title);
    const notice = heading.closest('.spa-notification');

    if (notice === null) {
      throw new Error(`aucun encart de notification autour de « ${title} »`);
    }

    return notice;
  }

  /** Le bouton de soumission, typé — on lit son `form`. */
  function submitButton(): HTMLButtonElement {
    return screen.getByRole<HTMLButtonElement>('button', { name: 'Enregistrer' });
  }

  it('rend la confirmation contre le bouton qui vient d’être cliqué', async () => {
    // La mesure du constat de QA : l'encart était peint à quelque 2 400 px
    // au-dessus du bouton, pour une fenêtre de 900 px — après le clic, l'écran
    // était strictement identique (#635). Une distance en pixels ne se mesure
    // pas sous jsdom, qui ne dispose rien ; la position dans le document, si —
    // et c'est elle qui la produit. Être le frère immédiatement précédent du
    // bouton, à l'intérieur du même formulaire, c'est être dans le même champ de
    // vision que lui, quelle que soit la taille de la fenêtre.
    updateTenantSettingsAction.mockResolvedValue({ ok: true });

    const notice = await submitAndRead('Réglages enregistrés');
    const submit = submitButton();

    expect(notice.closest('form')).toBe(submit.form);
    expect(submit.previousElementSibling).toBe(notice.parentElement);
  });

  it('pose le focus sur le verdict, pour l’amener dans la fenêtre et le faire lire', async () => {
    // Le clic peut venir d'un formulaire laissé à mi-course, ou d'un « Entrée »
    // au clavier. Le focus est ce qui, dans les deux cas, amène l'encart sous
    // les yeux sans dépendre de la seule adjacence — et ce qui le fait annoncer
    // par un lecteur d'écran au lieu d'attendre une pause de lecture.
    updateTenantSettingsAction.mockResolvedValue({ ok: true });

    const notice = await submitAndRead('Réglages enregistrés');

    await waitFor(() => {
      expect(document.activeElement).toBe(notice.parentElement);
    });
  });

  it('pose l’échec au même endroit que le succès', async () => {
    // Un refus renvoyé en tête de page aurait exactement le défaut qu'on corrige,
    // en pire : il faut agir dessus. Les deux tons partagent donc l'emplacement.
    updateTenantSettingsAction.mockResolvedValue({
      ok: false,
      message: 'Le code postal saisi est refusé.',
    });

    const notice = await submitAndRead('L’enregistrement a échoué');

    expect(notice.textContent).toContain('Le code postal saisi est refusé.');
    expect(submitButton().previousElementSibling).toBe(notice.parentElement);
  });

  it('retire la confirmation quand la soumission suivante est refusée par la validation', async () => {
    // Le défaut qu'ouvrait le déplacement : `handleSubmit` n'appelle pas son
    // rappel quand un champ est invalide, donc rien n'effaçait le verdict
    // précédent. Le « Réglages enregistrés » d'il y a une minute restait peint à
    // deux centimètres du bouton, à affirmer qu'on venait d'enregistrer — alors
    // que rien n'était parti.
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await screen.findByText('Réglages enregistrés');

    await user.clear(screen.getByLabelText(/Nom de l’établissement/));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(screen.queryByText('Réglages enregistrés')).toBeNull();
    });
    // Un seul appel : la seconde soumission n'a rien envoyé.
    expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
  });

  it('repose le focus quand le même refus se répète', async () => {
    // Deux refus au message identique sont deux verdicts, pas un seul. Tant que
    // le verdict tenait dans deux `useState`, le `null` de remise à zéro et le
    // message tombaient dans le même lot de rendu sur les chemins de validation
    // locale : la dépendance de l'effet ne bougeait pas, le focus ne se reposait
    // pas, et un lecteur d'écran n'annonçait rien du tout la seconde fois.
    const user = userEvent.setup();
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    // Deux plages du lundi qui se recouvrent : le seul refus que le schéma du
    // formulaire ne voit pas — il porte sur la semaine entière — et donc le
    // chemin synchrone, sans appel au serveur, qui portait le défaut.
    await user.clear(screen.getByLabelText('Ouverture 2 du lundi'));
    await user.type(screen.getByLabelText('Ouverture 2 du lundi'), '10:00');
    await user.clear(screen.getByLabelText('Fermeture 2 du lundi'));
    await user.type(screen.getByLabelText('Fermeture 2 du lundi'), '13:00');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const heading = await screen.findByText('L’enregistrement a échoué');
    const verdict = heading.closest('.spa-notification')?.parentElement;

    await waitFor(() => {
      expect(document.activeElement).toBe(verdict);
    });

    // Le second clic repart du bouton, et le refus est mot pour mot le même.
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByText('L’enregistrement a échoué').closest('.spa-notification')?.parentElement,
      );
    });
    expect(updateTenantSettingsAction).not.toHaveBeenCalled();
  });
});
