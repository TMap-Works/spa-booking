'use server';

/**
 * Les actions serveur du fichier client (#54).
 *
 * Elles vivent à part de `../actions.ts`, `../catalogue/actions.ts` et
 * `../personnel/actions.ts` pour la raison qui a déjà séparé les trois : un
 * module `'use server'` expose **chacun** de ses exports comme un point d'entrée
 * appelable depuis le navigateur. Réunir la connexion, le catalogue, le
 * personnel et les fiches clientes dans un seul fichier ferait grossir cette
 * surface au rythme du back-office, et il deviendrait impossible de dire d'un
 * coup d'œil ce qu'un écran donné peut déclencher.
 *
 * Ce module n'en expose qu'**un**, et c'est délibéré : la liste, la fiche et
 * l'historique sont lus par le Server Component, qui appelle le client d'API
 * directement — sans aller-retour de plus, et sans ouvrir au navigateur une
 * lecture du fichier client qu'il n'a aucune raison de pouvoir déclencher.
 * `POST /customers` n'en a pas non plus : la création au comptoir est servie par
 * le tiroir du planning (#50), et un second point d'entrée sur la même route
 * serait une surface de plus pour un geste déjà livré.
 *
 * Trois règles y tiennent, comme partout ailleurs dans ce back-office :
 *
 * - **aucune action ne rend un jeton d'accès.** Ce qu'elles rendent est ce qu'un
 *   écran affiche ; les jetons restent dans les cookies `httpOnly` de
 *   `../session.ts` ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel vienne du
 *   formulaire, et l'API revalidera de son côté (web-frontend §4). Le schéma est
 *   celui de `@spa/shared` — la même règle des deux côtés, écrite une fois ;
 * - **aucun `tenantId` ne circule.** L'établissement vient du jeton vérifié, et
 *   le slug reçu ici ne sert qu'à retrouver le cookie de session de ce
 *   back-office et à recalculer le chemin à périmer. Il ne descend jamais
 *   jusqu'à l'API : `updateCustomer` n'a aucun paramètre pour l'accepter.
 */

import { slugSchema, updateCustomerRequestSchema, uuidSchema, type Customer } from '@spa/shared';
import { revalidatePath } from 'next/cache';

import { updateCustomer } from '@/lib/api-client';

import { expired, failure, invalid, type AdminActionResult } from '../action-result';
import { readAdminAccessToken } from '../session';
import { adminClientsPath } from './paths';

/**
 * Le préambule commun : slug licite, session ouverte.
 *
 * Rendu plutôt que levé, parce qu'une exception traverserait la frontière
 * serveur en perdant son type et n'arriverait au composant que comme un message
 * générique.
 */
async function openCall(
  tenantSlug: string,
): Promise<
  { ok: true; accessToken: string; slug: string } | { ok: false; code: string; message: string }
> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const accessToken = await readAdminAccessToken();

  return accessToken === null ? expired() : { ok: true, accessToken, slug: slug.data };
}

/**
 * Corrige les coordonnées ou la note interne d'une fiche — troisième critère.
 *
 * Une seule action pour les deux formulaires de l'écran, parce que c'est une
 * seule route : `PATCH /customers/:id` prend le nom, le prénom, le téléphone et
 * la note, et un champ **absent** vaut « ne touche pas ». Le formulaire des
 * notes n'envoie donc que `internalNote`, celui des coordonnées les trois
 * autres, et ni l'un ni l'autre ne risque d'effacer ce qu'il n'affiche pas.
 *
 * `null` est la valeur par laquelle on **efface** — c'est ainsi qu'une note
 * retirée disparaît vraiment. La chaîne vide descendrait jusqu'à la colonne
 * comme une note d'un caractère nul, que la fiche afficherait ensuite comme une
 * note existante et vide.
 *
 * Un 404 signifie que la fiche n'est pas dans le fichier de cet établissement —
 * inconnue, du salon voisin, ou compte du personnel : l'API ne les distingue
 * pas, et l'écran non plus (tenant-isolation §4).
 */
export async function updateCustomerAction(
  tenantSlug: string,
  customerId: string,
  input: unknown,
): Promise<AdminActionResult<Customer>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(customerId);
  const parsed = updateCustomerRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Fiche cliente inconnue.');
  }
  if (!parsed.success) {
    return invalid(
      parsed.error.issues[0]?.message ?? 'Les informations saisies sont invalides.',
    );
  }

  try {
    const customer = await updateCustomer(call.accessToken, id.data, parsed.data);

    // La fiche est rendue par la page, pas par un composant client : sans cette
    // péremption, la note enregistrée resterait invisible jusqu'à la prochaine
    // navigation dure. C'est le **chemin** de la route qui est périmé, sans
    // chaîne de requête : `revalidatePath` raisonne sur les segments, et lui
    // passer `?fiche=…` ne périmerait rien de plus — tout en laissant croire
    // que la péremption est ciblée sur une fiche.
    revalidatePath(adminClientsPath(call.slug), 'page');

    return { ok: true, data: customer };
  } catch (error) {
    return failure(error);
  }
}
