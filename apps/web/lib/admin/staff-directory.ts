/**
 * L'annuaire du personnel, côté présentation (#53, premier critère).
 *
 * ## Deux notions que l'API ne relie pas, et qu'on ne relie pas non plus
 *
 * Un **compte** (`GET /v1/users`) porte l'identité, l'adresse de connexion et le
 * rôle. Une **fiche praticien** (`GET /v1/staff`) porte le nom d'affichage et
 * l'agenda. `Staff.userId` les relie en base — mais `StaffMemberDto` masque
 * délibérément ce champ, et aucune route ne le publie.
 *
 * Il serait tentant de les apparier sur le nom. Ce serait une devinette, et une
 * devinette qui se trompe attribue les horaires d'une collègue : deux
 * « M. Rakoto » suffisent. L'écran montre donc les deux listes côte à côte en
 * disant ce que chacune est, et l'appariement fait l'objet d'une issue de suivi
 * — il appartient à l'API, pas au front.
 */

import type { StaffMember } from '@spa/shared';

/**
 * Les initiales d'un nom d'affichage — la pastille de la liste.
 *
 * Initiales plutôt que photo : le salon n'a aucune raison de stocker le portrait
 * de ses employés pour un écran de planning, et deux lettres se chargent
 * instantanément — ce qui compte sur un écran rouvert cent fois par jour.
 *
 * Deux mots au plus, première lettre de chacun. Un nom d'un seul mot rend une
 * seule lettre plutôt que ses deux premières : « Ha » se lit comme un début de
 * mot tronqué, « H » se lit comme une initiale.
 */
export function staffInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter((word) => word !== '');

  return words
    .slice(0, 2)
    .map((word) => (word[0] ?? '').toLocaleUpperCase('fr-FR'))
    .join('');
}

/**
 * Les fiches, ordonnées pour l'affichage : les actives d'abord, puis par nom.
 *
 * Les praticiens désactivés restent listés — c'est le back-office, on y vient
 * précisément pour réactiver quelqu'un — mais ils passent après : la liste sert
 * d'abord à ouvrir l'agenda de qui travaille aujourd'hui.
 *
 * `localeCompare` en français, sinon « Émilie » se rangerait après « Zoé ».
 */
export function sortStaffMembers(members: readonly StaffMember[]): StaffMember[] {
  return [...members].sort((left, right) => {
    if (left.isActive !== right.isActive) {
      return left.isActive ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName, 'fr-FR');
  });
}
