'use server';

import { cookies } from 'next/headers';

import { LOCALE_COOKIE, localeCookieOptions } from './cookies';
import { asLocale } from './resolve';

/**
 * Le changement de langue — #845, septième critère d'acceptation.
 *
 * ## Trois exigences, et comment elles sont tenues
 *
 * - **« Le choix est conservé d'une visite à l'autre »** : un cookie d'un an sur
 *   `/`, et non un état de composant. Voir `cookies.ts` pour les attributs.
 * - **« Il s'applique sans quitter la page en cours »** : c'est une action
 *   serveur, appelée par le `<form>` du sélecteur. Next rejoue la route courante
 *   après l'action, sans navigation ni changement d'adresse — le tunnel de
 *   réservation ne perd donc pas son étape, et un formulaire en cours de saisie
 *   n'est pas démonté.
 * - **Sans JavaScript aussi** : un `<form action={…}>` soumis par le navigateur
 *   appelle la même action. Le sélecteur n'a besoin d'aucun état client, et
 *   n'est donc pas un Client Component.
 *
 * ## Ce qu'elle refuse
 *
 * Tout ce qui n'est pas une des deux langues du contrat. La valeur vient d'un
 * formulaire, donc du navigateur : `asLocale` la normalise et la juge, et une
 * valeur refusée **ne touche pas au cookie**. Effacer la préférence en place sur
 * une soumission trafiquée ferait d'un champ caché un moyen de déranger la
 * langue de quelqu'un d'autre.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = asLocale(formData.get('locale')?.toString());

  if (locale === null) {
    return;
  }

  (await cookies()).set(LOCALE_COOKIE, locale, localeCookieOptions());
}
