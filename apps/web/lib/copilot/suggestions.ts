import { COPILOT_ACTIONS, meetsRequirement, type CopilotActionId, type CopilotSession } from '@spa/shared';

/**
 * Les suggestions d'ouverture du chat — EF-2, étage 0 (spécification §6.2.1).
 *
 * Calculées par le serveur à partir de la surface et de la page, **jamais par
 * le modèle** : elles sont instantanées et ne coûtent rien. Trois au plus, et
 * ce qui fait entrer le chiffre d'affaires d'abord (réserver, remplir un
 * créneau, encaisser).
 *
 * Deux sortes :
 * - `navigation` — le clic mène directement à l'adresse, sans aucun appel ;
 * - `message` — le clic envoie au chat une question toute faite, que l'interface
 *   rédige dans sa langue à partir de `cle` (`messages/{fr,en}/copilot.json`,
 *   P1-06).
 *
 * Chaque suggestion est rattachée à l'action du registre qu'elle déclenche, et
 * n'est proposée qu'à qui y a droit.
 */

export type CopilotSuggestion =
  | { readonly cle: string; readonly type: 'navigation'; readonly chemin: string }
  | { readonly cle: string; readonly type: 'message' };

interface Candidate {
  readonly cle: string;
  readonly action: CopilotActionId;
  /** Chemin relatif au salon : présent pour une navigation. */
  readonly chemin?: string;
}

/** Par surface, dans l'ordre du chiffre d'affaires. */
const CANDIDATES: Record<CopilotSession['surface'], readonly Candidate[]> = {
  visiteur: [
    { cle: 'reserver', action: 'reservation.ouvrir_tunnel', chemin: '/reservation' },
    { cle: 'creneaux_demain', action: 'disponibilite.creneaux' },
    { cle: 'tarifs', action: 'catalogue.chercher' },
  ],
  client: [
    { cle: 'reprendre_dernier_soin', action: 'rendez_vous.mon_historique' },
    { cle: 'reporter_prochain', action: 'rendez_vous.mes_prochains' },
    { cle: 'reserver', action: 'reservation.ouvrir_tunnel', chemin: '/reservation' },
  ],
  praticien: [
    { cle: 'ma_journee', action: 'planning.ma_journee' },
    { cle: 'prochain_client', action: 'planning.ma_journee' },
  ],
  gerance: [
    { cle: 'creneaux_libres_aujourdhui', action: 'planning.creneaux_libres' },
    { cle: 'poser_rendez_vous', action: 'rendez_vous.poser' },
    { cle: 'a_encaisser', action: 'encaissement.a_regler' },
    { cle: 'resume_journee', action: 'tableau_de_bord.resumer' },
  ],
};

/** Sur ces pages, la suggestion du même sujet passe en tête. */
const PAGE_FIRST: readonly { readonly suffixe: string; readonly cle: string }[] = [
  { suffixe: '/admin/encaissement', cle: 'a_encaisser' },
  { suffixe: '/admin/mon-planning', cle: 'ma_journee' },
  { suffixe: '/compte', cle: 'reporter_prochain' },
];

export const MAX_SUGGESTIONS = 3;

export function suggestionsFor(session: CopilotSession, page: string): CopilotSuggestion[] {
  const base = `/${session.tenant.slug}`;
  const path = page.split(/[?#]/)[0] ?? '';
  const first = PAGE_FIRST.find(({ suffixe }) => path === `${base}${suffixe}`)?.cle;

  const candidates = CANDIDATES[session.surface]
    .filter(({ action }) => meetsRequirement(session, COPILOT_ACTIONS[action].exige))
    // Une navigation vers la page où l'on est déjà n'aide personne.
    .filter(({ chemin }) => chemin === undefined || path !== `${base}${chemin}`);

  const ordered = first === undefined ? candidates : [
    ...candidates.filter(({ cle }) => cle === first),
    ...candidates.filter(({ cle }) => cle !== first),
  ];

  return ordered.slice(0, MAX_SUGGESTIONS).map(({ cle, chemin }) =>
    chemin === undefined ? { cle, type: 'message' } : { cle, type: 'navigation', chemin: `${base}${chemin}` },
  );
}
