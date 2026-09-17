'use server';

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
 */

export interface SalonFinderState {
  /** Ce qui a été saisi, rendu tel quel pour que l'erreur ne l'efface pas. */
  readonly address: string;
  /** Le message du champ — adresse vide, illisible, ou d'aucun salon. */
  readonly fieldError: string | null;
  /** Le message de l'encart — la vérification n'a pas pu avoir lieu. */
  readonly formError: string | null;
}

const EMPTY_ADDRESS_MESSAGE = 'Saisissez le nom de votre salon ou le lien qu’il vous a transmis.';

const UNAVAILABLE_MESSAGE =
  'Le service est momentanément injoignable. Merci de réessayer dans un instant.';

function unknownSalonMessage(address: string): string {
  return `Aucun salon ne répond à « ${address} ». Vérifiez le lien reçu dans votre e-mail de confirmation, ou demandez-le au salon.`;
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

  if (address === '') {
    return { address, fieldError: EMPTY_ADDRESS_MESSAGE, formError: null };
  }

  const slug = salonSlugFromAddress(address);

  if (slug === null) {
    return { address, fieldError: unknownSalonMessage(address), formError: null };
  }

  const identity = await readSalonIdentity(slug);

  if (identity.status === 'unknown') {
    return { address, fieldError: unknownSalonMessage(address), formError: null };
  }

  if (identity.status === 'unavailable') {
    return { address, fieldError: null, formError: UNAVAILABLE_MESSAGE };
  }

  await rememberSalon(identity.slug);
  // Hors de tout `try` : `redirect` lève, et c'est ainsi que Next l'exécute.
  redirect(salonDoorPath(identity.slug, door));
}
