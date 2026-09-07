/**
 * Les appels d'API que la suite E2E s'autorise — et la raison de chacun.
 *
 * ## La règle
 *
 * Un test E2E qui passe par l'API là où l'IHM sait faire ne prouve rien de
 * l'IHM. Chaque fonction de ce module doit donc justifier son existence par
 * **l'absence d'un chemin d'interface**, pas par la commodité. Deux motifs
 * seulement sont admis ici :
 *
 * 1. **Le back-office n'expose pas le geste.** C'est le cas de la confirmation
 *    d'un rendez-vous et de son annulation au comptoir : `DESK_STATUS_LABELS`
 *    (`apps/web/lib/admin/appointment-desk.ts`) ne connaît que « Marquer honoré »
 *    et « Marquer non présenté », et aucun écran d'administration ne rend de
 *    bouton d'annulation. Les routes, elles, existent et sont servies —
 *    `POST /appointments/:id/status` et `POST /appointments/:id/cancel`. C'est
 *    donc l'IHM qui manque, pas le produit, et un test E2E n'a pas à combler ce
 *    manque en inventant un écran.
 * 2. **La mise en situation.** Éprouver le report exige un rendez-vous déjà
 *    posé ; le faire naître par le tunnel complet à chaque test tripleraît la
 *    durée de la suite sans rien éprouver de plus, le tunnel ayant sa propre
 *    scène. Le parcours critique, lui, ne s'autorise **aucun** raccourci : il
 *    réserve par l'IHM, du premier écran au dernier.
 *
 * Ce que ce module ne fait jamais : écrire en base. Tout passe par des routes
 * servies, avec un jeton et un rôle — donc à travers les gardes d'isolation.
 * L'amorçage en base est le seul fait de `fixtures/seed.mjs`, et il ne pose que
 * du référentiel.
 */

import type { APIRequestContext } from '@playwright/test';

import { BASE_API, COMPTES, MOT_DE_PASSE, SLUG, dansNJours } from './environnement';

/** Le corps rendu par une route en erreur — `{ code, message, details }`. */
interface ErreurApi {
  readonly code?: string;
  readonly message?: string;
}

async function exiger(
  reponse: { ok(): boolean; status(): number; text(): Promise<string> },
  contexte: string,
): Promise<void> {
  if (reponse.ok()) {
    return;
  }
  const corps = await reponse.text();
  let detail = corps;
  try {
    const parse = JSON.parse(corps) as ErreurApi;
    detail = `${parse.code ?? 'sans code'} — ${parse.message ?? corps}`;
  } catch {
    // Le corps n'est pas du JSON : on rend le texte brut, qui vaut mieux que rien.
  }
  throw new Error(`${contexte} : HTTP ${reponse.status()} — ${detail}`);
}

/** Le jeton d'accès d'un compte de l'établissement d'essai. */
export async function connecter(
  request: APIRequestContext,
  email: string = COMPTES.staff,
): Promise<string> {
  const reponse = await request.post(`${BASE_API}/auth/login`, {
    data: { tenantSlug: SLUG, email, password: MOT_DE_PASSE },
  });
  await exiger(reponse, `connexion de ${email}`);
  const corps = (await reponse.json()) as { accessToken?: string };
  const jeton = corps.accessToken;
  if (jeton === undefined || jeton === '') {
    throw new Error(`connexion de ${email} : la réponse ne porte pas d'accessToken.`);
  }
  return jeton;
}

function entetes(jeton: string): Record<string, string> {
  return { Authorization: `Bearer ${jeton}` };
}

/** Un créneau libre, tel que la route publique de disponibilité le rend. */
export interface Creneau {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly staffId: string;
}

interface JourneeDisponible {
  readonly date: string;
  readonly slots: readonly Creneau[];
}

/**
 * Le premier créneau libre à partir de maintenant, sur une fenêtre de 14 jours.
 *
 * La fenêtre commence **demain** et non aujourd'hui : le préavis minimal de
 * réservation (`minBookingNoticeMinutes`, 60 min) rend la fin de journée
 * partiellement indisponible, et une suite lancée à 19 h 45 trouverait zéro
 * créneau pour une raison qui n'est pas un défaut. Partir de demain rend le
 * résultat indépendant de l'heure d'exécution.
 */
export interface FenetreCreneaux {
  readonly staffId?: string;
  readonly excludeAppointmentId?: string;
  /** Borne basse, `YYYY-MM-DD`. Par défaut : demain. */
  readonly du?: string;
  /** Borne haute, `YYYY-MM-DD`. Par défaut : quinze jours plus tard. */
  readonly au?: string;
}

export async function premierCreneauLibre(
  request: APIRequestContext,
  serviceId: string,
  options: FenetreCreneaux = {},
): Promise<Creneau & { readonly date: string }> {
  // `dansNJours` et non `toISOString().slice(0, 10)` : la route attend des
  // **dates civiles du salon**, et l'ISO rend celle d'UTC. Les deux diffèrent
  // toute la soirée d'été à Paris, si bien que la fenêtre annoncée « demain à
  // J+15 » commençait en réalité aujourd'hui et s'arrêtait à J+14 — le décalage
  // de fuseau que le CLAUDE.md classe en sévérité haute, ici sur le banc d'essai
  // lui-même.
  const parametres: Record<string, string> = {
    serviceId,
    from: options.du ?? dansNJours(1),
    to: options.au ?? dansNJours(15),
  };
  if (options.staffId !== undefined) {
    parametres['staffId'] = options.staffId;
  }
  if (options.excludeAppointmentId !== undefined) {
    parametres['excludeAppointmentId'] = options.excludeAppointmentId;
  }

  const reponse = await request.get(`${BASE_API}/public/${SLUG}/availability`, {
    params: parametres,
  });
  await exiger(reponse, 'lecture des disponibilités');
  const corps = (await reponse.json()) as { days?: readonly JourneeDisponible[] };

  for (const journee of corps.days ?? []) {
    const creneau = journee.slots[0];
    if (creneau !== undefined) {
      return { ...creneau, date: journee.date };
    }
  }

  throw new Error(
    `Aucun créneau libre pour la prestation ${serviceId} entre ${parametres['from']} et ` +
      `${parametres['to']}. Le jeu d'essai n'a probablement pas posé d'horaire de praticien ` +
      '(apps/web/tests/e2e/fixtures/seed.mjs).',
  );
}

/**
 * Le rendez-vous, réduit à ce que la suite lit.
 *
 * Volontairement partiel : `AgendaAppointmentDto` porte bien davantage — la
 * fiche cliente, le praticien, la prestation — et recopier ce contrat ici
 * reviendrait à en tenir un second exemplaire, qui dériverait. Les seuls champs
 * déclarés sont ceux dont un scénario se sert.
 */
export interface RendezVous {
  readonly id: string;
  readonly status: string;
  readonly startsAt: string;
}

/**
 * Pose un rendez-vous au comptoir — mise en situation, motif 2 de l'en-tête.
 *
 * Le créneau est choisi par la route de disponibilité plutôt que calculé : c'est
 * le moteur qui sait ce qui est libre, et un créneau deviné se heurterait à la
 * contrainte d'exclusion en base dès qu'une exécution précédente aurait laissé
 * quelque chose derrière elle.
 */
export async function poserRendezVous(
  request: APIRequestContext,
  jeton: string,
  parametres: {
    readonly serviceId: string;
    readonly clientId: string;
    /** Le jour où poser le rendez-vous, `YYYY-MM-DD`. Isole les scénarios les uns des autres. */
    readonly leJour?: string;
  },
): Promise<RendezVous> {
  const creneau = await premierCreneauLibre(request, parametres.serviceId, {
    ...(parametres.leJour === undefined ? {} : { du: parametres.leJour, au: parametres.leJour }),
  });
  const reponse = await request.post(`${BASE_API}/appointments`, {
    headers: entetes(jeton),
    data: {
      serviceId: parametres.serviceId,
      staffId: creneau.staffId,
      startsAt: creneau.startsAt,
      clientId: parametres.clientId,
    },
  });
  await exiger(reponse, 'création du rendez-vous au comptoir');
  return (await reponse.json()) as RendezVous;
}

/**
 * Fait avancer un rendez-vous — motif 1 : le tiroir n'offre pas ce passage.
 *
 * `pending → confirmed` est autorisé par `APPOINTMENT_STATUS_TRANSITIONS`, mais
 * `DESK_STATUS_LABELS` ne le rend pas : un rendez-vous en attente n'affiche
 * aucun bouton de statut. La confirmation du parcours critique passe donc ici.
 */
export async function changerStatut(
  request: APIRequestContext,
  jeton: string,
  identifiant: string,
  statut: 'confirmed' | 'completed' | 'no_show',
): Promise<RendezVous> {
  const reponse = await request.post(`${BASE_API}/appointments/${identifiant}/status`, {
    headers: entetes(jeton),
    data: { status: statut },
  });
  await exiger(reponse, `passage du rendez-vous ${identifiant} en ${statut}`);
  return (await reponse.json()) as RendezVous;
}

/**
 * Annule un rendez-vous côté salon — motif 1 : aucun écran ne le rend.
 *
 * `appointments.controller.ts` documente le manque en creux : « Le tiroir de #50
 * […] a un bouton d'annulation à part » — bouton que `appointment-panel.tsx` ne
 * porte pas. La route, elle, est servie et rend `cancelledBy: 'STAFF'`.
 */
export async function annuler(
  request: APIRequestContext,
  jeton: string,
  identifiant: string,
  motif: string,
): Promise<RendezVous> {
  const reponse = await request.post(`${BASE_API}/appointments/${identifiant}/cancel`, {
    headers: entetes(jeton),
    data: { reason: motif },
  });
  await exiger(reponse, `annulation du rendez-vous ${identifiant}`);
  return (await reponse.json()) as RendezVous;
}

/**
 * Le nombre de jours qu'`AppointmentListQueryDto` accepte entre les deux bornes.
 *
 * Recopié de `MAX_APPOINTMENT_RANGE_DAYS` (`apps/api/src/modules/appointments/
 * appointments.errors.ts`) : la suite E2E parle à l'API par HTTP, elle n'importe
 * rien de `apps/api`. La constante est ici pour que le dépassement se lise dans
 * le test plutôt que dans un 400 du serveur.
 */
const PLAGE_AGENDA_MAX_JOURS = 31;

/**
 * Lit l'agenda du comptoir sur une fenêtre, pour éprouver un état sans passer
 * par l'IHM.
 *
 * `from` et `to` sont des **dates civiles** `AAAA-MM-JJ`, du fuseau du salon —
 * pas des instants ISO. `AppointmentListQueryDto` les valide par
 * `IsCalendarDate`, et un `toISOString()` complet part en 400
 * `VALIDATION_ERROR`. Les deux bornes sont comprises, et leur écart ne peut
 * dépasser `PLAGE_AGENDA_MAX_JOURS`.
 */
export async function lireAgenda(
  request: APIRequestContext,
  jeton: string,
  fenetre: { readonly from: string; readonly to: string },
): Promise<readonly RendezVous[]> {
  const reponse = await request.get(`${BASE_API}/appointments`, {
    headers: entetes(jeton),
    params: { from: fenetre.from, to: fenetre.to },
  });
  await exiger(reponse, `lecture de l'agenda du ${fenetre.from} au ${fenetre.to}`);
  // `list()` rend un tableau nu — `@ApiOkResponse({ type: [AgendaAppointmentDto] })`,
  // sans enveloppe de pagination.
  return (await reponse.json()) as readonly RendezVous[];
}

/**
 * Retrouve un rendez-vous par son identifiant, sur une fenêtre large.
 *
 * Sert au parcours critique : le tunnel client n'affiche que la **référence** du
 * rendez-vous, jamais son instant en forme machine — et l'écran d'encaissement
 * se paramètre par une date. Reconstituer cette date en analysant le français du
 * récapitulatif (« lundi 7 septembre 2026 ») serait un analyseur de dates
 * localisées de plus à maintenir, et une source de panne à chaque changement
 * d'ICU. Une lecture d'agenda rend l'instant exact, en UTC, tel que l'API le
 * connaît.
 *
 * Aucune route ne rend un rendez-vous seul : c'est la liste, bornée, qu'on
 * interroge.
 *
 * La fenêtre part de **la veille** et non d'aujourd'hui : `dateDuSalon` peut
 * désigner un autre jour que la date du runner, et une suite lancée à 23 h 30 en
 * heure locale du salon perdrait sinon le rendez-vous du jour. Elle s'étend sur
 * les 29 jours suivants — 30 jours d'écart, sous les 31 qu'admet le contrat —,
 * de quoi couvrir les jours de mise en scène (J+5 à J+10) comme le premier
 * créneau libre du parcours critique, cherché sur quinze jours.
 */
export async function trouverRendezVous(
  request: APIRequestContext,
  jeton: string,
  identifiant: string,
): Promise<RendezVous> {
  const from = dansNJours(-1);
  const to = dansNJours(PLAGE_AGENDA_MAX_JOURS - 2);
  const agenda = await lireAgenda(request, jeton, { from, to });

  const trouve = agenda.find((rendezVous) => rendezVous.id === identifiant);
  if (trouve === undefined) {
    throw new Error(
      `Le rendez-vous ${identifiant} est introuvable dans l'agenda du ${from} au ${to} ` +
        `(${agenda.length} rendez-vous lus).`,
    );
  }
  return trouve;
}
