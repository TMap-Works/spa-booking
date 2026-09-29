/**
 * Un refus d'action gardé en état : son **code**, jamais sa phrase — #1327.
 *
 * ## Le défaut que ce module referme
 *
 * Six surfaces rangeaient le texte d'un refus dans un `useState<string>`. Le
 * sélecteur de langue du rail pose un cookie et laisse Next rejouer la route
 * **sans navigation** (`i18n/actions.ts`) : les composants se rendent à nouveau,
 * leur état ne bouge pas. La phrase déjà rangée restait donc écrite dans la
 * langue d'avant, et l'écran devenait bilingue — « Sign-in refused » au-dessus
 * de « Adresse e-mail ou mot de passe incorrect. ». Tout redevenait correct au
 * rechargement, ce qui est exactement ce qui rendait le défaut discret.
 *
 * La règle est celle de la skill `web-frontend` §2 — « les composants réagissent
 * sur `code`, jamais sur `message` » — appliquée à ce qui **survit à un
 * rendu** : ce qui va en état est un code et ses paramètres, et la phrase se
 * calcule au rendu, dans la langue que ce rendu-là lit.
 *
 * ## Pourquoi un module, et non six tables locales
 *
 * La table `code → clé de catalogue` reste **propre à chaque écran** : c'est elle
 * qui porte ce que cet écran-là sait dire de mieux que le contrat — « connectez-vous »
 * pour une adresse déjà inscrite, « l'export n'est pas disponible sur cet
 * environnement ». Ce qui se partage n'est pas cette table, c'est la forme de
 * l'état et le **repli** : la phrase du contrat partagé pour un code que l'écran
 * ne nomme pas. Écrit six fois, ce repli finissait par manquer quelque part — et
 * c'est précisément ce que #1234 avait corrigé sur l'abonnement, seul.
 *
 * Le précédent est `app/plateforme/components/tenant-table.tsx` (#1106), qui
 * garde déjà une clé et la traduit au rendu ; ce module en fait la règle du
 * front plutôt qu'un cas isolé.
 */

import { errorMessage, type Locale } from '@spa/shared';

/**
 * Ce qu'un composant garde d'un refus d'action.
 *
 * Le code, et rien de plus : les paramètres d'affichage qu'un écran ajoute — un
 * créneau perdu, un nom de fichier — sont des **données**, et se rangent à côté,
 * dans le type de l'écran. Une donnée ne se démode pas quand la langue change ;
 * une phrase, oui.
 */
export interface Refusal {
  /** Le `code` du corps d'erreur standard (`{ code, message, details }`). */
  readonly code: string;
}

/**
 * La phrase d'un refus, écrite **au rendu**, dans la langue de ce rendu.
 *
 * `own` est ce que l'écran dit de mieux que le contrat : il rend la phrase du
 * catalogue de cet écran pour les codes qu'il traite en propre, et `null` pour
 * tous les autres. Le repli est alors `errorMessage` du contrat partagé — la
 * phrase de ce code dans la langue lue, et celle d'`INTERNAL_ERROR` pour un code
 * que le contrat ne nomme pas non plus.
 *
 * Ce repli est la moitié qui compte : sans lui, un écran retombait sur le
 * `message` rendu par le serveur, c'est-à-dire sur une phrase française sous un
 * écran anglais (#1234).
 */
export function refusalMessage(
  refusal: Refusal,
  locale: Locale,
  own?: (code: string) => string | null,
): string {
  return own?.(refusal.code) ?? errorMessage(refusal.code, locale);
}
