import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import type { AccountPresence } from '@/lib/account-presence';
import { emptyBookingDraft, type ContactDraft } from '@/lib/booking/draft';

afterEach(cleanup);

/**
 * Ce qui distingue un rendu d'un autre — tout est facultatif, et chaque défaut
 * est l'état sous lequel les assertions antérieures ont été écrites. Les cas qui
 * s'en écartent le nomment.
 */
interface RenderOptions {
  /**
   * `null` par défaut — l'établissement qui n'a pas publié son adresse (#1028).
   * Un numéro national y reste refusé, et l'aide y annonce le format
   * international.
   */
  readonly countryCode?: string | null;
  /**
   * La cliente connectée, telle que la page l'a lue du cookie de présence
   * (#1050, élargi aux coordonnées par #1086). `null` par défaut : la visiteuse
   * sans compte est l'état sous lequel toutes les assertions antérieures ont été
   * écrites, et le chemin par défaut du CDC §1.4.
   */
  readonly presence?: AccountPresence | null;
  /** Le brouillon déjà posé — vierge sauf mention contraire. */
  readonly contact?: ContactDraft;
}

function renderContactStep({
  countryCode = null,
  presence = null,
  contact = emptyBookingDraft().contact,
}: RenderOptions = {}) {
  const onSubmit = vi.fn();
  const onSave = vi.fn();
  const onBack = vi.fn();

  render(
    <ContactStep
      contact={contact}
      tenantSlug="salon-zen"
      countryCode={countryCode}
      // Le rappel de la barre basse (#1047) : cette suite éprouve la saisie, et
      // rien à rappeler est un état que l'étape sait rendre.
      summary={null}
      presence={presence}
      loginHref="/salon-zen/compte/connexion"
      onSave={onSave}
      onBack={onBack}
      onSubmit={onSubmit}
    />,
  );

  return { onSubmit, onSave, onBack, user: userEvent.setup() };
}

/**
 * Ce qu'il faut poser pour que l'étape accepte la soumission.
 *
 * La case de consentement en fait partie depuis #734 : elle est bloquante, et
 * une saisie « valide » qui l'oublierait ne l'est pas. Ce que cette case refuse
 * et ce qu'elle annonce est éprouvé à part, par `booking-consent.test.tsx` —
 * ici elle n'est qu'un préalable, comme le nom et l'adresse.
 */
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  await user.click(screen.getByRole('checkbox'));
}

/**
 * #1050 puis #1086 — l'étape s'ouvrait sur cinq champs vides à une cliente
 * connectée, dont trois que le compte connaît. `BM-COMPTE-01` demande l'inverse :
 * la cliente connectée doit le savoir, et ne pas retaper ce qu'elle a déjà donné.
 *
 * #1050 a résumé le prénom et le nom ; l'adresse e-mail restait à saisir, faute
 * d'être portée par le cookie de présence — et le premier critère du ticket,
 * *« connectée, l'étape se valide sans rien saisir »*, tombait sur ce champ
 * requis. #1086 élargit le cookie à l'adresse et au numéro, et c'est cette
 * dernière moitié que la suite tient désormais.
 *
 * Ce que cette suite tient :
 *
 * - les coordonnées du compte sont **résumées** et non redemandées — c'est le
 *   défaut, et l'étape se valide sans qu'un seul champ soit touché ;
 * - elles restent **corrigibles** : « Modifier » rouvre les champs, préremplis,
 *   et le focus les suit ;
 * - la saisie de la cliente **l'emporte** sur le compte : revenir du créneau ne
 *   fait pas repartir un nom corrigé ;
 * - un champ que le compte ne renseigne pas **reste ouvert** plutôt que d'être
 *   replié derrière un encart qui ne le résume pas ;
 * - rien ne change pour qui n'est pas connectée, troisième critère du ticket.
 */
describe('la cliente connectée ne retape pas ses coordonnées (#1050, #1086)', () => {
  const alice: AccountPresence = {
    firstName: 'Alice',
    lastName: 'Marchand',
    email: 'alice@example.test',
    phone: '+261341234567',
  };

  it('résume les coordonnées du compte au lieu d’en redemander les champs', () => {
    renderContactStep({ presence: alice });

    expect(screen.getByText('Alice Marchand')).toBeDefined();
    // L'adresse et le numéro sur la ligne que l'audit `d20260918-1` dessine sous
    // le nom : c'est là que part la confirmation, et une cliente qui ne la voit
    // pas ne peut pas corriger l'adresse d'un compte ouvert il y a deux ans.
    // Le numéro au format international lisible, comme partout où il est
    // affiché (#825) — l'E.164 brut est fait pour une machine.
    expect(screen.getByText('alice@example.test · +261 34 12 345 67')).toBeDefined();
    // Les champs existent toujours — ils portent la valeur qui sera soumise —
    // mais `hidden` les retire de l'arbre d'accessibilité comme de l'ordre de
    // tabulation : un champ requis invisible et focalisable serait un piège.
    // D'où la recherche par rôle, la seule qui tienne compte de l'accessibilité
    // — `getByLabelText` trouverait un champ que personne ne peut atteindre.
    expect(screen.queryByRole('textbox', { name: /Prénom/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Adresse e-mail/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Téléphone/ })).toBeNull();
    expect(document.querySelector<HTMLInputElement>('#firstName')?.value).toBe('Alice');
    expect(document.querySelector<HTMLInputElement>('#lastName')?.value).toBe('Marchand');
    expect(document.querySelector<HTMLInputElement>('#email')?.value).toBe('alice@example.test');
    // Relu au format national du pays qui le porte, derrière son drapeau.
    expect(document.querySelector<HTMLInputElement>('#phone')?.value).toBe('034 12 345 67');
  });

  /**
   * Le premier critère de #1050, enfin tenu : **rien n'est saisi**.
   *
   * Le consentement reste à cocher, et ce n'est pas une saisie — `BM-TUNNEL-06`
   * exige une case décochée, distincte de la réservation elle-même (RGPD). C'est
   * le seul geste qui subsiste, et il est délibéré.
   */
  it('se valide sans qu’un seul champ soit saisi', async () => {
    const { onSubmit, user } = renderContactStep({ presence: alice });

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@example.test',
      phone: '+261341234567',
    });
  });

  it('rouvre les champs préremplis sur « Modifier », et y pose le focus', async () => {
    const { user } = renderContactStep({ presence: alice });

    await user.click(screen.getByRole('button', { name: /Modifier/ }));

    const prenom = screen.getByLabelText<HTMLInputElement>(/Prénom/);

    expect(prenom.value).toBe('Alice');
    expect(screen.getByLabelText<HTMLInputElement>(/^Nom/).value).toBe('Marchand');
    // Les quatre champs repliés se rouvrent d'un bloc : « Modifier » ne
    // promet pas de corriger le nom seul.
    expect(screen.getByLabelText<HTMLInputElement>(/Adresse e-mail/).value).toBe(
      'alice@example.test',
    );
    expect(screen.getByLabelText<HTMLInputElement>(/Téléphone/).value).toBe('034 12 345 67');
    // Le bouton cliqué disparaît avec l'encart : sans ce rattrapage, le focus
    // retomberait sur `<body>` et la tabulation repartirait du haut du document
    // (skill web-frontend §7).
    expect(document.activeElement).toBe(prenom);
    // Et le résumé s'efface : deux réponses à la même question sur un écran en
    // seraient une de trop.
    expect(screen.queryByText('Alice Marchand')).toBeNull();
  });

  it('laisse la saisie de la cliente l’emporter sur le nom du compte', () => {
    // Le brouillon d'une cliente qui a corrigé son nom, puis est repartie
    // changer de créneau : au retour, c'est le sien qu'elle doit retrouver.
    renderContactStep({
      presence: alice,
      contact: { ...emptyBookingDraft().contact, firstName: 'Alix', lastName: 'Marchand' },
    });

    expect(document.querySelector<HTMLInputElement>('#firstName')?.value).toBe('Alix');
    // Et l'encart dit ce qui sera réservé, pas ce que le compte connaît :
    // afficher « Alice Marchand » au-dessus d'un formulaire qui porte « Alix »
    // annoncerait une réservation à un autre nom que celui qui partira.
    expect(screen.getByText('Alix Marchand')).toBeDefined();
    expect(screen.queryByText('Alice Marchand')).toBeNull();
  });

  it('ouvre les champs quand le compte n’a pas de nom de famille', () => {
    // `account-presence.ts` accepte un nom vide là où `nameSchema` l'exige :
    // résumer « Réservé au nom de Alice » cacherait un champ requis derrière un
    // encart qui prétend le remplir, et la soumission échouerait sans rien dire.
    renderContactStep({ presence: { ...alice, lastName: '' } });

    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe('Alice');
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
  });

  /**
   * Le cookie posé **avant #1086** ne porte pas d'adresse, et `parsePresence` la
   * relit à la chaîne vide plutôt que de rejeter le cookie entier — sans quoi
   * toutes les clientes connectées à l'instant du déploiement cesseraient d'être
   * saluées. L'étape doit alors se comporter comme sous #1050 : le nom résumé
   * cacherait un champ requis vide, donc les champs s'ouvrent.
   */
  it('ouvre les champs quand le cookie ne porte pas encore d’adresse', () => {
    renderContactStep({ presence: { ...alice, email: '', phone: '' } });

    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe('Alice');
    expect(screen.getByLabelText<HTMLInputElement>(/Adresse e-mail/).value).toBe('');
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
  });

  /**
   * `sessionUserSchema` porte `phone` à `null`, et c'est le cas courant : le
   * numéro est facultatif à l'inscription.
   *
   * L'audit dit « déplie les champs pré-remplis » — ce qui se replie est ce que
   * l'encart résume. Replier un téléphone vide cacherait derrière « Modifier »
   * le seul choix qui reste à la cliente connectée, et c'est celui qui lui vaut
   * le rappel par SMS (CDC §1.4).
   */
  it('laisse le téléphone ouvert quand le compte n’en connaît pas', () => {
    renderContactStep({ presence: { ...alice, phone: '' } });

    // Le reste est bien résumé : c'est le téléphone seul qui reste à l'écran.
    expect(screen.getByText('Alice Marchand')).toBeDefined();
    expect(screen.getByText('alice@example.test')).toBeDefined();
    expect(screen.queryByRole('textbox', { name: /Adresse e-mail/ })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>(/Téléphone/).value).toBe('');
  });

  /**
   * Le téléphone est le seul des quatre dont la chaîne vide est une valeur
   * **valable** : `contactFormSchemaFor` l'accepte telle quelle.
   *
   * Le compléter comme les trois champs requis rendrait son numéro à la cliente
   * qui vient de l'effacer — et le replierait derrière « Modifier », puisque
   * l'encart le résumerait de nouveau. Elle repartirait au récapitulatif avec le
   * rappel par SMS qu'elle venait de refuser, sans qu'un champ à l'écran le
   * dise. La complétion ne vaut donc que pour un brouillon **vierge**, seul état
   * où un champ vide est une absence et non un choix.
   */
  it('ne rend pas le numéro que la cliente vient d’effacer', () => {
    // Le brouillon d'une cliente qui a rouvert l'encart, vidé le téléphone, puis
    // est repartie changer de créneau.
    renderContactStep({
      presence: alice,
      contact: {
        ...emptyBookingDraft().contact,
        firstName: 'Alice',
        lastName: 'Marchand',
        email: 'alice@example.test',
        phone: '',
      },
    });

    expect(document.querySelector<HTMLInputElement>('#phone')?.value).toBe('');
    // Et le champ reste ouvert : l'encart ne résume pas ce qu'il ne porte pas.
    expect(screen.getByLabelText<HTMLInputElement>(/Téléphone/).value).toBe('');
    expect(screen.getByText('alice@example.test')).toBeDefined();
  });

  /**
   * Un numéro que le compte porte mais que le pays de l'établissement ne permet
   * pas de compléter est refusé par `e164PhoneSchemaFor` comme n'importe quelle
   * saisie. Replié, son message serait rendu dans un groupe masqué : le
   * formulaire refuserait de partir sans que rien à l'écran dise pourquoi.
   */
  it('rouvre l’encart quand un champ replié est refusé à la soumission', async () => {
    const { onSubmit, user } = renderContactStep({
      presence: { ...alice, phone: '0341234567' },
    });

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    // L'encart s'est effacé au profit des champs, et le message est sur le sien.
    expect(screen.queryByText('Alice Marchand')).toBeNull();
    const telephone = screen.getByLabelText(/Téléphone/);
    expect(telephone.getAttribute('aria-invalid')).toBe('true');
    expect(telephone.getAttribute('aria-describedby')).toContain(
      screen.getByRole('alert').id,
    );
  });

  it('ne change rien pour la réservation sans compte', () => {
    renderContactStep();

    // Deuxième critère du ticket : les cinq champs, et aucun encart d'identité.
    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe('');
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
    // À la place, l'entrée de celle qui a déjà un compte (BM-COMPTE-01) — en
    // tête d'étape, avant le premier champ qu'elle évite de remplir.
    expect(
      screen.getByRole('link', { name: /Se connecter/ }).getAttribute('href'),
    ).toBe('/salon-zen/compte/connexion');
  });

  it('ne propose pas de se connecter à qui l’est déjà', () => {
    renderContactStep({ presence: alice });

    expect(screen.queryByRole('link', { name: /Se connecter/ })).toBeNull();
  });
});

describe('la saisie part au brouillon avant la soumission', () => {
  it('verse ce qui a été tapé dès qu’un champ est quitté', async () => {
    const { onSave, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    // Passer au champ suivant suffit : sans ce report, le formulaire étant non
    // contrôlé, la saisie ne vivrait que dans le DOM et un rafraîchissement
    // l'emporterait — le troisième critère de #45 tomberait sur cette étape.
    await user.tab();

    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ firstName: 'Camille' });
  });

  it('le retour au créneau n’abandonne pas la saisie', async () => {
    const { onSave, onBack, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.click(screen.getByRole('button', { name: /Changer de créneau/ }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ firstName: 'Camille' });
  });
});

describe('formulaire de coordonnées', () => {
  it('accepte une saisie valide sans téléphone — l’e-mail est le canal obligatoire', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '',
    });
  });

  /**
   * Sans pays d'établissement, le champ part des États-Unis (#825) — et le
   * refus le dit : il nomme le pays du drapeau, que la cliente voit à côté du
   * numéro, et propose d'en changer.
   *
   * C'est ce que #626 n'autorisait pas, et pour une raison qui ne tient plus :
   * l'indicatif écrit en dur était celui de Madagascar, proposé à n'importe
   * quel salon. Celui du message est désormais celui qu'affiche le drapeau.
   */
  it('refuse sur le champ un numéro que le pays du drapeau ne connaît pas, en le nommant', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '0341234567');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();

    const message = screen.getByRole('alert');

    expect(message.textContent).toContain('(États-Unis, +1)');
    expect(message.textContent).toContain('changez de pays');
    // Le message est rattaché au champ, pas posé en bloc en haut de page.
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-describedby')).toContain(
      message.id,
    );
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-invalid')).toBe('true');
  });

  /**
   * #626 — l'aide donnait « Format international, +261… », l'indicatif de
   * Madagascar, à la cliente de n'importe quel salon, y compris lyonnais.
   *
   * Le test porte sur l'**absence d'indicatif**, pas sur la formule retenue :
   * un indicatif de pays s'écrit toujours `+` suivi d'un chiffre, et c'est ce
   * motif-là qui ne doit pas reparaître dans l'aide. Depuis #825, l'aide ne dit
   * plus du tout la forme attendue : le drapeau et l'exemple du pays choisi la
   * montrent.
   */
  it('ne donne l’indicatif d’aucun pays dans l’aide du champ', () => {
    renderContactStep({ countryCode: 'FR' });

    const hint = document.getElementById('phone-hint');

    expect(hint?.textContent).toMatch(/rappel par SMS/);
    expect(hint?.textContent).not.toMatch(/\+\s?\d/);
  });

  /**
   * Le défaut de #1028, vu du formulaire : un numéro national est accepté sur
   * un salon qui a un pays. Depuis #825, le brouillon en garde l'E.164 — c'est
   * ce que le champ émet, et c'est ce qu'il relit derrière le bon drapeau au
   * retour vers cette étape.
   */
  it('accepte un numéro national quand l’établissement a un pays', async () => {
    const { onSubmit, user } = renderContactStep({ countryCode: 'FR' });

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '06 12 34 56 78');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ phone: '+33612345678' });
  });

  it('part du pays de l’établissement, avec un exemple de ce pays', () => {
    renderContactStep({ countryCode: 'FR' });

    expect(screen.getByRole('button', { name: /France \(\+33\)/ })).toBeDefined();
    expect(screen.getByLabelText(/Téléphone/).getAttribute('placeholder')).toMatch(/^06/);
  });

  it('accepte un numéro international écrit avec des espaces', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '+261 34 12 345 67');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Le « + » a basculé le drapeau sur Madagascar, et la valeur est l'E.164.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ phone: '+261341234567' });
  });

  it('refuse une adresse e-mail mal formée', async () => {
    const { onSubmit, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille');
    // Cochée pour que le seul message attendu ci-dessous soit celui de l'adresse.
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('e-mail');
  });
});

/**
 * #748 — « Un mot pour le salon » se saisissait dans un `<input>` d'une ligne,
 * alors que son contrat est `longTextSchema` et que le design system fournit
 * `components/ui/textarea.tsx` pour exactement cet usage. À 360 px, une phrase
 * d'allergie défilait dans le champ : la cliente ne pouvait plus relire le début
 * de ce qu'elle venait d'écrire.
 *
 * Ce qui est éprouvé ici est la **nature du contrôle**, pas sa mise en forme :
 * c'est elle qui décide si la saisie tient sur plusieurs lignes, et c'est la
 * seule chose qu'un `<input>` ne saura jamais faire.
 */
describe('« Un mot pour le salon »', () => {
  function champDuMot(): HTMLTextAreaElement {
    return screen.getByLabelText<HTMLTextAreaElement>(/Un mot pour le salon/);
  }

  it('se saisit dans un champ multiligne du design system', () => {
    renderContactStep();

    const champ = champDuMot();

    expect(champ.tagName).toBe('TEXTAREA');
    // Plus d'une ligne visible : sans cela, le `<textarea>` ferait défiler la
    // saisie tout comme l'`<input>` qu'il remplace, et le ticket ne serait pas
    // traité.
    expect(champ.rows).toBeGreaterThan(1);
    // `TextArea` ne déclare aucun style propre : il porte les classes de
    // `.spa-field`, donc le même cadre et le même contraste que les quatre
    // champs d'une ligne au-dessus de lui.
    expect(champ.className).toContain('spa-field__control');
  });

  it('conserve un mot écrit sur plusieurs lignes jusqu’à la soumission', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(champDuMot(), 'Allergie aux huiles essentielles.{enter}Je serai peut-être en retard.');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Le saut de ligne fait foi : un `<input>` l'aurait avalé, et la touche
    // « Entrée » y aurait soumis le formulaire au lieu d'aérer la note.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      clientNote: 'Allergie aux huiles essentielles.\nJe serai peut-être en retard.',
    });
  });
});
