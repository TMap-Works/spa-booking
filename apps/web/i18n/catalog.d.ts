import type { Locale } from '@spa/shared';

/**
 * Le typage des clés de messages — #845, troisième critère d'acceptation :
 * *« une clé absente ou mal orthographiée fait échouer `tsc` »*.
 *
 * ## Une interface ouverte, et non une liste
 *
 * `SpaMessages.Catalog` est déclarée **vide** ici, et chaque namespace s'y
 * ajoute depuis son propre répertoire, par un `messages/<namespace>.d.ts` de
 * quatre lignes. C'est ce qui tient le second critère du ticket — *« ajouter un
 * namespace ne demande de toucher aucun fichier central : ni une liste
 * d'imports, ni la déclaration de types des messages »* — sans renoncer au
 * typage : la fusion de déclarations de TypeScript assemble les morceaux, et
 * `tsc` connaît la forme complète du catalogue sans qu'aucune ligne de ce
 * fichier ne bouge.
 *
 * Onze tickets d'écrans de l'épique #843 ajoutent chacun le leur. Une liste
 * centrale les aurait mis en conflit de fusion les uns avec les autres.
 *
 * ## Pourquoi ce fichier s'appelle `catalog.d.ts` et non `messages.d.ts`
 *
 * Parce qu'un `X.d.ts` posé à côté d'un `X.ts` **disparaît du programme**.
 * TypeScript y voit la déclaration générée de `X.ts`, pas un fichier de
 * déclarations à part entière, et l'écarte — sans un mot. `i18n/messages.ts`
 * existe : `i18n/messages.d.ts` n'était donc jamais lu, l'augmentation
 * ci-dessous restait inerte, `Locale` valait `string` et **n'importe quelle clé
 * passait `tsc`**, y compris un namespace qui n'existe pas. La panne était
 * muette : aucune erreur, aucun avertissement, juste un critère d'acceptation
 * qui ne tenait plus.
 *
 * `tests/types/catalog-typing.test-d.ts` monte la garde : ses
 * `@ts-expect-error` deviennent « directive inutilisée » — donc une erreur de
 * compilation — le jour où l'augmentation redevient inerte.
 *
 * ## C'est la langue anglaise qui donne le type
 *
 * Chaque déclaration de namespace lit son catalogue **anglais** : `en` est la
 * langue par défaut du système (#844), donc la seule dont l'existence est
 * garantie. La parité avec le français n'est pas un fait de typage mais un fait
 * de contenu — c'est `tests/unit/messages-parity.test.ts` qui échoue si les deux
 * catalogues n'ont pas exactement les mêmes clés.
 */

declare global {
  namespace SpaMessages {
    /**
     * Le catalogue complet, assemblé par fusion de déclarations.
     *
     * Vide ici, par construction : chaque `messages/<namespace>.d.ts` y ajoute
     * sa clé — et aucun d'eux ne se heurte à la règle du `X.d.ts` ci-dessus,
     * `messages/<namespace>` n'étant qu'un JSON. Voir `apps/web/README.md`,
     * « Ajouter un namespace ».
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Catalog {}
  }
}

declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: SpaMessages.Catalog;
  }
}

export {};
