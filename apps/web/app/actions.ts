'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import { salonSlugFromAddress } from '@/lib/salon-address';
import { readSalonIdentity } from '@/lib/salon-identity';

import { rememberSalon } from './last-salon';
import { isSalonDoor, salonDoorPath, type SalonDoor } from './salon-doors';

/**
 * Ouvrir un salon depuis la page d'accueil (#927).
 *
 * C'est ce qui dispense de taper une URL : la personne donne l'adresse qu'elle
 * connaît — un nom, un identifiant, un lien collé — et choisit la porte. Le
 * salon est **vérifié avant** la redirection, pour que l'erreur se dise sur le
 * champ qui l'a portée (web-frontend §4) plutôt que par une page 404 où il n'y a
 * plus rien à corriger.
 *
 * ## La langue (#1233)
 *
 * Les trois messages rendus par cette action étaient écrits ici, en français —
 * le formulaire qui les affiche (`components/home/salon-finder.tsx`) le
 * signalait lui-même. Ils viennent désormais du namespace `booking`, racine
 * `home.finder.errors`, celui-là même où le formulaire lit ses libellés : le
 * message de refus et le champ qui le porte se lisent dans la même langue, et
 * s'écrivent au même endroit.
 *
 * `getTranslations` de `next-intl/server` et non `useTranslations` : une action
 * serveur n'est pas un composant, aucun crochet n'y est appelable. La langue
 * est celle que `i18n/server.ts` résout sur la requête — la soumission du
 * formulaire en est une, et elle porte les mêmes cookies et le même
 * `Accept-Language` que le rendu de la page.
 */

export interface SalonFinderState {
  /** Ce qui a été saisi, rendu tel quel pour que l'erreur ne l'efface pas. */
  readonly address: string;
  /** Le message du champ — adresse vide, illisible, ou d'aucun salon. */
  readonly fieldError: string | null;
  /** Le message de l'encart — la vérification n'a pas pu avoir lieu. */
  readonly formError: string | null;
}

export async function openSalonAction(
  _previous: SalonFinderState,
  formData: FormData,
): Promise<SalonFinderState> {
  const rawAddress = formData.get('adresse');
  const address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
  const rawDoor = formData.get('porte');
  // Entrée au clavier : le navigateur soumet avec le premier bouton du
  // formulaire, qui est la réservation. Une valeur inventée y retombe aussi.
  const door: SalonDoor = isSalonDoor(rawDoor) ? rawDoor : 'reservation';
  const t = await getTranslations('booking');

  if (address === '') {
    return { address, fieldError: t('home.finder.errors.empty'), formError: null };
  }

  const slug = salonSlugFromAddress(address);

  if (slug === null) {
    return { address, fieldError: t('home.finder.errors.unknown', { address }), formError: null };
  }

  const identity = await readSalonIdentity(slug);

  if (identity.status === 'unknown') {
    return { address, fieldError: t('home.finder.errors.unknown', { address }), formError: null };
  }

  if (identity.status === 'unavailable') {
    return { address, fieldError: null, formError: t('home.finder.errors.unavailable') };
  }

  await rememberSalon(identity.slug);
  // Hors de tout `try` : `redirect` lève, et c'est ainsi que Next l'exécute.
  redirect(salonDoorPath(identity.slug, door));
}
