import Link from 'next/link';

import { adminCalendarPath } from '../paths';

/**
 * L'établissement courant, et le moyen d'en changer s'il y en a d'autres
 * (#48, quatrième critère).
 *
 * ## Pourquoi « s'il y en a d'autres » n'est pas une échappatoire
 *
 * Le critère est conditionnel — « sélection du salon **si** l'utilisateur en
 * gère plusieurs » — et l'état actuel du modèle de données tranche la condition :
 * `users.tenant_id` est une colonne unique et non nullable, un jeton d'accès est
 * borné à un établissement, et les cookies de session sont posés sur
 * `/{slug}/admin`. Une même personne qui gère deux salons y a donc **deux
 * comptes**, et deux sessions qui ne s'écrasent pas. L'API ne sert aucune route
 * « mes établissements », et en inventer une sortirait du périmètre MVP, où
 * l'interface multi-établissement est explicitement hors sujet.
 *
 * Ce composant rend donc les deux formes, et la liste décide :
 *
 * - **un seul établissement** — le nom, écrit. C'est le contrat de balisage du
 *   pied de rail, et il n'y a rien à choisir ;
 * - **plusieurs** — la liste des autres, chacun un lien vers son back-office.
 *
 * ## Pourquoi des liens et non un `<select>`
 *
 * Changer d'établissement, c'est changer d'URL — pas soumettre un formulaire.
 * Des liens donnent l'ouverture dans un nouvel onglet, le survol qui montre la
 * destination et le clavier, sans une ligne de JavaScript : ce composant ne
 * porte **aucun état**, là où un `<select>` aurait exigé un gestionnaire de
 * changement, un routeur, et du style clair sur le fond sombre du rail — pour
 * un contrôle que rien ne rend aujourd'hui.
 *
 * Il n'est pas marqué `'use client'` et n'en a pas besoin : le rail l'importe,
 * ce qui suffit à le faire rendre dans le même arbre, sans y ajouter de
 * frontière.
 */

/** Un établissement joignable par ce compte. */
export interface AdminEstablishment {
  readonly slug: string;
  readonly name: string;
}

interface EstablishmentSwitcherProps {
  readonly currentSlug: string;
  /** Les établissements de ce compte, celui de la page comprise. */
  readonly establishments: readonly AdminEstablishment[];
}

export function EstablishmentSwitcher({
  currentSlug,
  establishments,
}: EstablishmentSwitcherProps) {
  const current = establishments.find((salon) => salon.slug === currentSlug);
  const others = establishments.filter((salon) => salon.slug !== currentSlug);

  return (
    <>
      <strong>{current?.name ?? currentSlug}</strong>
      {others.length === 0 ? null : (
        <nav aria-label="Changer d’établissement">
          {others.map((salon) => (
            <Link className="spa-admin__nav-link" href={adminCalendarPath(salon.slug)} key={salon.slug}>
              {salon.name}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
