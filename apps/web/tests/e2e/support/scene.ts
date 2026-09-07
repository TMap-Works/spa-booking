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

import { test as base, expect, type Locator, type Page } from '@playwright/test';

import { CLIENTE, MOT_DE_PASSE, chemins, dansNJours } from './environnement';
import { lireJeuDessai, type JeuDessai } from './jeu-dessai';

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
 * du planning (`toHaveCount(2)`) et en aurait vu trois ; « report » vise 16:00,
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
 * Le sélecteur de prestation du tunnel — et pourquoi il est `exact`.
 *
 * `getByLabel('Prestation')` cherche une sous-chaîne, et la **vitrine** porte
 * une section dont `aria-labelledby` désigne le titre « Nos prestations »
 * (`components/salon/service-catalog.tsx`). Le nom accessible de cette section
 * contient donc « Prestation », et le locator non exact la capturait.
 *
 * L'effet n'était pas un simple échec de sélecteur, il était pire : l'assertion
 * `toBeEnabled()` de l'étape 1 passait **sur la vitrine** — une `<section>` est
 * toujours « enabled » —, si bien que le tunnel n'était jamais attendu. Le test
 * n'échouait qu'à l'étape suivante, sur un « Element is not a `<select>` » qui
 * accusait la mauvaise étape. Un nom exact ne peut plus désigner la section, et
 * `waitForURL` ne laisse plus l'étape 1 conclure avant la navigation.
 */
function selecteurPrestation(page: Page): Locator {
  return page.getByLabel('Prestation', { exact: true });
}

/**
 * Le tunnel client, de la vitrine à la confirmation — sans aucun raccourci.
 *
 * Chaque écran est franchi comme le ferait une cliente : c'est la partie du
 * parcours qui n'a le droit de rien devoir à l'API.
 */
export async function reserverParLeTunnel(page: Page): Promise<Reservation> {
  await test.step('1. Vitrine — entrer dans le tunnel', async () => {
    await page.goto(chemins.salon());
    await page.getByRole('link', { name: 'Prendre rendez-vous' }).click();
    // La navigation d'abord : sans elle, l'étape se conclurait sur la vitrine,
    // et la faute apparaîtrait deux étapes plus loin (voir `selecteurPrestation`).
    await page.waitForURL(`**${chemins.reservation()}`);
    await expect(selecteurPrestation(page)).toBeEnabled();
  });

  await test.step('2. Prestation — choisir le soin', async () => {
    // Par index et non par libellé : l'intitulé de l'option porte la durée et le
    // prix formatés en `fr-FR`, dont l'espace insécable avant « € » varie d'une
    // version d'ICU à l'autre. L'index 1 est la première prestation réelle,
    // l'index 0 étant « Choisir une prestation… ».
    await selecteurPrestation(page).selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Choisir un créneau' }).click();
  });

  await test.step('3. Créneau — retenir le premier jour ouvert', async () => {
    const etape = page.getByRole('region', { name: 'Choix du praticien et du créneau' });
    await expect(etape).toBeVisible();

    // Les journées pleines s'annoncent « complet » et celles en cours de
    // chargement « disponibilités en cours de chargement » : ne retenir que
    // celles dont le libellé se termine par un décompte évite d'avoir à
    // interroger `aria-disabled`.
    const jourOuvert = etape.getByRole('radio', { name: /\d+ créneaux?$/ }).first();
    await expect(jourOuvert).toBeVisible({ timeout: 20_000 });
    await jourOuvert.click();

    const creneau = etape.getByRole('gridcell').locator('button').first();
    await expect(creneau).toBeVisible();
    await creneau.click();
  });

  await test.step('4. Coordonnées — renseigner la cliente', async () => {
    // `getByRole` et non `getByLabel`, et ce n'est pas un choix de style. Le
    // marqueur d'obligation du design system est un `<span aria-hidden>*</span>`
    // **à l'intérieur** du `<label>` (`components/ui/field.tsx`). Le texte du
    // label vaut donc « Nom* » : `getByLabel('Nom', { exact: true })` ne désigne
    // rien du tout, et sans `exact` « Nom » désignerait aussi « Prénom* ». Le
    // nom accessible, lui, ignore l'`aria-hidden` — il vaut « Nom », et il est
    // exact. C'est le seul des deux qui dise ce que la cliente entend.
    const champ = (nom: string): Locator => page.getByRole('textbox', { name: nom, exact: true });

    await champ('Prénom').fill(CLIENTE.prenom);
    await champ('Nom').fill(CLIENTE.nom);
    await champ('Adresse e-mail').fill(CLIENTE.email);
    await champ('Téléphone').fill(CLIENTE.telephone);
    await page.getByRole('button', { name: 'Vérifier ma réservation' }).click();
  });

  await test.step('5. Récapitulatif — confirmer la réservation', async () => {
    const recapitulatif = page.getByRole('region', {
      name: 'Récapitulatif de votre réservation',
    });
    await expect(recapitulatif).toBeVisible();
    await page.getByRole('button', { name: 'Confirmer la réservation' }).click();
  });

  return test.step('6. Confirmation — relever la référence', async () => {
    const confirmation = page.getByRole('region', {
      name: 'Confirmation de votre réservation',
    });
    await expect(confirmation).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Votre rendez-vous est enregistré')).toBeVisible();

    const reference = confirmation.locator('p.spa-card__meta', { hasText: 'Référence :' });
    await expect(reference).toBeVisible();
    const texte = (await reference.innerText()).trim();

    const identifiant = texte.replace(/^Référence\s*:\s*/u, '').trim();
    expect(
      identifiant,
      `La référence affichée (« ${texte} ») ne porte pas d'identifiant exploitable.`,
    ).toMatch(/^[0-9a-f-]{36}$/i);

    return { identifiant };
  });
}

/** Ouvre une session de comptoir. Le rang `STAFF` est le plus bas qu'admet l'agenda. */
export async function connexionComptoir(page: Page, email: string): Promise<void> {
  await test.step('Comptoir — se connecter au back-office', async () => {
    await page.goto(chemins.connexionAdmin());
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe').fill(MOT_DE_PASSE);
    await page.getByRole('button', { name: 'Se connecter' }).click();

    // La connexion réussie renvoie vers les réglages, jamais vers le planning :
    // c'est le repère qui dit que la session est posée.
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
