/**
 * Le chemin de l'écran d'activation, et la lecture de ce qu'on y colle (#1143).
 *
 * Écrits ici plutôt qu'ajoutés à `../paths.ts` — même raison que
 * `personnel/paths.ts` : le module partagé par tout le back-office est réécrit
 * par plusieurs branches à la fois, et deux fichiers qui grandissent chacun de
 * leur côté fusionnent là où un seul, allongé au même endroit, non. La
 * discipline ne change pas : **aucun composant ne concatène d'URL**, et la
 * racine vient d'un seul endroit, `adminPath`.
 */

import { adminPath } from '../paths';

/**
 * L'activation d'un compte invité, éventuellement avec son jeton.
 *
 * C'est l'adresse que la console remet au gérant d'un salon (ADR 0012) et celle
 * qu'un administrateur remet à un membre de son équipe. Le jeton est encodé :
 * il vient d'une réponse d'API et non d'une saisie, mais un paramètre d'URL se
 * construit toujours de la même façon, sans exception qu'il faudrait ensuite se
 * rappeler.
 */
export function adminInvitationPath(tenantSlug: string, token?: string): string {
  const invitation = `${adminPath(tenantSlug)}/invitation`;

  return token === undefined ? invitation : `${invitation}?token=${encodeURIComponent(token)}`;
}

/**
 * Le nom du paramètre qui porte le jeton, écrit une fois : la page d'activation
 * le lit, `adminInvitationPath` l'écrit, et {@link invitationTokenFromInput} le
 * retrouve dans ce qu'on colle.
 */
const TOKEN_PARAM = 'token';

/**
 * Les caractères qu'un jeton d'invitation peut porter — l'alphabet base64url
 * d'un JWT, ses deux points de séparation compris, plus les variantes que
 * laisse passer un encodage d'URL.
 *
 * La borne n'est pas cosmétique : sans elle, un « Bonjour, voici ton lien »
 * collé par erreur partirait tel quel à l'API, qui le refuserait par un message
 * d'expiration — le plus trompeur des trois, puisqu'il ferait croire à un lien
 * périmé là où le presse-papiers portait simplement autre chose.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Ce qui trahit une **adresse** plutôt qu'un code : une barre de chemin, ou le
 * nom du paramètre lui-même. Un jeton d'invitation est un JWT base64url, qui
 * n'en porte jamais.
 */
const LOOKS_LIKE_LINK = new RegExp(`[/?]|${TOKEN_PARAM}=`);

/** Le `token` d'une adresse déjà débarrassée de ses blancs, ou `null`. */
function tokenFromLink(compact: string): string | null {
  if (!compact.includes(`${TOKEN_PARAM}=`)) {
    return null;
  }

  // `URL` n'accepte pas d'adresse relative sans base ; celle donnée ici n'est
  // jamais lue, elle ne sert qu'à rendre l'analyse possible. L'origine est
  // écartée aussitôt : seul le paramètre nous intéresse — un lien de recette et
  // un lien de production portent le même jeton.
  //
  // Le `catch` couvre ce qu'un presse-papiers peut contenir de mal formé :
  // `URL` lève sur une adresse absolue impossible, et une exception non
  // rattrapée ici casserait l'écran au lieu de rendre le refus que l'appelant
  // sait afficher sous le champ.
  try {
    return new URL(compact, 'https://invitation.invalid').searchParams.get(TOKEN_PARAM);
  } catch {
    return null;
  }
}

/**
 * Le jeton contenu dans ce que la personne invitée colle, ou `null` si rien
 * d'exploitable ne s'y trouve.
 *
 * Trois formes sont acceptées, parce que ce sont les trois qui arrivent
 * réellement :
 *
 * 1. **le lien entier**, `https://salon.exemple.fr/{slug}/admin/invitation?token=…`
 *    — ce que le bouton « Copier » de l'écran d'invitation dépose ;
 * 2. **le lien relatif**, `/{slug}/admin/invitation?token=…`, qu'un copier-coller
 *    depuis la barre d'adresse d'un autre onglet peut réduire ;
 * 3. **le code seul**, quand le lien a été dicté, tronqué ou reconstitué à la
 *    main.
 *
 * Les blancs sont retirés **avant** toute lecture : un jeton fait trois cents
 * caractères d'un seul tenant, et les messageries les coupent par des retours à
 * la ligne. Recoller un jeton ainsi replié échouait sans que rien ne dise
 * pourquoi — c'est le défaut que le ticket ferme, il n'a pas à revenir par la
 * porte de derrière. Un jeton n'ayant jamais d'espace en propre, ce nettoyage ne
 * peut pas en abîmer un.
 *
 * Ce qui est rendu n'est **pas** réputé valide : seule l'API juge un jeton. La
 * borne de forme ne fait qu'écarter ce qui n'en est manifestement pas un, pour
 * ne pas transformer un collage maladroit en « lien expiré ».
 *
 * Ce qui se lit comme une adresse **doit** livrer son paramètre : un lien
 * tronqué avant son `?token=`, `/{slug}/admin/invitation`, ne porte que des
 * caractères que {@link TOKEN_SHAPE} accepte, et le retenir tel quel le ferait
 * passer pour un code reconnu jusqu'au refus de l'API — précisément le « lien
 * expiré » trompeur que cette borne existe pour éviter.
 */
export function invitationTokenFromInput(value: string): string | null {
  const compact = value.replace(/\s+/g, '');

  if (compact === '') {
    return null;
  }

  const fromLink = tokenFromLink(compact);

  if (fromLink !== null) {
    return fromLink !== '' && TOKEN_SHAPE.test(fromLink) ? fromLink : null;
  }

  // Ni chemin, ni prose portant `token=` : seul un code nu peut encore passer.
  if (LOOKS_LIKE_LINK.test(compact)) {
    return null;
  }

  return TOKEN_SHAPE.test(compact) ? compact : null;
}
