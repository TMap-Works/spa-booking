import type { PublicService } from '@spa/shared';

import { Avatar } from '@/components/ui/avatar';

import { UNCLASSIFIED_TITLE } from './group-services';

/** Identifiant du titre de section, repris par `aria-labelledby`. */
export const TEAM_HEADING_ID = 'equipe';

/** Un praticien de la vitrine, et ce qu'il pratique. */
export interface TeamMember {
  readonly id: string;
  readonly displayName: string;
  /** Les rubriques qu'il pratique, dans l'ordre du catalogue. */
  readonly practices: readonly string[];
}

/**
 * L'équipe, déduite du catalogue public (#1046, BM-VITRINE-06).
 *
 * ## Pourquoi elle se déduit au lieu d'être servie
 *
 * `publicTenantSchema` ne porte pas d'équipe, et lui en ajouter une demanderait
 * une route côté API — hors de l'empreinte de ce ticket. Elle se reconstruit
 * pourtant sans rien inventer : `PublicService.staff` liste, prestation par
 * prestation, les praticiens **actifs** qui la tiennent. Leur réunion est
 * exactement l'équipe que la cliente pourra choisir à l'étape du praticien.
 *
 * ## Le « métier » n'existe pas dans le contrat, et ne s'invente pas
 *
 * BM-VITRINE-06 décrit « le prénom et la fonction (“Lila — Esthéticienne”) ».
 * `staffMemberSummarySchema` ne porte que `id` et `displayName` : il n'y a pas
 * de fonction à afficher, et en fabriquer une serait écrire sur la vitrine d'un
 * salon un métier que personne n'y a saisi. Chaque praticien est donc qualifié
 * par **ce qu'il pratique** — les rubriques de ses prestations —, qui est la
 * même information au fond, et qui vient des données.
 *
 * L'ordre est celui du catalogue, pour la même raison que le groupement des
 * rubriques : le classement appartient au salon, et un tri alphabétique posé
 * ici remonterait un praticien devant un autre sans qu'il l'ait demandé.
 */
export function teamFromServices(services: readonly PublicService[]): readonly TeamMember[] {
  const members = new Map<string, { displayName: string; practices: string[] }>();

  for (const service of services) {
    const practice = service.category?.name ?? UNCLASSIFIED_TITLE;

    for (const member of service.staff) {
      const existing = members.get(member.id);

      if (existing === undefined) {
        members.set(member.id, { displayName: member.displayName, practices: [practice] });
        continue;
      }

      if (!existing.practices.includes(practice)) {
        existing.practices.push(practice);
      }
    }
  }

  return [...members.entries()].map(([id, member]) => ({
    id,
    displayName: member.displayName,
    practices: member.practices,
  }));
}

interface SalonTeamProps {
  readonly services: readonly PublicService[];
}

/**
 * La rangée de l'équipe (BM-VITRINE-06) — « le choix du praticien, plus loin, se
 * prépare ici ».
 *
 * Server Component, et pas la moindre photo : le modèle de données n'en porte
 * aucune, et `Avatar` (#1044) rend les initiales en attendant — c'est là qu'une
 * photo se branchera le jour venu, sans toucher cette section.
 *
 * La section **disparaît** quand aucun praticien ne ressort du catalogue. Un
 * salon dont les prestations n'ont pas encore de praticien affecté n'a pas
 * d'équipe à montrer, et un « L'équipe » suivi d'un état vide dirait à la
 * cliente qu'il n'y a personne — ce que la mention de chaque ligne du catalogue
 * dit déjà, à sa place et sans généraliser.
 */
export function SalonTeam({ services }: SalonTeamProps) {
  const members = teamFromServices(services);

  if (members.length === 0) {
    return null;
  }

  return (
    <section className="spa-salon__section" aria-labelledby={TEAM_HEADING_ID}>
      <h2 className="spa-salon__section-title" id={TEAM_HEADING_ID}>
        L’équipe
      </h2>

      <ul className="spa-salon-team">
        {members.map((member) => (
          <li className="spa-salon-team__member" key={member.id}>
            {/* Décoratif : le nom est écrit juste à côté, et un lecteur d'écran
                annoncerait sinon deux fois « Hery ». */}
            <Avatar name={member.displayName} size="lg" />
            <p className="spa-salon-team__name">{member.displayName}</p>
            <p className="spa-salon-team__practices">{member.practices.join(' · ')}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
