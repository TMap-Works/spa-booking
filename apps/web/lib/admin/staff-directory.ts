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
 * disant ce que chacune est.
 *
 * Ce que #694 a changé : le lien ne se **devine** toujours pas, mais il se
 * **pose**. Créer une fiche praticien, c'est choisir explicitement le compte
 * qu'elle sert — et c'est le seul endroit du produit où les deux notions se
 * rencontrent. L'API continue de ne pas publier `userId` en lecture, si bien que
 * l'écran ne sait toujours pas, d'une fiche existante, quel compte elle sert :
 * l'appariement rétrospectif reste une question ouverte, celle-là même que la
 * liste des comptes proposés à la création ne peut donc pas filtrer.
 */

import { DISPLAY_NAME_MAX_LENGTH, type StaffMember } from '@spa/shared';

/**
 * Le nom qu'une fiche praticien porterait par défaut pour ce compte.
 *
 * C'est une **proposition de saisie**, pas une règle : le nom d'affichage est
 * celui que la cliente lira dans le tunnel de réservation, et il n'a aucune
 * raison de reprendre l'état civil du contrat de travail. Le formulaire le
 * préremplit, la personne le corrige.
 *
 * `trim` sur le tout plutôt que sur chaque moitié : un prénom seul ne doit pas
 * laisser d'espace en fin de champ, où il se verrait à la sélection.
 *
 * ## Une proposition ne propose jamais ce que le contrat refuse (#714)
 *
 * `firstName` et `lastName` valent chacun jusqu'à `NAME_MAX_LENGTH` = 80
 * caractères, là où `displayNameSchema` borne le nom d'affichage à
 * `DISPLAY_NAME_MAX_LENGTH` = 160 : le nom complet peut donc atteindre 161, et
 * l'écran préremplissait alors le champ avec une valeur que sa propre
 * soumission refusait — « ce champ fait au plus 160 caractères » sous un texte
 * que la gérante n'avait pas saisi. Le cas demande deux moitiés extrêmes, mais
 * les deux bornes le rendent atteignable, et rien d'autre ne l'empêchait.
 *
 * Le repli se fait sur le **prénom seul** plutôt que sur un nom complet coupé :
 * une proposition est faite pour être lue et corrigée, et un patronyme tranché
 * au milieu d'un mot se corrige moins bien qu'un prénom entier. La troncature
 * ne reste que comme dernier filet, pour que la promesse de cette fonction — le
 * résultat ne dépasse jamais `DISPLAY_NAME_MAX_LENGTH` — ne dépende d'aucune
 * borne posée ailleurs. Le plancher, lui, reste celui de l'appelant : deux
 * moitiés vides rendent la chaîne vide, que `displayNameSchema` refuse, et
 * c'est le champ obligatoire du formulaire qui le dit.
 *
 * Le décompte est celui de `String.prototype.length`, en unités UTF-16 :
 * c'est exactement la mesure que le `.max()` de Zod applique de l'autre côté,
 * donc la seule qui garantisse que la proposition passe le contrat.
 */
export function suggestedStaffDisplayName(account: {
  readonly firstName: string;
  readonly lastName: string;
}): string {
  const fullName = `${account.firstName} ${account.lastName}`.trim();

  if (fullName.length <= DISPLAY_NAME_MAX_LENGTH) {
    return fullName;
  }

  const firstName = account.firstName.trim();
  const folded = firstName === '' ? fullName : firstName;

  return folded.length <= DISPLAY_NAME_MAX_LENGTH
    ? folded
    : folded.slice(0, DISPLAY_NAME_MAX_LENGTH).trimEnd();
}

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
