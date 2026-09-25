/**
 * Le comptoir — création manuelle, report, annulation, no-show.
 *
 * Deuxième critère de #80. Cinq gestes du quotidien d'un salon, chacun sur son
 * propre jour : ils ne se disputent aucun créneau et ne dépendent d'aucun ordre
 * d'exécution.
 *
 * ## Le no-show a quitté l'avenir (#1210)
 *
 * Il travaillait sur un rendez-vous à J+2 — c'est-à-dire sur un rendez-vous qui
 * n'a pas commencé, ce que #1137 déclare faux et ce que le cycle de vie du
 * serveur refusera de constater. Le scénario opère désormais sur une journée
 * **passée**, décor posé par le jeu d'essai, et un cinquième scénario éprouve ce
 * que le tiroir fait d'un rendez-vous à venir : deux constats inertes, et leur
 * motif. Les deux tiennent avec ou sans le garde-fou serveur : ils n'éprouvent
 * que l'écran.
 *
 * ## Ce que ces scénarios ont découvert, et qu'ils consignent
 *
 * **L'annulation n'avait pas d'écran** : `DESK_STATUS_LABELS`
 * (`apps/web/lib/admin/appointment-desk.ts`) l'écarte, au motif qu'elle a « sa
 * propre route, son propre corps — un motif — et sa propre confirmation », et
 * ces trois choses n'étaient branchées nulle part. Le scénario la passait donc
 * par sa route, en le consignant. Ce n'est plus le cas depuis #754 : le pied du
 * tiroir porte l'action destructive, et le scénario l'exerce à l'écran, en deux
 * temps et avec son motif.
 *
 * Reste **la confirmation** d'un rendez-vous en attente : `pending → confirmed`
 * est dans la table du contrat, mais aucun bouton ne la déclenche. Elle est donc
 * exercée par sa route, et le scénario vérifie ensuite à l'écran que le comptoir
 * **voit** le résultat. Ce n'est pas un contournement de confort : c'est l'état
 * réel du produit, et le combler reviendrait à écrire de l'IHM depuis une suite
 * de tests. Un suivi est ouvert sur ce manque.
 */

import {
  changerStatut,
  connecter,
  lireAgenda,
  poserRendezVous,
  poserRendezVousCommence,
  trouverRendezVous,
} from './support/api';
import { COMPTES, chemins, dansNJours, heureDuSalon } from './support/environnement';
import { compteClient } from './support/jeu-dessai';
import { blocRendezVous, expect, jourDuScenario, test, tiroir } from './support/scene';
import { SESSION_COMPTOIR } from './support/sessions';

/** Le nom du compte client du jeu d'essai, tel qu'il s'affiche au comptoir. */
const CLIENTE_FICHIER = 'Clara Parcours';

test.describe('Comptoir', () => {
  /**
   * La session du comptoir est **reprise**, et non rouverte à chaque scénario.
   *
   * Un `beforeEach` qui se connectait ouvrait cinq sessions du même compte pour
   * cinq gestes du même comptoir — la moitié des neuf connexions que #1129 a
   * relevées, sur un plafond de dix par minute et par cible (#1127). Un salon
   * n'ouvre pas une session par geste, et la suite n'a aucune raison de le
   * faire : le projet `sessions` l'ouvre une fois (`sessions.setup.ts`), et
   * chaque scénario repart des cookies déjà posés.
   *
   * Ce que cela ne retire à personne : la connexion du back-office reste
   * éprouvée à l'écran — par `sessions.setup.ts` lui-même, qui échoue comme un
   * test si elle cède, et par `session-expiree.e2e.ts`, dont elle est l'objet.
   */
  test.use({ storageState: SESSION_COMPTOIR });

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
    const jeton = await connecter(request, COMPTES.manager);

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

  /**
   * Le constat se pose sur un rendez-vous **commencé**, et sur lui seul — #1210.
   *
   * ## Pourquoi ce scénario a changé de jour
   *
   * Il posait un rendez-vous à J+2 et cliquait « Marquer non honoré ». C'était
   * le comportement que #1137 a déclaré faux : on ne constate pas ce qui n'a pas
   * eu lieu, et le cycle de vie refuse les deux constats avant l'heure du soin —
   * 422 `INVALID_STATE_TRANSITION`, `details.notStarted`. Le scénario encodait
   * donc un bug, et le tiroir ne l'offre plus : le clic n'aboutirait pas, que le
   * garde-fou serveur soit déjà en place ou non.
   *
   * Il travaille maintenant sur un rendez-vous d'une journée **passée**, posé
   * par le jeu d'essai : la porte de comptoir ne sait pas en poser un dans le
   * passé, et c'est la bonne règle (voir `support/api.ts`). Le refus, lui, est
   * éprouvé sur un rendez-vous à venir, à l'étape suivante.
   */
  test('no-show depuis le tiroir', async ({ page, request }) => {
    const jeton = await connecter(request, COMPTES.manager);
    // Une journée passée par tentative : la précédente a soldé le sien, et un
    // rendez-vous `no_show` n'offre plus aucun constat.
    const jour = dansNJours(-1 - test.info().retry);
    const rendezVous = poserRendezVousCommence(jour);

    await test.step('Marquer la cliente non présentée', async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();

      const panneau = tiroir(page);
      await expect(panneau).toBeVisible();

      const constat = panneau.getByRole('button', { name: 'Marquer non honoré' });
      // Le soin est commencé : le tiroir ouvre le geste, il ne le grise pas.
      await expect(constat).toBeEnabled({ timeout: 20_000 });
      await constat.click();
      await expect(panneau).toBeHidden({ timeout: 20_000 });
    });

    await test.step('Le planning affiche « Non honoré »', async () => {
      // Le statut se lit dans le texte du repère, et non plus dans un nom
      // accessible : un rendez-vous soldé n'occupe plus son créneau (#753), son
      // bloc est donc un `<div>` inerte — un élément générique n'expose aucun
      // nom accessible, seul le contrôle du coin en porte un. `toContainText`
      // lit `textContent`, `.spa-visually-hidden` compris.
      await expect(blocRendezVous(page, CLIENTE_FICHIER).first()).toContainText(
        'Statut : Non honoré',
      );
    });

    await test.step("L'API a bien inscrit le no-show", async () => {
      const journee = await lireAgenda(request, jeton, { from: jour, to: jour });
      const apres = journee.find((candidat) => candidat.id === rendezVous.id);
      expect(
        apres,
        `Le rendez-vous ${rendezVous.reference} est introuvable dans l'agenda du ${jour}.`,
      ).toBeDefined();
      expect(apres?.status.toLowerCase()).toBe('no_show');
    });
  });

  /**
   * L'autre moitié de #1210 : ce que le tiroir fait d'un rendez-vous **à venir**.
   *
   * Les deux constats y sont offerts **inertes**, avec leur motif — plutôt que
   * masqués, un bouton qui disparaît ne disant pas pourquoi. Ce qui reste
   * ouvert, ce sont les décisions : annuler et déplacer se prennent précisément
   * avant l'heure.
   */
  test('les constats restent fermés sur un rendez-vous à venir', async ({ page, request, jeu }) => {
    // Le rang que le no-show occupait avant de partir dans le passé : les rangs
    // 4 et 5 sont ceux de l'encaissement par carte.
    const jour = jourDuScenario(2);
    const jeton = await connecter(request, COMPTES.manager);

    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });
    // `no_show` et `completed` ne sont atteignables que depuis `confirmed`
    // (`APPOINTMENT_STATUS_TRANSITIONS`) : sans ce passage, le tiroir n'offrirait
    // pas les deux boutons du tout, et le scénario ne prouverait rien de l'heure.
    // Mise en situation, motif 2 de `support/api.ts` — le bouton « Confirmer le
    // rendez-vous » est exercé à l'écran par le parcours critique.
    await changerStatut(request, jeton, rendezVous.id, 'confirmed');

    await test.step('Le tiroir grise les deux constats et dit pourquoi', async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();

      const panneau = tiroir(page);
      await expect(panneau).toBeVisible();

      await expect(panneau.getByRole('button', { name: 'Marquer honoré' })).toBeDisabled({
        timeout: 20_000,
      });
      await expect(panneau.getByRole('button', { name: 'Marquer non honoré' })).toBeDisabled();
      await expect(panneau.getByText('Le rendez-vous n’a pas commencé')).toBeVisible();

      // Les décisions, elles, restent ouvertes.
      await expect(panneau.getByRole('button', { name: 'Annuler le rendez-vous' })).toBeEnabled();
    });

    await test.step("L'API n'a rien inscrit", async () => {
      const apres = await trouverRendezVous(request, jeton, rendezVous.id);
      expect(apres.status.toLowerCase()).toBe('confirmed');
    });
  });

  test('annulation au comptoir', async ({ page, request, jeu }) => {
    const jour = jourDuScenario(3);
    const jeton = await connecter(request, COMPTES.manager);

    const rendezVous = await poserRendezVous(request, jeton, {
      serviceId: jeu.prestation.id,
      clientId: compteClient(jeu),
      leJour: jour,
    });

    await test.step('Annuler depuis le tiroir, en deux temps (#754)', async () => {
      await page.goto(chemins.calendrier(jour));
      const bloc = blocRendezVous(page, CLIENTE_FICHIER).first();
      await expect(bloc).toBeVisible({ timeout: 20_000 });
      await bloc.click();

      const panneau = tiroir(page);
      await expect(panneau).toBeVisible();

      // Premier temps : la question, pas l'envoi. Le pied perd ses autres
      // issues tant qu'elle est posée — c'est ce qui se vérifie ici, et pas
      // seulement que le bouton existe.
      await panneau.getByRole('button', { name: 'Annuler le rendez-vous' }).click();
      await expect(panneau.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);

      // Second temps, motif compris : il est enregistré sur la ligne et rendu
      // par aucune réponse — c'est une note interne, et le vérifier à l'écran
      // reviendrait à exiger une fuite.
      await panneau.getByLabel(/Motif de l’annulation/).fill('Cliente empêchée');
      await panneau.getByRole('button', { name: 'Confirmer l’annulation' }).click();
      await expect(panneau).toBeHidden({ timeout: 20_000 });
    });

    await test.step('Le planning affiche « annulé »', async () => {
      await page.goto(chemins.calendrier(jour));
      // Même raison qu'au no-show : le repère d'un soldé est un bloc inerte
      // sans nom accessible, et c'est son texte qui porte le statut (#753).
      await expect(blocRendezVous(page, CLIENTE_FICHIER).first()).toContainText(
        'Statut : Annulé par le salon',
        { timeout: 20_000 },
      );
    });

    await test.step("L'encaissement refuse un rendez-vous annulé", async () => {
      await page.goto(chemins.encaissement(jour, rendezVous.id));
      await expect(page.getByText('Rien à encaisser')).toBeVisible({ timeout: 20_000 });
    });
  });
});
