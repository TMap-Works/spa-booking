import type { Locale } from '@spa/shared';
import { vi } from 'vitest';

import { nextIntlFixe, nextIntlServerFixe } from './langue-figee';

/**
 * La langue des suites unitaires — #845, avant-dernier critère d'acceptation :
 * *« les tests existants qui vérifient des libellés français continuent de
 * passer, en fixant explicitement la langue `fr` »*.
 *
 * ## Pourquoi un fichier d'amorce, et non une réécriture des suites
 *
 * Cinquante-huit suites appellent `render()` de `@testing-library/react` sans
 * fournisseur. Depuis que les briques partagées lisent leurs libellés dans le
 * catalogue, chacune se heurterait à *« Failed to call useTranslations because
 * the context from NextIntlClientProvider was not found »* — sept cent
 * trente-trois échecs pour une traduction qui n'a rien cassé. Les réécrire une
 * à une aurait touché cinquante-huit fichiers hors du périmètre du ticket, et
 * mis en conflit de fusion les onze tickets d'écrans qui y reviendront.
 *
 * L'amorce pose donc la langue **une fois**, pour toutes les suites : `fr`,
 * c'est-à-dire exactement ce que ces tests vérifiaient avant. Les tickets
 * d'écrans ajoutent ensuite la variante `en` de leurs propres tests, en rendant
 * explicitement sous `NextIntlClientProvider` — le vrai, que cette amorce
 * laisse intact.
 *
 * ## Ce que l'amorce remplace, et ce qu'elle garde
 *
 * Quatre points d'entrée — `useTranslations` et `useLocale` de `next-intl`,
 * `getTranslations` et `getLocale` de `next-intl/server` — dont la seule
 * dépendance est le contexte de la requête. Le **formatage** reste celui de la
 * bibliothèque : `createTranslator` est le formateur ICU de `next-intl`, appelé
 * sur les catalogues du dépôt. Un test qui vérifie « Bienvenue chez Maison
 * Lotus » éprouve donc le vrai message et la vraie substitution de paramètres,
 * pas une table de doublure qui pourrait en diverger.
 *
 * Les catalogues sont lus par `loadMessages`, comme le serveur les lit : une clé
 * manquante dans `messages/fr/` échoue ici comme elle échouerait en production.
 *
 * ## Pourquoi `next-intl/server` aussi
 *
 * Les trois coquilles ont des layouts **asynchrones** — `generateMetadata` et le
 * layout de l'espace client —, et un composant asynchrone ne peut pas appeler un
 * crochet : il lit ses messages par `getTranslations`. Sous jsdom, l'export
 * `next-intl/server` résout vers la variante client de la bibliothèque, qui lève
 * *« `getTranslations` is not supported in Client Components »* — non parce que
 * le code est fautif, mais parce qu'aucune requête n'existe pour porter la
 * langue. L'amorce la fournit, comme elle la fournit aux crochets.
 *
 * ## Deux lignes, et rien de plus (#1283)
 *
 * L'amorce n'est qu'un cas particulier de la doublure à langue figée : celui où
 * la langue est `fr`. Elle montait pourtant sa propre fabrique et son propre
 * cache, comme trois suites anglaises montaient les leurs — quatre écritures du
 * même mécanisme. Tout ce qui n'est pas le choix de la langue vit désormais dans
 * `langue-figee.ts` et `traducteur.ts`, y compris la mémoïsation du formateur
 * ICU, que les crochets et le serveur se partagent.
 *
 * Le compte est soldé depuis #1287 : les douze suites qui montaient encore la
 * leur à la main — `admin-staff-i18n`, `admin-planning-i18n`,
 * `transverse-i18n`… — passent toutes par `langue-figee.ts` ou
 * `langue-mobile.ts`, selon que leur langue est constante ou commutable. Le
 * mécanisme n'est plus écrit qu'une fois, dans `traducteur.ts`.
 */

/** La langue des suites — celle dans laquelle elles ont été écrites. */
export const TEST_LOCALE: Locale = 'fr';

vi.mock('next-intl', () => nextIntlFixe(TEST_LOCALE));

vi.mock('next-intl/server', () => nextIntlServerFixe(TEST_LOCALE));
