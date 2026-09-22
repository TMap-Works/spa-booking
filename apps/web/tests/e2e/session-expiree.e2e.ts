/**
 * L'expiration du jeton d'accès ne se voit pas — #856.
 *
 * Le constat du PO : au bout d'un quart d'heure, le back-office renvoyait à
 * l'écran de connexion, ou affichait « Votre session a expiré » sur un
 * enregistrement perdu. Deux causes, et ce scénario traverse les deux :
 *
 * 1. **un lien du rail** après l'expiration. La garde de la page redirige vers
 *    la route de renouvellement ; sous `next dev`, `reactStrictMode` rejoue
 *    cette redirection, et deux renouvellements partent avec le même cookie.
 *    Le perdant révoquait toute la session ;
 * 2. **un formulaire** soumis après l'expiration. L'action serveur rendait
 *    `UNAUTHORIZED` sans rien renouveler, et l'écran l'affichait.
 *
 * ## Pourquoi le cookie d'accès est retiré plutôt qu'attendu
 *
 * Le cookie d'accès vit la durée du jeton moins trente secondes : « absent » et
 * « expiré » sont, pour le front, **le même état** — c'est la règle de
 * `admin/session.ts`, et c'est tout ce que les deux causes observent. Le retirer
 * du navigateur reproduit donc exactement ce que la personne vit après un quart
 * d'heure, sans en payer l'attente.
 *
 * Raccourcir `JWT_EXPIRES_IN` pour toute la suite aurait coûté plus qu'il
 * n'aurait prouvé. Le banc sert le front en `next dev`, qui compile chaque
 * écran du back-office à sa première visite — souvent plus de trente secondes.
 * Avec un jeton d'une minute, une page demandée juste avant l'échéance du
 * cookie appellerait l'API avec un jeton expiré entre-temps, et la garde
 * renverrait à la connexion : une autre piste du ticket, hors de son périmètre,
 * qui rendrait intermittents les scénarios du parcours critique.
 */

import { COMPTES, SLUG } from './support/environnement';
import { connexionComptoir, expect, test } from './support/scene';

/** Le cookie d'accès du back-office — voir `ADMIN_ACCESS_COOKIE`. */
const COOKIE_ACCES = 'spa_admin_access';
/** Le cookie de rafraîchissement du back-office — voir `ADMIN_REFRESH_COOKIE`. */
const COOKIE_RAFRAICHISSEMENT = 'spa_admin_refresh';

test.describe('Session du back-office', () => {
  test('l’expiration du jeton d’accès ne se voit pas', async ({ page, context }) => {
    // Deux premières visites d'écran à compiler, en plus de la connexion.
    test.slow();

    const renouvellements: string[] = [];
    page.on('request', (requete) => {
      if (requete.url().includes('/admin/session/refresh')) {
        renouvellements.push(requete.url());
      }
    });

    /** Ce que le navigateur porte d'un quart d'heure d'inactivité. */
    const expirerAcces = async (): Promise<void> => {
      await context.clearCookies({ name: COOKIE_ACCES });
      const noms = (await context.cookies()).map((cookie) => cookie.name);
      expect(noms).not.toContain(COOKIE_ACCES);
      expect(noms).toContain(COOKIE_RAFRAICHISSEMENT);
    };

    /** Les deux cookies sont là : la session est ouverte, et renouvelable. */
    const sessionOuverte = async (): Promise<void> => {
      const noms = (await context.cookies()).map((cookie) => cookie.name);
      expect(noms).toContain(COOKIE_ACCES);
      expect(noms).toContain(COOKIE_RAFRAICHISSEMENT);
    };

    await connexionComptoir(page, COMPTES.admin);

    const telephone = page.getByLabel('Téléphone', { exact: true });
    const enregistrer = page.getByRole('button', { name: 'Enregistrer', exact: true });
    let telephoneInitial = '';

    await test.step('Expiration, puis un lien du rail — la page s’ouvre', async () => {
      await expirerAcces();

      await page
        .getByRole('navigation', { name: 'Sections du tableau de bord' })
        .getByRole('link', { name: 'Réglages' })
        .click();

      await page.waitForURL(`**/${SLUG}/admin/reglages`);
      await expect(telephone).toBeVisible();
      expect(page.url()).not.toContain('/connexion');
      // La navigation est bien passée par la route de renouvellement…
      expect(renouvellements.length).toBeGreaterThan(0);
      // …et en est ressortie avec une session entière.
      await sessionOuverte();

      telephoneInitial = await telephone.inputValue();
    });

    // Au format national : le champ téléphone (#825) relit un numéro enregistré
    // derrière le drapeau du salon, et c'est ce que `inputValue` rend.
    const nouveauTelephone = telephoneInitial === '06 12 34 56 70' ? '06 12 34 56 71' : '06 12 34 56 70';

    await test.step('Nouvelle expiration, puis « Enregistrer » — l’enregistrement aboutit', async () => {
      await expirerAcces();

      // Saisi en international : le salon d'essai n'a pas d'adresse, donc pas
      // de pays — le champ part des États-Unis, et le « +33 » le bascule sur
      // la France.
      await telephone.fill(`+33 ${nouveauTelephone.slice(1)}`);
      await enregistrer.click();

      await expect(page.getByText('Réglages enregistrés')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Reconnectez-vous/)).toHaveCount(0);
      expect(page.url()).toContain(`/${SLUG}/admin/reglages`);
      await sessionOuverte();
    });

    await test.step('Rechargement — la personne est toujours connectée, la valeur est gardée', async () => {
      await page.reload();

      await expect(telephone).toHaveValue(nouveauTelephone);
      expect(page.url()).not.toContain('/connexion');
    });

    await test.step('Remise en état des réglages', async () => {
      await telephone.fill(telephoneInitial);
      await enregistrer.click();
      await expect(page.getByText('Réglages enregistrés')).toBeVisible({ timeout: 20_000 });
    });
  });
});
