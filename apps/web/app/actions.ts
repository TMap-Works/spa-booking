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
 *
 * ## La langue (#1233, puis #1354)
 *
 * Les trois messages rendus par cette action étaient écrits ici, en français —
 * le formulaire qui les affiche (`components/home/salon-finder.tsx`) le
 * signalait lui-même. Ils viennent du namespace `booking`, racine
 * `home.finder.errors`, celui-là même où le formulaire lit ses libellés.
 *
 * Ce que l'action rend n'est plus la **phrase** mais le **motif** du refus, et
 * c'est le formulaire qui l'écrit au rendu (#1354). La raison est que
 * `useActionState` garde ce résultat : le sélecteur de langue pose un cookie et
 * laisse Next rejouer la route **sans navigation** (`i18n/actions.ts`), si bien
 * que le composant se rend à nouveau mais que son état ne bouge pas. Une phrase
 * rangée ici restait donc écrite dans la langue de la soumission — « aucun salon
 * ne répond à cette adresse » sous un champ passé en anglais. Un motif, lui, ne
 * se démode pas : c'est une donnée. Même règle que `lib/refusal.ts` pour les
 * refus d'action et `lib/field-refusal.ts` pour ceux des champs.
 *
 * L'action n'a plus aucun message à lire, et donc plus besoin de
 * `getTranslations` : la langue n'intervient qu'au rendu, celui-là même qui
 * affiche le champ.
 */

/**
 * Le **motif** d'un refus — jamais sa phrase, voir l'en-tête.
 *
 * Il vaut aussi clé de catalogue, sous `home.finder.errors` : `empty` et
 * `unknown` se disent sur le champ, `unavailable` dans l'encart. Le salon que
 * `unknown` nomme n'a pas à voyager ici — c'est l'`address` de l'état, que le
 * formulaire a déjà sous la main.
 */
export type SalonFinderRefusal = 'empty' | 'unknown' | 'unavailable';

export interface SalonFinderState {
  /** Ce qui a été saisi, rendu tel quel pour que l'erreur ne l'efface pas. */
  readonly address: string;
  /** Le refus du champ — adresse vide, illisible, ou d'aucun salon. */
  readonly fieldRefusal: SalonFinderRefusal | null;
  /** Le refus de l'encart — la vérification n'a pas pu avoir lieu. */
  readonly formRefusal: SalonFinderRefusal | null;
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
    return { address, fieldRefusal: 'empty', formRefusal: null };
  }

  const slug = salonSlugFromAddress(address);

  if (slug === null) {
    return { address, fieldRefusal: 'unknown', formRefusal: null };
  }

  const identity = await readSalonIdentity(slug);

  if (identity.status === 'unknown') {
    return { address, fieldRefusal: 'unknown', formRefusal: null };
  }

  if (identity.status === 'unavailable') {
    return { address, fieldRefusal: null, formRefusal: 'unavailable' };
  }

  await rememberSalon(identity.slug);
  // Hors de tout `try` : `redirect` lève, et c'est ainsi que Next l'exécute.
  redirect(salonDoorPath(identity.slug, door));
}
