'use server';

/**
 * Les actions serveur du personnel — comptes, horaires, absences, affectations
 * (#53).
 *
 * Elles vivent à part de `../actions.ts` et de `../catalogue/actions.ts` pour la
 * raison qui a déjà fait séparer les secondes : un fichier `'use server'` expose
 * **chacun** de ses exports comme un point d'entrée appelable depuis le
 * navigateur. Réunir la connexion, le catalogue et le personnel dans un seul
 * module ferait grossir cette surface au rythme du back-office, et il
 * deviendrait impossible de dire d'un coup d'œil ce qu'un écran donné peut
 * déclencher.
 *
 * Trois règles y tiennent, comme partout ailleurs dans ce back-office :
 *
 * - **aucune action ne rend un jeton d'accès.** Ce qu'elles rendent est ce qu'un
 *   écran affiche ; les jetons restent dans les cookies `httpOnly` de
 *   `../session.ts`. Le *jeton d'invitation* fait exception et n'en est pas une :
 *   c'est une donnée métier destinée à être recopiée par l'administrateur, pas
 *   un secret de session — il quittera cette réponse le jour où `notifications`
 *   expédiera le lien ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel vienne du
 *   formulaire, et l'API revalidera de son côté (web-frontend §4). Les schémas
 *   sont ceux de `@spa/shared` — la même règle des deux côtés, écrite une fois ;
 * - **aucun `tenantId` ne circule.** L'établissement vient du jeton vérifié, et
 *   le slug qu'on passe ici ne sert qu'à retrouver le cookie et à recalculer les
 *   chemins de revalidation.
 */

import {
  assignServiceStaffRequestSchema,
  createStaffMemberRequestSchema,
  createStaffTimeOffRequestSchema,
  setStaffScheduleRequestSchema,
  slugSchema,
  updateStaffMemberRequestSchema,
  uuidSchema,
  type ServiceStaffMember,
  type StaffAccountState,
  type StaffMember,
  type StaffSchedule,
  type StaffTimeOff,
} from '@spa/shared';
import { revalidatePath } from 'next/cache';

import {
  assignServiceStaff,
  changeStaffAccountRole,
  createStaffMember,
  createStaffTimeOff,
  deleteStaffTimeOff,
  inviteStaffAccount,
  reissueStaffInvitation,
  removeServiceStaff,
  setStaffAccountStatus,
  setStaffSchedule,
  updateStaffMember,
} from '@/lib/api-client';
import {
  changeStaffRoleRequestSchema,
  inviteStaffAccountRequestSchema,
  setStaffAccountStatusRequestSchema,
  type StaffAccount,
  type StaffInvitation,
} from '@/lib/admin/staff-contract';

import { failure, invalid, type AdminActionResult } from '../action-result';
import { adminCalendarPath } from '../paths';
import { adminActionAccess } from '../session';
import { adminStaffMemberPath, adminStaffPath } from './paths';

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

  const access = await adminActionAccess(slug.data);

  return access.ok ? { ok: true, accessToken: access.accessToken, slug: slug.data } : access;
}

/** Le message du premier refus de schéma — celui qui nomme la faute. */
function firstIssue(issues: readonly { readonly message: string }[], fallback: string): string {
  return issues[0]?.message ?? fallback;
}

/** Rafraîchit la liste du personnel, que toute écriture de compte périme. */
function revalidateStaffList(slug: string): void {
  revalidatePath(adminStaffPath(slug), 'layout');
}

/**
 * Rafraîchit ce qu'une modification d'agenda périme — cinquième critère de #53.
 *
 * Horaires et absences ne changent pas seulement la fiche : ils changent les
 * créneaux que le moteur propose, donc le planning du comptoir. L'API invalide
 * son propre cache de disponibilité ; ce qu'il reste à faire ici est de périmer
 * les pages **rendues côté serveur**, sans quoi elles continueraient d'afficher
 * l'agenda d'avant l'enregistrement jusqu'à la prochaine navigation dure.
 *
 * Le parcours public n'a pas besoin d'y figurer : il lit les créneaux en
 * `no-store` — servir une disponibilité depuis un cache est précisément ce qui
 * produit un 409 à la validation.
 */
function revalidateStaffAgenda(slug: string, staffId: string): void {
  revalidatePath(adminStaffMemberPath(slug, staffId));
  revalidatePath(adminCalendarPath(slug), 'page');
}

/**
 * Invite un membre du personnel.
 *
 * La réponse porte le jeton d'invitation : l'écran l'affiche à l'administrateur
 * qui vient de le demander, à charge pour lui de le transmettre. Un 409 signifie
 * que l'adresse est déjà prise dans cet établissement — y compris par une
 * cliente : la faire passer au personnel est un changement de rôle, pas une
 * création.
 */
export async function inviteStaffAccountAction(
  tenantSlug: string,
  input: unknown,
): Promise<AdminActionResult<StaffInvitation>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const parsed = inviteStaffAccountRequestSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'Les informations saisies sont invalides.'));
  }

  try {
    const invitation = await inviteStaffAccount(call.accessToken, parsed.data);
    revalidateStaffList(call.slug);
    return { ok: true, data: invitation };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Crée la fiche praticien d'un compte du personnel — #694.
 *
 * C'est le geste qui rend une personne **réservable**. Inviter un compte ne
 * suffisait pas : le compte porte l'accès, la fiche porte l'agenda, et tant que
 * la seconde n'existait pas le parcours de réservation s'arrêtait à « aucun
 * créneau », faute de praticien à qui affecter une prestation.
 *
 * Deux refus à distinguer pour l'écran : un 409
 * `STAFF_PROFILE_ALREADY_EXISTS` dit que ce compte a déjà sa fiche — il n'y a
 * rien à recréer —, un 404 que l'identifiant ne désigne aucun compte interne
 * d'ici. Le second ne devrait pas se produire depuis la liste, qui ne propose
 * que des comptes qu'elle vient de lire ; il arrive si la personne a été
 * supprimée entre l'affichage et la soumission.
 *
 * `serviceIds` n'est pas envoyé : le contrat ne le décrit plus, et l'affectation
 * des prestations se fait depuis la fiche, une fois qu'elle existe.
 */
export async function createStaffMemberAction(
  tenantSlug: string,
  input: unknown,
): Promise<AdminActionResult<StaffMember>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const parsed = createStaffMemberRequestSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'Les informations saisies sont invalides.'));
  }

  try {
    const member = await createStaffMember(call.accessToken, parsed.data);
    revalidateStaffList(call.slug);
    return { ok: true, data: member };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Corrige une fiche praticien, la suspend ou la réactive — #705.
 *
 * ## Ce que cette action périme, et pourquoi c'est plus que la fiche
 *
 * Trois écrans montrent ce que `PATCH /v1/staff/:id` change. La **fiche** porte
 * le nom en titre et l'encart de suspension ; la **liste du personnel** porte le
 * même nom et le badge « Active » / « Suspendue » — c'est même le seul endroit
 * d'où l'on voit l'ensemble de l'équipe ; le **planning** montre des créneaux
 * qu'une fiche suspendue cesse de produire. Ne périmer que la première laisserait
 * la liste afficher l'ancien nom jusqu'à la prochaine navigation dure, ce qui est
 * exactement le genre d'écart qu'on prend pour une écriture perdue.
 *
 * `revalidateStaffAgenda` couvre les deux dernières, `revalidateStaffList` la
 * liste : la suspension agit sur la disponibilité au même titre qu'un horaire
 * effacé, et les réunir ici plutôt que d'écrire un troisième helper garde une
 * seule définition de « ce qu'une écriture d'agenda périme ».
 *
 * ## Le corps ne porte que ce qui change
 *
 * `updateStaffMemberRequestSchema` est `.partial()` et `.strict()` : chacun des
 * trois champs est facultatif, et rien d'autre ne passe. C'est l'écran qui
 * décide de ce qu'il envoie — en particulier, il n'envoie **pas** `bio` tant que
 * la présentation n'a pas été touchée, faute de pouvoir la relire (aucune route
 * ne la publie), et il envoie `null` — jamais `""` — pour l'effacer.
 *
 * Un 404 signifie que la fiche n'existe pas, ou qu'elle appartient à
 * l'établissement voisin : les deux se répondent pareil.
 */
export async function updateStaffMemberAction(
  tenantSlug: string,
  staffId: string,
  input: unknown,
): Promise<AdminActionResult<StaffMember>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(staffId);
  const parsed = updateStaffMemberRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Praticien inconnu.');
  }
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'Les informations saisies sont invalides.'));
  }

  try {
    const member = await updateStaffMember(call.accessToken, id.data, parsed.data);
    revalidateStaffAgenda(call.slug, id.data);
    revalidateStaffList(call.slug);
    return { ok: true, data: member };
  } catch (error) {
    return failure(error);
  }
}

/** Réémet l'invitation d'un compte jamais activé — 409 s'il l'a déjà été. */
export async function reissueStaffInvitationAction(
  tenantSlug: string,
  userId: string,
): Promise<AdminActionResult<StaffInvitation>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(userId);
  if (!id.success) {
    return invalid('Compte inconnu.');
  }

  try {
    return { ok: true, data: await reissueStaffInvitation(call.accessToken, id.data) };
  } catch (error) {
    return failure(error);
  }
}

/*
 * `PATCH /v1/users/:id` — corriger les coordonnées d'une collègue — n'a
 * délibérément **pas** d'action ici : aucun écran de ce ticket ne les modifie,
 * et un export de ce module est un point d'entrée appelable depuis le
 * navigateur. En poser un « au cas où » élargirait la surface de l'application
 * pour un formulaire qui n'existe pas. Il s'écrira avec l'écran qui en aura
 * besoin.
 */

/**
 * Attribue un rôle — réservé aux administrateurs côté API.
 *
 * Le schéma d'ici borne le choix aux rôles **internes** : l'API accepterait
 * `CLIENT`, et rétrograder une gérante en cliente la ferait disparaître de la
 * liste du personnel sans qu'aucun écran ne sache l'y ramener.
 */
export async function changeStaffAccountRoleAction(
  tenantSlug: string,
  userId: string,
  input: unknown,
): Promise<AdminActionResult<StaffAccount>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(userId);
  const parsed = changeStaffRoleRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Compte inconnu.');
  }
  if (!parsed.success) {
    return invalid('Choisissez un rôle du personnel.');
  }

  try {
    const account = await changeStaffAccountRole(call.accessToken, id.data, parsed.data);
    revalidateStaffList(call.slug);
    return { ok: true, data: account };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Désactive ou réactive un compte.
 *
 * **Ce n'est pas une suppression** : le compte, ses affectations et ses
 * rendez-vous passés restent intacts. Un 422 signifie que l'appelant s'est visé
 * lui-même — le dernier administrateur qui se désactive ferme la porte de
 * l'intérieur.
 */
export async function setStaffAccountStatusAction(
  tenantSlug: string,
  userId: string,
  input: unknown,
): Promise<AdminActionResult<StaffAccountState>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(userId);
  const parsed = setStaffAccountStatusRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Compte inconnu.');
  }
  if (!parsed.success) {
    return invalid('Indiquez si le compte doit être actif.');
  }

  try {
    const state = await setStaffAccountStatus(call.accessToken, id.data, parsed.data);
    revalidateStaffList(call.slug);
    return { ok: true, data: state };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Remplace la semaine de travail d'un praticien — deuxième critère.
 *
 * Le corps porte la semaine **entière**, y compris les jours laissés vides :
 * c'est ainsi qu'une plage se retire, et c'est la seule forme sur laquelle le
 * non-recouvrement se vérifie d'un coup.
 */
export async function setStaffScheduleAction(
  tenantSlug: string,
  staffId: string,
  input: unknown,
): Promise<AdminActionResult<StaffSchedule>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const id = uuidSchema.safeParse(staffId);
  const parsed = setStaffScheduleRequestSchema.safeParse(input);

  if (!id.success) {
    return invalid('Praticien inconnu.');
  }
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'La semaine saisie est invalide.'));
  }

  try {
    const schedule = await setStaffSchedule(call.accessToken, id.data, parsed.data);
    revalidateStaffAgenda(call.slug, id.data);
    return { ok: true, data: schedule };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Pose une plage bloquée ou un congé — troisième critère.
 *
 * Les bornes arrivent déjà en date-heure à offset explicite : le fuseau de
 * l'établissement a été appliqué côté écran, où il est connu, plutôt que deviné
 * côté serveur. Un 422 `TIME_OFF_RANGE_INVALID` signifie que l'intervalle est
 * vide ou dépasse un an.
 */
export async function createStaffTimeOffAction(
  tenantSlug: string,
  input: unknown,
): Promise<AdminActionResult<StaffTimeOff>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const parsed = createStaffTimeOffRequestSchema.safeParse(input);
  if (!parsed.success) {
    return invalid(firstIssue(parsed.error.issues, 'L’absence saisie est invalide.'));
  }

  try {
    const timeOff = await createStaffTimeOff(call.accessToken, parsed.data);
    revalidateStaffAgenda(call.slug, parsed.data.staffId);
    return { ok: true, data: timeOff };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Retire une absence, et rouvre l'agenda d'autant.
 *
 * `staffId` n'est pas envoyé — l'API désigne l'absence par son seul identifiant
 * — mais il est exigé ici : c'est lui qui dit quelle fiche périmer. Le déduire
 * de la réponse serait impossible, un 204 n'en a pas.
 */
export async function deleteStaffTimeOffAction(
  tenantSlug: string,
  staffId: string,
  timeOffId: string,
): Promise<AdminActionResult<null>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const staff = uuidSchema.safeParse(staffId);
  const timeOff = uuidSchema.safeParse(timeOffId);

  if (!staff.success || !timeOff.success) {
    return invalid('Absence inconnue.');
  }

  try {
    await deleteStaffTimeOff(call.accessToken, timeOff.data);
    revalidateStaffAgenda(call.slug, staff.data);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Affecte une prestation à un praticien — quatrième critère, vu **depuis la
 * fiche du praticien**.
 *
 * L'API n'a qu'un sens de lecture pour cette relation :
 * `POST /v1/services/{serviceId}/staff`. Ce n'est donc pas une seconde route,
 * c'est la même, appelée depuis l'autre bout. Ce qui change est ce qu'il faut
 * périmer ensuite — la fiche du praticien, et non le catalogue —, et c'est
 * exactement pourquoi cette action ne réutilise pas celle de `../catalogue` : la
 * revalidation fait partie de l'action, pas de l'appel HTTP.
 */
export async function assignStaffServiceAction(
  tenantSlug: string,
  staffId: string,
  serviceId: string,
): Promise<AdminActionResult<ServiceStaffMember>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const service = uuidSchema.safeParse(serviceId);
  const parsed = assignServiceStaffRequestSchema.safeParse({ staffId });

  if (!service.success) {
    return invalid('Prestation inconnue.');
  }
  if (!parsed.success) {
    return invalid('Praticien inconnu.');
  }

  try {
    const member = await assignServiceStaff(call.accessToken, service.data, parsed.data);
    revalidateStaffAgenda(call.slug, parsed.data.staffId);
    return { ok: true, data: member };
  } catch (error) {
    return failure(error);
  }
}

/** Retire l'affectation. Les rendez-vous déjà pris portent leur propre praticien. */
export async function removeStaffServiceAction(
  tenantSlug: string,
  staffId: string,
  serviceId: string,
): Promise<AdminActionResult<null>> {
  const call = await openCall(tenantSlug);
  if (!call.ok) {
    return call;
  }

  const staff = uuidSchema.safeParse(staffId);
  const service = uuidSchema.safeParse(serviceId);

  if (!staff.success || !service.success) {
    return invalid('Affectation inconnue.');
  }

  try {
    await removeServiceStaff(call.accessToken, service.data, staff.data);
    revalidateStaffAgenda(call.slug, staff.data);
    return { ok: true, data: null };
  } catch (error) {
    return failure(error);
  }
}
