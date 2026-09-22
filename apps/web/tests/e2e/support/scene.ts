/**
 * Le `test` de la suite E2E, et les gestes du parcours écrits une fois.
 *
 * ## Deux fixtures, deux besoins distincts
 *
 * - `jeu` — le référentiel posé par l'amorçage global. Chaque suite en a besoin
 *   et aucune n'a à savoir où il est écrit.
 * - `traficReseau` — la liste des URL que le navigateur a jointes. C'est elle
 *   qui rend démontrable, et non simplement affirmée, la propriété « aucun appel
 *   au prestataire de paiement » du règlement en espèces.
 *
 * ## Pourquoi les gestes sont ici et non dans les suites
 *
 * Le tunnel de réservation est joué par trois scénarios. Écrit trois fois, il se
 * corrigerait deux fois sur trois au premier changement de libellé — et la
 * troisième suite rougirait pour une raison sans rapport avec ce qu'elle
 * éprouve. Il est donc écrit une fois, en `test.step` : les étapes nommées ici
 * sont exactement celles que le rapport d'échec désignera.
 */

import type { Locale } from '@spa/shared';
import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { CLIENTE, MOT_DE_PASSE, chemins, dansNJours } from './environnement';
import { lireJeuDessai, type JeuDessai } from './jeu-dessai';
import { debuteParLibelle, libelle } from './libelles';

export interface Fixtures {
  readonly jeu: JeuDessai;
  /** Les URL jointes par le navigateur depuis le début du test. */
  readonly traficReseau: string[];
}

/**
 * Le second paramètre d'une fixture Playwright s'appelle `use` par convention.
 * Il est nommé `fournir` ici, et ce n'est pas une coquetterie : `eslint-plugin-
 * react-hooks` prend tout appel à `use(...)` pour le hook React du même nom, et
 * refuse de le voir hors d'un composant. Le renommer coûte moins qu'une
 * désactivation de règle sur chaque fixture — et se lit mieux.
 */
export const test = base.extend<Fixtures>({
  // Le motif vide est la forme qu'impose Playwright pour une fixture qui ne
  // dépend d'aucune autre : c'est lui qui déclare l'absence de dépendance.
  // eslint-disable-next-line no-empty-pattern
  jeu: async ({}, fournir) => {
    await fournir(lireJeuDessai());
  },

  traficReseau: async ({ page }, fournir) => {
    const urls: string[] = [];
    page.on('request', (requete) => urls.push(requete.url()));
    await fournir(urls);
  },
});

export { expect };

/** Le premier jour ouvert aux scénarios du comptoir. */
const PREMIER_JOUR_SCENARIO = 5;

/** Le nombre de jours qu'une passe complète de la suite consomme. */
const JOURS_PAR_PASSE = 6;

/**
 * Le jour de travail d'un scénario — **décalé à chaque nouvelle tentative**.
 *
 * Le jeu d'essai fait table rase une seule fois, dans l'amorçage global : une
 * seconde tentative retrouve donc tout ce que la première a écrit. Sur un jour
 * figé, cela rendait les reprises de `retries` incapables de passer, et pour des
 * raisons qui n'accusaient rien de réel : « création manuelle » compte les blocs
 * du planning (`toHaveCount(1)`, la journée partant vide depuis #507) et en
 * aurait vu un de plus à chaque tentative ; « report » vise 16:00,
 * que la tentative précédente occupe déjà, et le déplacement se heurterait à la
 * contrainte d'exclusion. Une reprise qui échoue toujours n'est pas une reprise
 * — c'est un échec plus lent, doublé d'un message trompeur.
 *
 * Décaler d'une passe entière par tentative rend chaque essai aussi vierge que
 * le premier. Trois tentatives au plus mènent à J+22, sous les J+29 que la
 * fenêtre de `trouverRendezVous` couvre.
 *
 * @param rang Le rang du scénario, de 0 à `JOURS_PAR_PASSE - 1`. Deux scénarios
 * ne doivent jamais porter le même : ils se disputeraient l'agenda.
 */
export function jourDuScenario(rang: number): string {
  return dansNJours(PREMIER_JOUR_SCENARIO + rang + test.info().retry * JOURS_PAR_PASSE);
}

/** L'identité saisie dans le tunnel, et retrouvée au comptoir. */
export interface Reservation {
  readonly identifiant: string;
}

/**
 * Les lignes de prestation du tunnel — un `radiogroup` depuis #741.
 *
 * L'étape 1 était un `<select>`, et le désigner demandait un `getByLabel`
 * **exact** : la vitrine porte une section dont `aria-labelledby` vise le titre
 * « Nos prestations » (`components/salon/service-catalog.tsx`), et un nom non
 * exact la capturait. L'assertion d'étape passait alors sur la vitrine — une
 * `<section>` est toujours « enabled » —, et la faute n'apparaissait qu'à
 * l'étape suivante.
 *
 * Le rôle règle la question à la racine : une `<section>` n'est pas un `radio`,
 * et le groupe ne peut désigner que le tunnel. `waitForURL` reste malgré tout,
 * pour que l'étape 1 ne conclue pas avant la navigation.
 *
 * Les rubriques étant des onglets depuis #1048, les panneaux fermés gardent
 * leurs lignes dans le document : `getByRole` les écarte de lui-même, un
 * panneau `hidden` ne figurant pas dans l'arbre d'accessibilité.
 */
function cartesPrestation(page: Page): Locator {
  return page.getByRole('radio');
}

/**
 * La ligne entière — c'est elle qu'on touche, et non la pastille (#1048).
 *
 * `check()` visait le bouton radio, que #1048 a décalé hors de l'écran : il
 * mesure 1 px, et le `<label>` qui l'enveloppe intercepte le clic. Playwright
 * réessayait alors jusqu'au délai, et le parcours critique tombait sur
 * « `<span class="spa-booking__service-name">` intercepts pointer events » —
 * c'est-à-dire sur le comportement voulu, décrit du point de vue de l'outil.
 *
 * Une cliente ne vise pas une pastille de 1 px : elle touche la ligne. Le test
 * fait désormais le même geste, et `check()` n'a plus de raison d'être ici —
 * `force: true` masquerait au contraire la moindre régression qui rendrait la
 * ligne inerte.
 */
function ligneDe(carte: Locator): Locator {
  return carte.locator('xpath=ancestor::label[1]');
}

/**
 * Le tunnel client, de la vitrine à la confirmation — sans aucun raccourci.
 *
 * Chaque écran est franchi comme le ferait une cliente : c'est la partie du
 * parcours qui n'a le droit de rien devoir à l'API.
 *
 * ## Les libellés viennent du catalogue (#846)
 *
 * Le parcours public se sert en français et en anglais, et le huitième critère
 * d'acceptation de #846 demande que **le même scénario** passe dans les deux.
 * Les cibles sont donc désignées par clé de catalogue (`support/libelles.ts`) et
 * non par une chaîne écrite ici : une scène qui chercherait « Choisir un
 * créneau » ne décrirait plus le produit, mais une de ses deux langues.
 *
 * `langue` est ce que le navigateur annonce — `test.use({ locale })` — et donc
 * ce que la résolution de `i18n/resolve.ts` va servir : les deux doivent
 * s'accorder, sinon la scène cherche des libellés que l'écran n'affiche pas.
 *
 * **Deux écrans font exception**, et c'est écrit à l'endroit où on les
 * traverse : la connexion et l'inscription de l'espace client ne sont pas
 * encore traduites — c'est leur propre ticket de l'épique #843.
 */
export async function reserverParLeTunnel(page: Page, langue: Locale = 'fr'): Promise<Reservation> {
  await test.step('1. Vitrine — entrer dans le tunnel', async () => {
    await page.goto(chemins.salon());
    // Le bouton de la vitrine, dans le contenu : l'en-tête et le pied du salon
    // portent aussi un « Prendre rendez-vous » depuis #1045. Son libellé est
    // celui du registre des sorties publiques (#749), namespace `public-exits`.
    await page
      .getByRole('main')
      .getByRole('link', { name: libelle(langue, 'public-exits.exits.reservation') })
      .click();
    // La navigation d'abord : sans elle, l'étape se conclurait sur la vitrine,
    // et la faute apparaîtrait deux étapes plus loin (voir `cartesPrestation`).
    await page.waitForURL(`**${chemins.reservation()}`);
    await expect(cartesPrestation(page).first()).toBeEnabled();
  });

  await test.step('2. Prestation — choisir le soin', async () => {
    // Par rang et non par libellé : le nom accessible d'une ligne porte la durée
    // et le prix formatés en `fr-FR`, dont l'espace insécable avant « € » varie
    // d'une version d'ICU à l'autre. La première ligne suffit — le parcours
    // n'éprouve pas *quelle* prestation est retenue, mais qu'elle le soit.
    const premiere = cartesPrestation(page).first();

    await ligneDe(premiere).click();
    // Le clic a bien coché la ligne, et ce n'est pas une redite du `click()` :
    // c'est ce qui distingue « la ligne a reçu le clic » de « la ligne a coché
    // son contrôle ». Sans cette assertion, une ligne redevenue inerte laisserait
    // le parcours échouer une étape plus loin, sur un CTA désactivé.
    await expect(premiere).toBeChecked();
    // Le praticien reste « Premier disponible », retenu d'emblée : le parcours
    // n'éprouve pas *quel* praticien est choisi, et le laisser tel quel est le
    // chemin de la cliente qui n'a pas de préférence.
    await page
      .getByRole('button', { name: libelle(langue, 'booking.tunnel.serviceStep.submit') })
      .click();
  });

  await test.step('3. Créneau — retenir le premier jour ouvert de la bande', async () => {
    const etape = page.getByRole('region', {
      name: libelle(langue, 'booking.tunnel.slotStep.label'),
    });
    await expect(etape).toBeVisible();

    // Le choix de la date est une **bande de jours** depuis #1049, le mois
    // complet ne s'ouvrant qu'à la demande dans un panneau (`BM-CRENEAU-01`).
    // Deux `grid` cohabitent donc dans l'étape, et chacune se désigne par son nom
    // accessible plutôt que par son rang : la bande s'appelle « Jour du
    // rendez-vous — <mois> », la grille d'heures « Créneaux du <jour> ».
    const bande = etape.getByRole('grid', {
      name: debuteParLibelle(langue, 'booking.tunnel.dateBand.gridLabel'),
    });
    await expect(bande).toBeVisible({ timeout: 20_000 });

    // Les journées pleines, hors fenêtre ou encore en chargement portent
    // `aria-disabled` (`components/booking/date-band.tsx`). C'est ce qui les
    // écarte ici — et non plus le décompte en toutes lettres qui fermait leur
    // nom accessible : ce décompte est une forme plurielle du catalogue, donc
    // une chaîne différente dans chaque langue, là où l'attribut est le même.
    const jourOuvert = bande.locator('button:not([aria-disabled="true"])').first();
    await expect(jourOuvert).toBeVisible({ timeout: 20_000 });
    await jourOuvert.click();

    // La grille d'heures, elle, se nomme par la journée qu'elle détaille : seule
    // sa tête est un libellé, la date qui suit vient d'`Intl`.
    const creneau = etape
      .getByRole('grid', { name: debuteParLibelle(langue, 'booking.tunnel.slotPicker.dayHeading') })
      .getByRole('gridcell')
      .locator('button')
      .first();
    await expect(creneau).toBeVisible();
    await creneau.click();
  });

  await test.step('4. Identification — se connecter pour réserver', async () => {
    // Réserver exige un compte depuis le 2026-09-22 : sans session, le tunnel
    // s'arrête ici, le créneau rappelé, et mène à la connexion du salon. Le
    // lien est cherché dans le contenu : l'en-tête du tunnel n'en porte pas,
    // mais c'est ce qui le garantit.
    await expect(
      page.getByRole('heading', { level: 1, name: libelle(langue, 'booking.tunnel.gateStep.title') }),
    ).toBeVisible();
    await page
      .getByRole('main')
      .getByRole('link', { name: libelle(langue, 'booking.tunnel.gateStep.signIn') })
      .click();

    // **Libellés français en dur, et c'est voulu** : l'écran de connexion de
    // l'espace client n'est pas dans l'empreinte de #846 — il a son propre
    // ticket dans l'épique #843, avec son propre namespace. Tant qu'il n'est pas
    // traduit, il s'affiche en français quelle que soit la langue résolue, et
    // c'est bien ce que la scène doit traverser. Ces trois lignes passeront au
    // catalogue avec lui.
    await page.getByLabel('Adresse e-mail').fill(CLIENTE.email);
    await page.getByLabel('Mot de passe').fill(MOT_DE_PASSE);
    await page.getByRole('button', { name: 'Se connecter' }).click();

    // Le retour au tunnel (#1087) : le brouillon de l'onglet est repris, et
    // l'étape s'ouvre sur l'encart du compte au lieu de ses champs (#1050).
    await page.waitForURL(`**${chemins.reservation()}**`);
    await expect(
      page.getByText(libelle(langue, 'booking.tunnel.contactStep.identityLabel')),
    ).toBeVisible({ timeout: 20_000 });
  });

  await test.step('5. Coordonnées — donner son accord', async () => {
    // Connectée, la cliente n'a rien à retaper : le compte a prérempli nom et
    // adresse. Reste le consentement de l'étape (#734, CDC §5.1) — la case est
    // décochée d'origine et retient la soumission tant qu'elle l'est. C'est le
    // seul `checkbox` de l'écran.
    await page.getByRole('checkbox').check();
    await page
      .getByRole('button', { name: libelle(langue, 'booking.tunnel.contactStep.submit') })
      .click();
  });

  await test.step('6. Récapitulatif — confirmer la réservation', async () => {
    const recapitulatif = page.getByRole('region', {
      name: libelle(langue, 'booking.tunnel.summaryStep.label'),
    });
    await expect(recapitulatif).toBeVisible();
    await page
      .getByRole('button', { name: libelle(langue, 'booking.tunnel.summaryStep.submit') })
      .click();
  });

  return test.step('7. Confirmation — relever la référence', async () => {
    const confirmation = page.getByRole('region', {
      name: libelle(langue, 'booking.tunnel.confirmationStep.label'),
    });
    await expect(confirmation).toBeVisible({ timeout: 20_000 });
    // L'issue annoncée est celle du statut **réel** (#1051) : un rendez-vous
    // public naît `PENDING` côté API (`appointments.repository.ts`), donc
    // « Demande envoyée » et non « C'est réservé ! », que seul un rendez-vous
    // déjà confirmé par le salon affiche.
    await expect(
      page.getByRole('heading', {
        name: libelle(langue, 'booking.tunnel.confirmationStep.pendingTitle'),
      }),
    ).toBeVisible();

    // Ce que la cliente lit : la référence courte du wireframe — Étape 6,
    // « Réf. RDV-8F3K-27 » (#736). L'écran rendait l'identifiant tel quel
    // jusque-là, et c'est de cette ligne que la scène le relevait.
    const reference = confirmation.locator('p.spa-booking__reference');
    await expect(reference).toBeVisible();

    const code = (await reference.locator('.spa-booking__reference-code').innerText()).trim();
    expect(code, `La référence affichée (« ${code} ») n'a pas la forme du wireframe.`).toMatch(
      /^RDV-[0-9A-Z]{4}-[0-9]{2}$/u,
    );

    // Ce dont la suite du parcours a besoin : l'identifiant, que la ligne porte
    // en attribut depuis qu'elle ne le montre plus. Les appels d'API du
    // comptoir — retrouver, confirmer, encaisser — travaillent sur lui, pas sur
    // la référence courte, qu'aucune route ne sait résoudre.
    const identifiant = (await reference.getAttribute('data-appointment-id'))?.trim() ?? '';
    expect(
      identifiant,
      "La ligne de référence ne porte pas d'identifiant exploitable en `data-appointment-id`.",
    ).toMatch(/^[0-9a-f-]{36}$/iu);

    return { identifiant };
  });
}

/**
 * Ouvre une session de comptoir.
 *
 * Le rang attendu est `MANAGER` depuis #812 : c'est le plus bas qui porte
 * `agenda:read:all`, et donc le plus bas qui ouvre le planning du salon. Voir
 * `COMPTES` dans `environnement.ts` pour la raison du déplacement.
 */
export async function connexionComptoir(page: Page, email: string): Promise<void> {
  await test.step('Comptoir — se connecter au back-office', async () => {
    await page.goto(chemins.connexionAdmin());
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe').fill(MOT_DE_PASSE);
    await page.getByRole('button', { name: 'Se connecter' }).click();

    // La connexion réussie dépose ce rang sur le planning — la première section
    // que le sommaire lui ouvre (#618) — et non plus sur les réglages, qu'un
    // rang sous `ADMIN` recevait en « Accès réservé ». Le repère qui dit que la
    // session est posée reste le rail, présent sur toutes ces destinations.
    await expect(
      page.getByRole('navigation', { name: 'Sections du tableau de bord' }),
    ).toBeVisible({ timeout: 20_000 });
  });
}

/** Le tiroir de rendez-vous du planning — `<aside>`, et non un `role="dialog"`. */
export function tiroir(page: Page): Locator {
  return page.locator('aside.spa-admin-panel');
}

/** Le bloc d'un rendez-vous sur la grille du planning. */
export function blocRendezVous(page: Page, nom: string): Locator {
  return page.locator('.spa-admin-calendar__event', { hasText: nom });
}
