/**
 * Le comptoir — création manuelle, report, annulation, no-show.
 *
 * Deuxième critère de #80. Quatre gestes du quotidien d'un salon, chacun sur son
 * propre jour : ils ne se disputent aucun créneau et ne dépendent d'aucun ordre
 * d'exécution.
 *
 * ## Ce que ces scénarios ont découvert, et qu'ils consignent
 *
 * Deux des quatre gestes **n'ont pas d'écran** dans le back-office :
 *
 * - **l'annulation** — `DESK_STATUS_LABELS` l'écarte explicitement
 *   (`apps/web/lib/admin/appointment-desk.ts`), au motif que « l'annulation a sa
 *   propre route, son propre corps — un motif — et sa propre confirmation ». Le
 *   commentaire de `appointments.controller.ts` renvoie de son côté à « un
 *   bouton d'annulation à part » dans le tiroir de #50 — bouton que
 *   `appointment-panel.tsx` ne rend pas. La route est servie, l'écran manque ;
 * - **la confirmation** d'un rendez-vous en attente, pour la même raison.
 *
 * Ces deux-là sont donc exercés par leur route, et le scénario vérifie ensuite à
 * l'écran que le comptoir **voit** le résultat. Ce n'est pas un contournement de
 * confort : c'est l'état réel du produit, et le combler reviendrait à écrire de
 * l'IHM depuis une suite de tests. Un suivi est ouvert sur ce manque.
 */

import {
  annuler,
  changerStatut,
  connecter,
  lireAgenda,
  poserRendezVous,
  trouverRendezVous,
} from './support/api';
import { COMPTES, chemins, heureDuSalon } from './support/environnement';
import { compteClient } from './support/jeu-dessai';
import {
  blocRendezVous,
  connexionComptoir,
  expect,
  jourDuScenario,
  test,
  tiroir,
} from './support/scene';

/** Le nom du compte client du jeu d'essai, tel qu'il s'affiche au comptoir. */
const CLIENTE_FICHIER = 'Clara Parcours';

test.describe('Comptoir', () => {
  test.beforeEach(async ({ page }) => {
    await connexionComptoir(page, COMPTES.staff);
  });

  /**
   * La journée est **vide au départ**, et c'est le sujet du scénario.
   *
   * La vue jour ouvre une colonne par praticien du répertoire de l'établissement
   * et non par praticien déjà occupé (#507) : une journée creuse rend donc une
   * grille de créneaux libres, et le clic sur l'un d'eux ouvre le tiroir. Ce
   * scénario a longtemps dû poser un rendez-vous par l'API pour faire exister
   * une seule case cliquable — ce n'est plus nécessaire, et le retirer est ce
   * qui prouve le troisième critère du ticket.
   */
  test('création manuelle depuis le planning', async ({ page, jeu }) => {
    const jour = jourDuScenario(0);

    await test.step('Ouvrir un créneau libre du planning', async () => {
      await page.goto(chemins.calendrier(jour));

      const libre = page.getByRole('button', { name: /libre — poser un rendez-vous/ }).first();
      await expect(libre).toBeVisible({ timeout: 20_000 });
      await libre.click();

      await expect(tiroir(page).getByRole('heading', { name: 'Nouveau rendez-vous' })).toBeVisible();
    });

    await test.step('Désigner la cliente dans le fichier', async () => {
      const panneau = tiroir(page);
      await panneau.getByLabel('Client').fill('Clara');

      const resultat = panneau.getByRole('button', { name: new RegExp(CLIENTE_FICHIER) }).first();
      await expect(resultat).toBeVisible({ timeout: 20_000 });
      await resultat.click();

      // Une fois la cliente retenue, le sélecteur se replie sur son nom.
      await expect(panneau.getByRole('button', { name: 'Changer de client' })).toBeVisible();
    });

    await test.step('Choisir la prestation et enregistrer', async () => {
      const panneau = tiroir(page);
      // Par **valeur**, et non par index ni par libellé. Le sélecteur du tiroir
      // ne porte pas de ligne « Choisir une prestation… » — contrairement à
      // celui du tunnel client —, si bien qu'un index 1 ne désigne rien quand le
      // catalogue ne compte qu'une prestation, ce qui est le cas du jeu d'essai.
      // La valeur d'option est l'identifiant de la prestation
      // (`appointment-panel.tsx`), que le jeu d'essai connaît.
      await panneau.getByLabel('Prestation').selectOption(jeu.prestation.id);

      const creer = panneau.getByRole('button', { name: 'Créer le rendez-vous' });
      await expect(creer).toBeEnabled();
      await creer.click();
    });

    await test.step('Le rendez-vous apparaît sur le planning', async () => {
      await expect(tiroir(page)).toBeHidden({ timeout: 20_000 });
      // Un bloc exactement : la journée était vide, celui-là est donc bien celui
      // que le tiroir vient de créer. Un compte, et non un `.first()` visible,
      // pour que l'assertion tombe si le tiroir n'a rien écrit.
      await expect(blocRendezVous(page, CLIENTE_FICHIER)).toHaveCount(1, { timeout: 20_000 });
    });
  });

  test('report depuis le tiroir', async ({ page, request, jeu }) => {
    const jour = jourDuScenario(1);
    const jeton = await connecter(request, COMPTES.staff);

    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    const heureInitiale = heureDuSalon(new Date(rendezVous.startsAt));
    // L'heure de destination n'est plus une constante, et c'est le sujet de
    // #611 : le tiroir n'offre que les créneaux que le moteur rend, alignés sur
    // le début de plage du praticien au pas de quinze minutes. Une heure ronde
    // écrite ici serait refusée en 409 — c'est exactement le bug qu'on corrige.
    // Elle est donc **lue dans le sélecteur**, au moment du report.
    let heureVisee = '';

    await test.step('Ouvrir le rendez-vous posé', async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();
      await expect(tiroir(page)).toBeVisible();
    });

    await test.step(`Déplacer le rendez-vous posé à ${heureInitiale}`, async () => {
      const panneau = tiroir(page);
      const heures = panneau.getByLabel('Heure de début');
      // **Attendre que le sélecteur s'arme, et pas qu'il porte une option.** Le
      // tiroir affiche d'emblée l'heure du rendez-vous — une option de repli qui
      // existe avant même que la disponibilité soit lue —, si bien qu'un
      // « au moins une option » est satisfait instantanément et fait lire la
      // liste vide. Le contrôle n'est actif que lorsque le moteur a répondu et
      // que la journée porte des créneaux : c'est cet état-là qu'on attend.
      await expect(heures).toBeEnabled({ timeout: 20_000 });

      const proposees = await heures
        .locator('option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
      const autre = proposees.find((heure) => heure !== heureInitiale);
      expect(
        autre,
        `Aucun créneau autre que ${heureInitiale} n'est proposé : le report ne ` +
          `déplacerait rien (${proposees.length} créneaux lus).`,
      ).toBeDefined();
      heureVisee = autre ?? '';

      await heures.selectOption(heureVisee);
      await panneau.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(panneau).toBeHidden({ timeout: 20_000 });

      // Le tiroir se referme dès la soumission, sans attendre que l'action
      // serveur ait conclu : sa fermeture ne prouve donc rien de l'écriture.
      // C'est le bloc apparu sur la rangée de destination qui la prouve — et
      // sans ce point d'attente, la lecture d'agenda qui suit interrogeait
      // l'API pendant que le report était encore en vol.
      await expect(
        blocRendezVous(page, CLIENTE_FICHIER).filter({ hasText: heureVisee }),
      ).toHaveCount(1, { timeout: 20_000 });
    });

    /**
     * Un report **n'est pas** un déplacement de bornes.
     *
     * `appointments.controller.ts` le dit sans ambiguïté : « un report est une
     * annulation suivie d'une création liée, jamais une réécriture des bornes en
     * place (booking-engine §5) ». Le rendez-vous d'origine finit donc `cancelled`
     * à son heure d'origine, et c'est un **autre** rendez-vous, d'identifiant
     * neuf, qui occupe le créneau visé.
     *
     * Attendre l'ancien identifiant à la nouvelle heure — ce que faisait la
     * première écriture de ce scénario — revenait à éprouver un modèle du
     * domaine que le produit ne suit pas : l'assertion échouait en accusant
     * l'IHM, qui avait pourtant fait exactement ce qu'il fallait.
     */
    await test.step("L'API rend une annulation liée et un rendez-vous neuf", async () => {
      const origine = await trouverRendezVous(request, jeton, rendezVous.id);
      expect(
        origine.status.toLowerCase(),
        "Le rendez-vous d'origine doit être annulé par le report, non déplacé.",
      ).toBe('cancelled');
      expect(heureDuSalon(new Date(origine.startsAt))).toBe(heureInitiale);

      const journee = await lireAgenda(request, jeton, { from: jour, to: jour });
      const deplace = journee.find(
        (candidat) => heureDuSalon(new Date(candidat.startsAt)) === heureVisee,
      );
      expect(
        deplace,
        `Aucun rendez-vous à ${heureVisee} le ${jour} : le report n'a rien créé ` +
          `(${journee.length} rendez-vous lus).`,
      ).toBeDefined();
      expect(deplace?.id).not.toBe(rendezVous.id);
      expect(deplace?.status.toLowerCase()).not.toBe('cancelled');
    });
  });

  test('no-show depuis le tiroir', async ({ page, request, jeu }) => {
    const jour = jourDuScenario(2);
    const jeton = await connecter(request, COMPTES.staff);

    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    // `no_show` n'est atteignable que depuis `confirmed`
    // (`APPOINTMENT_STATUS_TRANSITIONS`) : un rendez-vous en attente n'offre
    // aucun bouton de statut, et c'est le produit qui en décide ainsi.
    await changerStatut(request, jeton, rendezVous.id, 'confirmed');

    await test.step('Marquer la cliente non présentée', async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();

      const panneau = tiroir(page);
      await expect(panneau).toBeVisible();
      await panneau.getByRole('button', { name: 'Marquer non présenté' }).click();
      await expect(panneau).toBeHidden({ timeout: 20_000 });
    });

    await test.step('Le planning affiche « non présenté »', async () => {
      await expect(blocRendezVous(page, CLIENTE_FICHIER).first()).toHaveAccessibleName(
        /Statut : non présenté/,
      );
    });

    await test.step("L'API a bien inscrit le no-show", async () => {
      const apres = await trouverRendezVous(request, jeton, rendezVous.id);
      expect(apres.status.toLowerCase()).toBe('no_show');
    });
  });

  test('annulation au comptoir', async ({ page, request, jeu }) => {
    const jour = jourDuScenario(3);
    const jeton = await connecter(request, COMPTES.staff);

    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });

    await test.step("Aucun écran du back-office ne porte l'annulation", async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();

      const panneau = tiroir(page);
      await expect(panneau).toBeVisible();
      // Consigné plutôt que contourné : le jour où le tiroir portera son bouton
      // d'annulation, cette assertion rougira et dira quoi réécrire.
      await expect(
        panneau.getByRole('button', { name: /Annuler ce rendez-vous|Marquer annulé/ }),
      ).toHaveCount(0);
      await panneau.getByRole('button', { name: 'Fermer le tiroir' }).click();
    });

    await test.step('Annuler par la route du salon', async () => {
      const apres = await annuler(request, jeton, rendezVous.id, 'Cliente empêchée');
      expect(apres.status.toLowerCase()).toBe('cancelled');
    });

    await test.step('Le planning affiche « annulé »', async () => {
      await page.goto(chemins.calendrier(jour));
      await expect(blocRendezVous(page, CLIENTE_FICHIER).first()).toHaveAccessibleName(
        /Statut : annulé/,
        { timeout: 20_000 },
      );
    });

    await test.step("L'encaissement refuse un rendez-vous annulé", async () => {
      await page.goto(chemins.encaissement(jour, rendezVous.id));
      await expect(page.getByText('Rien à encaisser')).toBeVisible({ timeout: 20_000 });
    });
  });
});
