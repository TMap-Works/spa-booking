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
 * 1. **Le back-office n'expose pas le geste.** La route est servie, l'écran
 *    manque : c'est l'IHM qui fait défaut, pas le produit, et un test E2E n'a
 *    pas à combler ce manque en inventant un écran.
 *
 *    Aucun raccourci ne relève plus de ce motif aujourd'hui. L'annulation au
 *    comptoir en relevait jusqu'à #754, la confirmation d'un rendez-vous en
 *    attente jusqu'à #973 : `DESK_STATUS_LABELS`
 *    (`apps/web/lib/admin/appointment-desk.ts`) porte désormais `confirmed`
 *    comme il portait déjà « Marquer honoré » et « Marquer non honoré », et le
 *    parcours critique confirme au tiroir. Les deux raccourcis ont été
 *    **retirés** de leur scénario plutôt que laissés disponibles — un raccourci
 *    qui survit à l'écran qu'il suppléait finit par être repris par commodité,
 *    et le scénario cesse alors d'éprouver l'IHM.
 * 2. **La mise en situation.** Éprouver le report exige un rendez-vous déjà
 *    posé ; le faire naître par le tunnel complet à chaque test tripleraît la
 *    durée de la suite sans rien éprouver de plus, le tunnel ayant sa propre
 *    scène. Le parcours critique, lui, ne s'autorise **aucun** raccourci : il
 *    réserve par l'IHM, du premier écran au dernier.
 *
 * Ce que ce module ne fait jamais : écrire en base **lui-même**. Tout passe par
 * des routes servies, avec un jeton et un rôle — donc à travers les gardes
 * d'isolation. L'écriture en base reste le seul fait de `fixtures/seed.mjs`,
 * dans un sous-processus qui naît, écrit et meurt : `poserRendezVousCommence`
 * ci-dessous la lui délègue, et c'est le seul cas.
 *
 * Ce cas-là relève du motif 1 sous sa forme la plus nette : **aucune route ne
 * peut poser un rendez-vous commencé**, et ce n'est pas un manque à combler. Le
 * moteur de disponibilité n'offre que des créneaux postérieurs au préavis, et
 * `POST /appointments` n'accepte que des créneaux offerts — le comptoir ne
 * réserve donc jamais dans le passé, ce qui est la bonne règle. Sans décor posé
 * en base, « Marquer non honoré » cesserait d'être éprouvé à l'écran, le tiroir
 * ne l'offrant plus que sur un rendez-vous commencé (#1210, #1137).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import type { APIRequestContext } from '@playwright/test';

import { BASE_API, COMPTES, MOT_DE_PASSE, RACINE_WEB, SLUG, dansNJours } from './environnement';

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

/**
 * Le jeton d'accès d'un compte de l'établissement d'essai.
 *
 * Le défaut est le **comptoir**, c'est-à-dire le rang gérant depuis #812 : les
 * appels que ces parcours passent en direct — poser un rendez-vous, le solder,
 * l'encaisser — exigent tous une permission que le rang praticien ne porte
 * plus. Voir `COMPTES` dans `environnement.ts`.
 */
export async function connecter(
  request: APIRequestContext,
  email: string = COMPTES.manager,
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

/** Le décor posé par le jeu d'essai — ce que la suite en lit. */
export interface RendezVousCommence {
  readonly id: string;
  readonly reference: string;
  /** L'heure **du soin**, celle que l'API rend et que les écrans comparent. */
  readonly startsAt: string;
  readonly staffId: string;
  readonly clientId: string;
}

/**
 * Pose un rendez-vous **déjà commencé**, confirmé, sur une journée passée.
 *
 * Voir l'en-tête : c'est le seul raccourci de ce module qui écrive en base, et
 * il le délègue au jeu d'essai dans un sous-processus — le même montage que
 * `global-setup.ts`, et pour la même raison : charger le client Prisma dans le
 * processus de Playwright y attacherait un pool PostgreSQL pour toute la durée
 * de la suite.
 *
 * `jour` est une **date civile du salon**, et doit être passée : c'est ce qui
 * isole les tentatives de `retries` les unes des autres, la tentative
 * précédente ayant soldé le rendez-vous de la sienne.
 */
export function poserRendezVousCommence(jour: string): RendezVousCommence {
  const graine = path.join(RACINE_WEB, 'tests', 'e2e', 'fixtures', 'seed.mjs');
  const execution = spawnSync(
    process.execPath,
    [graine, '--slug', SLUG, '--rendez-vous-commence', '--jour', jour],
    { encoding: 'utf8', env: process.env },
  );

  if (execution.status !== 0) {
    throw new Error(
      `Le décor « rendez-vous commencé » du ${jour} a échoué (code ${execution.status ?? 'inconnu'}).\n` +
        `${execution.stderr || execution.stdout || 'aucune sortie'}`,
    );
  }

  // Prisma peut ajouter des avertissements sur stdout : c'est la dernière ligne
  // non vide qui fait foi, comme dans `global-setup.ts`.
  const lignes = execution.stdout.trim().split('\n');
  const derniere = lignes[lignes.length - 1] ?? '';

  try {
    return JSON.parse(derniere) as RendezVousCommence;
  } catch {
    throw new Error(`Le décor n'a pas rendu de JSON exploitable. Dernière ligne : « ${derniere} ».`);
  }
}

/**
 * Fait avancer un rendez-vous — mise en situation, motif 2 de l'en-tête.
 *
 * Le tiroir sait faire ce passage depuis #973, et le parcours critique le fait
 * **à l'écran** : ce qui reste ici n'est plus la suppléance d'un geste absent,
 * c'est l'amorçage d'un scénario qui commence ailleurs. Éprouver le no-show
 * exige un rendez-vous déjà confirmé, et le régler par carte aussi ; les
 * amener là par deux clics que le parcours critique exerce déjà allongerait la
 * suite sans rien éprouver de plus.
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
