'use server';

/**
 * Les actions serveur du catalogue — prestations, rubriques, affectations (#52).
 *
 * Elles vivent à part de `../actions.ts` pour une raison de fond : un fichier
 * `'use server'` expose **chacun** de ses exports comme un point d'entrée
 * appelable depuis le navigateur. Réunir la connexion, les réglages et le
 * catalogue dans un seul module ferait grossir cette surface au rythme du
 * back-office, et il deviendrait vite impossible de dire d'un coup d'œil ce
 * qu'un écran donné peut déclencher.
 *
 * Trois règles y tiennent, comme dans l'espace client :
 *
 * - **aucune action ne rend un jeton.** Ce qu'elles rendent est ce qu'un écran
 *   affiche ; les jetons restent dans les cookies `httpOnly` de `../session.ts` ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel vienne du
 *   formulaire, et l'API revalidera de son côté (web-frontend §4). Les schémas
 *   sont ceux de `@spa/shared` — la même règle des deux côtés, écrite une fois ;
 * - **aucun `tenantId` ne circule.** L'établissement vient du jeton vérifié, et
 *   le slug qu'on passe ici ne sert qu'à retrouver le cookie et à recalculer les
 *   chemins de revalidation.
 */

import {
  assignServiceStaffRequestSchema,
  createServiceCategoryRequestSchema,
  createServiceRequestSchema,
  slugSchema,
  updateServiceCategoryRequestSchema,
  updateServiceRequestSchema,
  uuidSchema,
  type Service,
  type ServiceCategory,
  type ServiceStaffMember,
} from '@spa/shared';
import { revalidatePath } from 'next/cache';

import {
  assignServiceStaff,
  createService,
  createServiceCategory,
  removeServiceStaff,
  updateService,
  updateServiceCategory,
} from '@/lib/api-client';

import { expired, failure, invalid, type AdminActionResult } from '../action-result';
import { adminCatalogPath, adminServiceCategoriesPath, adminServicePath } from '../paths';
import { readAdminAccessToken } from '../session';

/**
 * Le préambule commun : slug licite, session ouverte.
 *
 * Rendu plutôt que levé, parce qu'une exception traverserait la frontière
 * serveur en perdant son type et n'arriverait au composant que comme un message
 * générique.
 */
async function openCall(
  tenantSlug: string,
): Promise<{ ok: true; accessToken: string; slug: string } | { ok: false; code: string; message: string }> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const accessToken = await readAdminAccessToken();

  return accessToken === null ? expired() : { ok: true, accessToken, slug: slug.data };
}

/**
 * Rafraîchit les écrans que l'écriture vient de périmer.
 *
 * Les pages du catalogue sont rendues côté serveur : sans cet appel, la liste
 * continuerait d'afficher le prix d'avant l'enregistrement jusqu'à la prochaine
 * navigation dure. L'aperçu public en fait partie — c'est précisément l'écran
 * dont on vient vérifier qu'il reflète la modification.
 */
function revalidateCatalog(slug: string, serviceId?: string): void {
  revalidatePath(adminCatalogPath(slug), 'layout');
  if (serviceId !== undefined) {
    revalidatePath(adminServicePath(slug, serviceId));
  }
}

/** Le message du premier refus de schéma — celui qui nomme la faute. */
function firstIssue(issues: readonly { readonly message: string }[], fallback: string): string {
  return issues[0]?.message ?? fallback;
}

/** Crée une prestation. Le slug est dérivé du nom par le serveur s'il est absent. */
export async function createServiceAction(
  tenantSlug: string,
  input: unknown,
): Promise<AdminActionResult<Service>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const parsed = createServiceRequestSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'La prestation saisie est invalide.'));
  }

  try {
    const service = await createService(call.accessToken, parsed.data);
    revalidateCatalog(call.slug);
    return { ok: true, data: service };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Modifie une prestation — **et c'est aussi ainsi qu'on la désactive**.
 *
 * L'API n'expose aucun `DELETE` : les rendez-vous passés référencent la
 * prestation, et le reporting doit continuer à savoir ce qui a été vendu. La
 * charge utile est partielle, si bien que l'écran de la liste peut n'envoyer
 * que `{ isActive: false }` sans avoir à renvoyer le prix ni la durée — donc
 * sans risquer d'écraser ce qu'un collègue vient de changer.
 */
export async function updateServiceAction(
  tenantSlug: string,
  serviceId: string,
  changes: unknown,
): Promise<AdminActionResult<Service>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(serviceId);
  const parsed = updateServiceRequestSchema.safeParse(changes);

  if (!id.success) {
    return invalid('Prestation inconnue.');
  }
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'La prestation saisie est invalide.'));
  }

  try {
    const service = await updateService(call.accessToken, id.data, parsed.data);
    revalidateCatalog(call.slug, id.data);
    return { ok: true, data: service };
  } catch (error) {
    return failure(error);
  }
}

export async function createServiceCategoryAction(
  tenantSlug: string,
  input: unknown,
): Promise<AdminActionResult<ServiceCategory>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const parsed = createServiceCategoryRequestSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'La rubrique saisie est invalide.'));
  }

  try {
    const category = await createServiceCategory(call.accessToken, parsed.data);
    revalidatePath(adminServiceCategoriesPath(call.slug));
    revalidateCatalog(call.slug);
    return { ok: true, data: category };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Modifie une rubrique — renommage, description, activation.
 *
 * `description: null` **efface** le texte ; son absence n'y touche pas. Les deux
 * gestes sont distincts, et un formulaire vidé doit pouvoir dire le second.
 */
export async function updateServiceCategoryAction(
  tenantSlug: string,
  categoryId: string,
  changes: unknown,
): Promise<AdminActionResult<ServiceCategory>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(categoryId);
  const parsed = updateServiceCategoryRequestSchema.safeParse(changes);

  if (!id.success) {
    return invalid('Rubrique inconnue.');
  }
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'La rubrique saisie est invalide.'));
  }

  try {
    const category = await updateServiceCategory(call.accessToken, id.data, parsed.data);
    revalidatePath(adminServiceCategoriesPath(call.slug));
    revalidateCatalog(call.slug);
    return { ok: true, data: category };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Affecte **un** praticien à une prestation.
 *
 * Unitaire, et non « remplace la liste » : l'écran coche un praticien à la fois,
 * et lui faire envoyer l'ensemble à chaque clic écraserait les affectations
 * qu'un collègue vient d'ajouter. Un 409 signifie que l'affectation existe déjà
 * — l'écran le dit sans en faire une panne.
 */
export async function assignServiceStaffAction(
  tenantSlug: string,
  serviceId: string,
  input: unknown,
): Promise<AdminActionResult<ServiceStaffMember>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(serviceId);
  const parsed = assignServiceStaffRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Prestation inconnue.');
  }
  if (!parsed.success) {
    return invalid('Choisissez un praticien à affecter.');
  }

  try {
    const member = await assignServiceStaff(call.accessToken, id.data, parsed.data);
    revalidateCatalog(call.slug, id.data);
    return { ok: true, data: member };
  } catch (error) {
    return failure(error);
  }
}

/** Retire l'affectation. Aucun rendez-vous n'en dépend : ceux-ci portent leur propre praticien. */
export async function removeServiceStaffAction(
  tenantSlug: string,
  serviceId: string,
  staffId: string,
): Promise<AdminActionResult<null>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const service = uuidSchema.safeParse(serviceId);
  const staff = uuidSchema.safeParse(staffId);

  if (!service.success || !staff.success) {
    return invalid('Affectation inconnue.');
  }

  try {
    await removeServiceStaff(call.accessToken, service.data, staff.data);
    revalidateCatalog(call.slug, service.data);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}
