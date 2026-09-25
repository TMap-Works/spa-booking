/**
 * Les deux sessions de la suite, ouvertes une fois — #1129.
 *
 * ## Pourquoi un projet Playwright et non l'amorçage global
 *
 * `global-setup.ts` s'exécute hors du lanceur : ni `test.step`, ni les
 * assertions à attente, ni le `use` de la configuration — fuseau, langue,
 * `baseURL`, délai de navigation — n'y valent. Une connexion écrite là-bas
 * aurait été un second harnais, avec ses propres délais et son propre
 * diagnostic, pour les mêmes gestes que `support/scene.ts` écrit déjà.
 *
 * Un projet en dépendance (`playwright.config.ts`, `dependencies: ['sessions']`)
 * garde tout cela : ce fichier est un test comme les autres, il échoue comme un
 * test, il laisse une trace comme un test — et Playwright saute d'eux-mêmes les
 * scénarios qui en dépendent si la session ne s'ouvre pas, au lieu de les faire
 * échouer un par un sur un écran de connexion.
 *
 * Effet de bord heureux, et qui n'est pas mince sous `next dev` : les deux
 * écrans de connexion et le planning du comptoir sont **compilés ici**, hors du
 * budget des scénarios — le même raisonnement que le préchauffage des routes
 * publiques de `global-setup.ts`.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il n'ouvre pas la session d'`admin@e2e.test` : `session-expiree.e2e.ts` ouvre
 * la sienne, et c'est son objet même. Voir le registre des connexions dans
 * `support/sessions.ts`.
 */

import { COMPTES } from './support/environnement';
import { connexionCliente, connexionComptoir, test } from './support/scene';
import {
  SESSION_CLIENTE,
  SESSION_COMPTOIR,
  preparerDossierDesSessions,
} from './support/sessions';

test.describe('Sessions de la suite', () => {
  test('le comptoir, ouvert une fois pour tous les scénarios', async ({ page, context }) => {
    // Deux écrans à compiler — la connexion du back-office, puis le planning sur
    // lequel elle dépose le rang gérant.
    test.slow();

    await connexionComptoir(page, COMPTES.manager);

    preparerDossierDesSessions();
    await context.storageState({ path: SESSION_COMPTOIR });
  });

  test("la cliente, ouverte une fois pour les traversées qui n'éprouvent pas la porte", async ({
    page,
    context,
  }) => {
    test.slow();

    await connexionCliente(page);

    preparerDossierDesSessions();
    await context.storageState({ path: SESSION_CLIENTE });
  });
});
