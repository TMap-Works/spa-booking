import { getRequestConfig } from 'next-intl/server';

import { loadMessages } from './messages';
import { requestLocale } from './server';

/**
 * La configuration que `next-intl` lit à chaque requête — #845.
 *
 * `createNextIntlPlugin('./i18n/request.ts')` de `next.config.mjs` désigne ce
 * fichier, et rien d'autre ne l'importe : c'est le point unique par lequel une
 * page, un layout ou une action serveur obtient sa langue et ses messages.
 *
 * ## Pas de `[locale]` dans l'URL, et c'est une décision
 *
 * Voir l'ADR 0017. L'URL d'un salon est ce qu'il imprime sur sa vitrine et ce
 * qu'il colle dans ses messages : y insérer un segment de langue aurait doublé
 * chaque adresse du produit, et fait dépendre le référencement d'un choix
 * d'affichage. La langue se résout donc sur la requête, et `requestLocale` de
 * `next-intl` — qui lit ce segment — n'a rien à dire ici.
 *
 * ## Le fuseau annoncé est UTC, et ce n'est pas celui des rendez-vous
 *
 * `next-intl` a besoin d'un fuseau par défaut pour ses propres formateurs. Le
 * front n'en emploie aucun : toutes les dates du produit passent par
 * `lib/format.ts`, qui exige le fuseau de l'**établissement** — la règle de
 * `CLAUDE.md`, « tout est stocké en UTC, converti à l'affichage selon le fuseau
 * du tenant ». Déclarer UTC ici rend donc le défaut inoffensif : un formateur de
 * `next-intl` employé par mégarde afficherait un instant UTC, ce qui se voit,
 * plutôt que l'heure du serveur, ce qui ne se voit pas.
 */
export default getRequestConfig(async () => {
  const locale = await requestLocale();

  return {
    locale,
    messages: loadMessages(locale),
    timeZone: 'UTC',
  };
});
