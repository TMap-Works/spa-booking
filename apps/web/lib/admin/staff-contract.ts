/**
 * Les formes que l'API du personnel sert et que `@spa/shared` ne décrit pas
 * encore telles quelles (#53).
 *
 * Même raison d'être que `payment-contract.ts`, et la même discipline : rien
 * n'est inventé ici. Chaque schéma décrit une charge utile que `apps/api` émet
 * ou attend **aujourd'hui**, et chacun est écrit à partir du DTO qui la produit.
 * Ce module est un point de passage, pas une seconde source de vérité.
 *
 * TODO(#536) : ces formes appartiennent au contrat partagé, et #510 a instruit
 * pourquoi elles n'y sont pas encore — les deux paragraphes qui suivent sont
 * cette justification, et non un renvoi. Le second est bloquant : tant que
 * l'API émet et exige `MANAGER` là où le contrat nomme `manager`, un schéma
 * partagé décrirait l'un ou l'autre, jamais les deux, et `toApiRole` ci-dessous
 * n'aurait plus d'endroit où vivre. C'est le premier point de vigilance de #510,
 * et il se tranche dans `packages/shared` et `identity` d'un même geste.
 *
 * ## Pourquoi elles n'y sont pas déjà
 *
 * `packages/shared` décrit `userSchema` — la **ligne** d'un compte, avec son
 * état d'activation et ses horodatages — quand `UserProfileDto` décrit ce qui
 * franchit réellement la frontière HTTP : six champs, sans `isActive` ni
 * `createdAt`. C'est exactement l'écart que `sessionUserSchema` a déjà tranché
 * pour `/auth/me`, et les routes d'administration des comptes rendent la même
 * forme. On la réemploie plutôt que d'en écrire une jumelle qui divergerait.
 *
 * ## La casse des rôles, et pourquoi elle ne peut pas s'ignorer
 *
 * L'API stocke et émet `STAFF`, `MANAGER`, `ADMIN` — la casse de l'énumération
 * PostgreSQL — là où le contrat partagé nomme les mêmes rôles en minuscules.
 * `receivedUserRoleSchema` referme l'écart **en lecture** ; il reste ouvert en
 * **écriture**, et un `role: 'manager'` posté tel quel se ferait refuser en 400
 * par le `@IsIn(STAFF_ROLES)` du DTO. La traduction se fait donc ici, une fois,
 * juste avant l'envoi — jamais dans un composant.
 */

import {
  STAFF_ROLES,
  emailSchema,
  nameSchema,
  phoneSchema,
  sessionUserSchema,
  type StaffRole,
  type UserRole,
} from '@spa/shared';
import { z } from 'zod';

/**
 * Un compte du personnel, tel que `GET /v1/users`, `GET /v1/users/:id`,
 * `PATCH /v1/users/:id` et `PATCH /v1/users/:id/role` le rendent.
 *
 * C'est `UserProfileDto`, et c'est déjà `sessionUserSchema` : même six champs,
 * même `phone` nullable, même conversion de casse du rôle. Réexporté sous le nom
 * du domaine plutôt que recopié, pour que le jour où l'un des deux bouge, il n'y
 * ait qu'un schéma à corriger.
 */
export const staffAccountSchema = sessionUserSchema;

export type StaffAccount = z.infer<typeof staffAccountSchema>;

/**
 * Le compte **avec** son état d'activation — réponse de
 * `PATCH /v1/users/:id/status`, et d'elle seule.
 *
 * `StaffAccountStateDto` étend `UserProfileDto` d'un booléen pour cette route :
 * les trois autres ne le portent pas, si bien que la liste du personnel ne peut
 * pas dire aujourd'hui qui est désactivé. L'écran le dit franchement plutôt que
 * de l'inventer — voir la note de la page.
 */
export const staffAccountStateSchema = staffAccountSchema.extend({
  isActive: z.boolean(),
});

export type StaffAccountState = z.infer<typeof staffAccountStateSchema>;

/**
 * Ce que rend l'émission d'une invitation — `POST /v1/users` et
 * `POST /v1/users/:id/invitation`.
 *
 * Le jeton est dans le corps parce que le module `notifications` n'expédie pas
 * encore de courriel : c'est l'administrateur qui invite qui le transmet. Il ne
 * doit donc **jamais** être journalisé ni affiché ailleurs que sur l'écran de
 * celui qui vient de le demander, et il disparaîtra de cette réponse le jour où
 * la chaîne d'envoi existera.
 */
export const staffInvitationSchema = z.object({
  user: staffAccountSchema,
  invitationToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export type StaffInvitation = z.infer<typeof staffInvitationSchema>;

/**
 * Les rôles qu'un écran de back-office peut attribuer.
 *
 * `STAFF_ROLES` et non `USER_ROLES` : `client` n'est pas un rôle du personnel.
 * L'API le refuse déjà à l'invitation (`InviteStaffMemberDto`) ; sur le
 * changement de rôle, en revanche, elle accepte les quatre — et rétrograder une
 * gérante en cliente la ferait disparaître de `GET /v1/users` sans qu'aucun
 * écran ne sache la retrouver. La borne est donc posée ici.
 */
export const staffRoleSchema = z.enum(STAFF_ROLES);

/**
 * Invitation d'un membre du personnel — corps de `POST /v1/users`.
 *
 * Aucun mot de passe, et il n'y a pas de champ pour en poser un : le compte naît
 * sans secret et c'est la personne invitée qui pose le sien. Écrit à partir de
 * `createStaffAccountRequestSchema` du contrat partagé, dont il ne diffère que
 * par la borne du rôle ci-dessus — le reprendre en l'étendant ferait dépendre
 * cette forme d'un `role` élargi si le contrat venait à l'élargir.
 */
export const inviteStaffAccountRequestSchema = z
  .object({
    // `emailSchema` et non une règle réécrite ici : il porte la borne de 320
    // caractères que `InviteStaffMemberDto` applique côté API. Sans elle, une
    // adresse trop longue passait la vérification de l'écran pour se faire
    // refuser en 400, loin du champ fautif.
    email: emailSchema,
    role: staffRoleSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.optional(),
  })
  .strict();

export type InviteStaffAccountRequest = z.infer<typeof inviteStaffAccountRequestSchema>;

/** Corps de `PATCH /v1/users/:id/role`. */
export const changeStaffRoleRequestSchema = z.object({ role: staffRoleSchema }).strict();

export type ChangeStaffRoleRequest = z.infer<typeof changeStaffRoleRequestSchema>;

/**
 * Corps de `PATCH /v1/users/:id/status`.
 *
 * Le booléen est **obligatoire** : une route qui bascule l'état sur un corps
 * vide n'est pas idempotente, et un double clic la rejouerait à l'envers.
 */
export const setStaffAccountStatusRequestSchema = z
  .object({ isActive: z.boolean() })
  .strict();

export type SetStaffAccountStatusRequest = z.infer<typeof setStaffAccountStatusRequestSchema>;

/**
 * Le rôle tel que l'API l'attend en **entrée** — `MANAGER`, jamais `manager`.
 *
 * Une seule ligne, mais elle vaut d'exister : dispersée dans les appelants, la
 * conversion finirait par être oubliée dans l'un d'eux, et le refus serait un
 * 400 sur un rôle pourtant licite. `toUpperCase` sur un membre de `STAFF_ROLES`
 * rend toujours un membre de son homologue majuscule côté API — les deux listes
 * sont verrouillées l'une à l'autre par `roles.spec.ts`.
 */
export function toApiRole(role: StaffRole): string {
  return role.toUpperCase();
}

/**
 * `true` si ce rôle se gère depuis l'écran du personnel.
 *
 * Sert à écarter les comptes `client` que `GET /v1/users` ne devrait pas rendre
 * — il ne liste que le personnel — mais qu'un jeu de données ancien pourrait
 * encore porter. Les afficher dans une liste dont toutes les actions supposent
 * un rôle interne offrirait des boutons qui échoueraient.
 */
export function isStaffRole(role: UserRole): role is StaffRole {
  return (STAFF_ROLES as readonly UserRole[]).includes(role);
}
