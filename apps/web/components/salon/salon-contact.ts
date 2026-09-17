import type { PublicTenant } from '@spa/shared';

/**
 * Le moyen de joindre le salon **hors ligne**, quand il en a publié un (#773).
 *
 * ## Pourquoi cette fonction existe
 *
 * L'audit `d20260916-1` relève, au titre de `ds:confiance`, qu'un salon sans
 * prestation publiée invitait la visiteuse à « le contacter directement » sans
 * jamais lui donner de quoi le faire : le catalogue vide écrivait l'instruction
 * quoi qu'il arrive, et les coordonnées, plus bas, pouvaient être absentes. Une
 * action qu'on ne peut pas exercer n'est pas une action.
 *
 * `docs/design/appointments/states.md` demande l'inverse à l'étape service :
 * « le salon n'a aucun service actif → proposer de contacter le salon
 * (téléphone) ». D'où l'ordre ci-dessous — le téléphone d'abord, l'e-mail en
 * second recours —, et d'où le `null` : quand le salon n'a rien publié, on se
 * tait plutôt que de promettre.
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle ne fabrique pas de lien vers l'adresse postale ni vers les horaires :
 * ceux-là ne joignent personne. La section « informations pratiques » les rend
 * déjà, et c'est son travail (`salon-info.tsx`).
 */
export interface SalonContactAction {
  /** `tel:` ou `mailto:` — prêt à poser dans un `href`, sans retouche. */
  readonly href: string;
  /** Ce que l'action annonce : un lien porte le nom de ce qu'il fait (WCAG 2.4.4). */
  readonly label: string;
}

/**
 * Ce qu'un humain intercale dans un numéro et qui n'a pas sa place dans une URI.
 *
 * `storedPhoneSchema` n'est **pas** normalisé en E.164 : il accepte — et
 * conserve délibérément — les espaces, points, tirets et parenthèses d'un numéro
 * écrit pour être lu (`packages/shared/src/common/identifiers.ts`). Un
 * `tel:+261 34 12 345 67` porterait donc des espaces, que RFC 3966 n'autorise
 * pas et que tous les agents utilisateurs ne rattrapent pas. Le libellé affiché
 * garde l'écriture du salon ; seule la destination est resserrée.
 */
const PHONE_URI_SEPARATORS = /[\s().-]/g;

/**
 * La destination `tel:` d'un numéro tel que l'API le sert.
 *
 * Exportée parce que la vitrine compose deux `tel:` — l'action de l'état vide
 * ci-dessous, et le numéro cliquable des informations pratiques
 * (`salon-info.tsx`), qui portait jusqu'ici le numéro brut au motif, inexact,
 * qu'il serait déjà en E.164. Deux constructions de la même URI, dont une seule
 * corrigée, sont exactement la divergence que ce dossier évite ailleurs en
 * tenant ses libellés en un point unique.
 */
export function telUri(phone: string): string {
  return `tel:${phone.replace(PHONE_URI_SEPARATORS, '')}`;
}

export function salonContactAction(tenant: PublicTenant): SalonContactAction | null {
  if (tenant.contactPhone !== undefined) {
    return { href: telUri(tenant.contactPhone), label: 'Appeler le salon' };
  }

  if (tenant.contactEmail !== undefined) {
    return { href: `mailto:${tenant.contactEmail}`, label: 'Écrire au salon' };
  }

  return null;
}
