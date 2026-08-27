/**
 * Découpage des fenêtres libres en créneaux proposables — le calcul, sans base
 * ni HTTP (#34).
 *
 * C'est la dernière étape du moteur de disponibilité (booking-engine §3, étapes
 * 4 à 6). Ce qui précède est déjà écrit ailleurs, et ce module ne le refait pas :
 *
 * | Étape | Où elle vit |
 * |---|---|
 * | 1. praticiens candidats | `AvailabilityRepository.listServiceStaffIds` |
 * | 2. fenêtres de travail − fermetures | `availability.schedule.ts` (#32) |
 * | 3. − congés − rendez-vous pris | `availability.intervals.ts` (#33) |
 * | **4. découpage par pas** | **ici** |
 * | **5. la durée occupée doit tenir** | **ici** |
 * | **6. passé et délai minimum** | **ici** |
 *
 * Fonctions pures, sans état : des instants en entrée, des instants en sortie.
 * Aucun fuseau n'y entre — deux instants se comparent sans fuseau, et la
 * construction des bornes relève de `availability.time.ts`.
 *
 * ## Ce que « créneau » veut dire ici, et pourquoi il y en a deux
 *
 * Un créneau a **deux intervalles**, et les confondre est le défaut que ce
 * module existe pour rendre impossible :
 *
 * - l'intervalle **occupé** — `tampon avant + soin + tampon après`. C'est ce que
 *   le praticien ne peut pas faire autre chose, ce que la contrainte d'exclusion
 *   d'`appointments` comparera, et ce qui doit tenir dans une fenêtre libre ;
 * - l'intervalle **facturé** — le soin seul. C'est ce que la cliente voit, ce
 *   qu'elle paie, et la seule des deux formes que le contrat public expose
 *   (`availabilitySlotSchema`).
 *
 * La grille se pose sur le premier, la sortie rend le second. L'inverse — rendre
 * l'intervalle occupé et laisser le front en retrancher les tampons — est
 * strictement impossible : `PublicServiceView` ne porte délibérément pas les
 * tampons, et le navigateur n'a donc aucun moyen de retrouver l'heure du
 * rendez-vous.
 *
 * ## Où la grille prend son origine
 *
 * À l'ouverture de la **fenêtre de travail**, jamais à minuit ni au bord d'un
 * trou. Un salon qui ouvre à 09:00 avec un pas de quinze minutes propose 09:00,
 * 09:15, 09:30 — quels que soient les rendez-vous déjà pris. Ancrer la grille sur
 * ce qu'il reste après soustraction, ce que la lettre de booking-engine §3
 * autoriserait, ferait glisser toutes les heures affichées à chaque réservation :
 * un rendez-vous qui finit à 09:50 rendrait la suite de la journée à 09:50,
 * 10:05, 10:20. Les créneaux d'un même salon ne se ressembleraient plus d'un jour
 * à l'autre, et deux clientes rafraîchissant la même page verraient des heures
 * différentes.
 *
 * Les fenêtres sont **fusionnées avant** de servir d'origine
 * (`mergeRanges`) : une journée continue décrite en deux plages adjacentes
 * (`09:00–12:00` puis `12:00–18:00`) est une seule journée, donc une seule
 * grille — sans quoi la seconde plage rouvrirait une grille à 12:00 et un soin
 * de trente minutes ne pourrait jamais commencer à 11:45. Une vraie coupure
 * méridienne (`09:00–12:00`, `14:00–18:00`), elle, reste deux fenêtres : la
 * grille de l'après-midi repart bien de 14:00.
 */

import { mergeRanges, subtractRanges } from './availability.intervals';
import type { UtcRange } from './availability.time';

const MINUTE_MS = 60_000;

/**
 * La forme d'un créneau pour une prestation donnée — tout ce que le découpage a
 * besoin de savoir du catalogue et des réglages de l'établissement.
 *
 * Aucune de ces valeurs n'est devinée : les trois premières viennent de
 * `services`, la dernière de `tenants.slot_interval_minutes`.
 */
export interface SlotShape {
  /** Pas de la grille, en minutes — `tenants.slot_interval_minutes`. */
  readonly slotIntervalMinutes: number;
  /** Durée facturée du soin, en minutes — `services.duration_minutes`. */
  readonly serviceDurationMinutes: number;
  /** Préparation de la cabine, en minutes — non facturée, non affichée. */
  readonly bufferBeforeMinutes: number;
  /** Remise en état, en minutes — non facturée, non affichée. */
  readonly bufferAfterMinutes: number;
}

/**
 * Durée réellement bloquée sur l'agenda du praticien, tampons compris.
 *
 * Même définition — et même valeur — que `ServiceView.occupiedMinutes` du
 * catalogue. Elle est recalculée ici plutôt qu'exigée en entrée pour que le
 * découpage reste vrai même si l'appelant ne la lui donne pas : c'est la seule
 * grandeur qui décide si un créneau tient, et la dériver d'une valeur transmise
 * la laisserait se désynchroniser de ses trois termes.
 */
export function occupiedMinutesOf(shape: SlotShape): number {
  return shape.bufferBeforeMinutes + shape.serviceDurationMinutes + shape.bufferAfterMinutes;
}

/** Le temps d'un praticien : ce qu'il travaille, et ce qui l'occupe déjà. */
export interface StaffFreeTime {
  readonly staffId: string;
  /** Fenêtres de travail, fermetures de l'établissement déjà retirées (#32). */
  readonly windows: readonly UtcRange[];
  /** Congés, plages bloquées et rendez-vous `PENDING`/`CONFIRMED` (#31, #33). */
  readonly busy: readonly UtcRange[];
}

/**
 * Un créneau proposable — l'intervalle **facturé**, plus le praticien qui le
 * tient.
 *
 * `staffId` y figure même lorsque la requête n'a désigné personne : la
 * réservation qui suit doit nommer un praticien précis, et le choisir au moment
 * du `POST` rouvrirait la fenêtre de concurrence que le créneau sert à fermer.
 */
export interface StaffSlot extends UtcRange {
  readonly staffId: string;
}

export interface SlotComputation {
  readonly staff: readonly StaffFreeTime[];
  readonly shape: SlotShape;
  /**
   * Aucun créneau ne peut être **occupé** avant cet instant — `maintenant +
   * tenants.min_booking_notice_minutes`.
   *
   * Le filtre porte sur le début de l'intervalle occupé et non sur celui du
   * soin : c'est la préparation de la cabine qui doit pouvoir commencer, pas
   * seulement l'accueil de la cliente. Filtrer sur l'heure affichée laisserait
   * proposer un créneau dont les dix minutes de préparation sont déjà passées.
   *
   * Le critère « créneaux dans le passé » n'a pas de traitement séparé : il en
   * est le cas particulier où le préavis vaut zéro.
   */
  readonly notBefore: Date;
}

/**
 * Refuse une forme de créneau incalculable, en nommant la faute.
 *
 * `RangeError` et non une erreur de domaine : y arriver est un défaut de
 * programmation, pas une saisie fautive — la contrainte
 * `tenants_slot_interval_minutes_check` borne le pas en base, et le catalogue
 * borne la durée d'une prestation. Le garde existe pour que ce défaut se voie
 * ici plutôt que sous la forme d'une boucle qui ne rend jamais la main : un pas
 * nul ou négatif ne produit pas un mauvais résultat, il fige le processus.
 */
function assertComputable(shape: SlotShape): void {
  if (!Number.isInteger(shape.slotIntervalMinutes) || shape.slotIntervalMinutes < 1) {
    throw new RangeError(
      `pas de créneau attendu en minutes entières et strictement positif : ${String(shape.slotIntervalMinutes)}`,
    );
  }
  if (!Number.isInteger(shape.serviceDurationMinutes) || shape.serviceDurationMinutes < 1) {
    throw new RangeError(
      `durée de prestation attendue en minutes entières et strictement positive : ${String(shape.serviceDurationMinutes)}`,
    );
  }
  if (
    !Number.isInteger(shape.bufferBeforeMinutes) ||
    shape.bufferBeforeMinutes < 0 ||
    !Number.isInteger(shape.bufferAfterMinutes) ||
    shape.bufferAfterMinutes < 0
  ) {
    throw new RangeError(
      `tampons attendus en minutes entières et positifs : ${String(shape.bufferBeforeMinutes)}, ${String(shape.bufferAfterMinutes)}`,
    );
  }
}

/**
 * Les créneaux proposables d'un praticien, triés par instant de début.
 *
 * Le balayage tient en une passe : les fenêtres fusionnées et les fragments
 * libres sont tous deux triés, et chaque fragment appartient à exactement une
 * fenêtre — la soustraction ne produit rien hors de ce qu'elle a reçu. Le
 * curseur `anchorIndex` ne recule donc jamais.
 */
function slotsForStaff(
  free: StaffFreeTime,
  shape: SlotShape,
  notBefore: number,
): StaffSlot[] {
  // Origines de grille. La fusion est ce qui fait d'une journée continue décrite
  // en deux plages adjacentes une seule grille — voir l'en-tête du module.
  const anchors = mergeRanges(free.windows);
  const fragments = subtractRanges(anchors, free.busy);

  const stepMs = shape.slotIntervalMinutes * MINUTE_MS;
  const occupiedMs = occupiedMinutesOf(shape) * MINUTE_MS;
  const billedOffsetMs = shape.bufferBeforeMinutes * MINUTE_MS;
  const billedDurationMs = shape.serviceDurationMinutes * MINUTE_MS;

  const slots: StaffSlot[] = [];
  let anchorIndex = 0;

  for (const fragment of fragments) {
    const fragmentStart = fragment.startsAt.getTime();
    const fragmentEnd = fragment.endsAt.getTime();

    while (anchorIndex < anchors.length) {
      const candidate = anchors[anchorIndex];
      if (candidate === undefined || candidate.endsAt.getTime() > fragmentStart) {
        break;
      }
      anchorIndex += 1;
    }

    const anchor = anchors[anchorIndex];

    /* istanbul ignore next -- inatteignable : tout fragment libre est issu d'une
       de ces fenêtres, donc contenu dans l'une d'elles. Le garde tient la
       promesse du type plutôt qu'un `!` non vérifié. */
    if (anchor === undefined) {
      break;
    }

    const origin = anchor.startsAt.getTime();

    // Première position de grille utilisable : au plus tôt le début du fragment,
    // et jamais avant le délai minimum de réservation. Le saut est calculé plutôt
    // qu'atteint pas à pas — sur une fenêtre d'un mois, itérer depuis l'origine
    // ferait des dizaines de milliers de tours pour n'en retenir aucun.
    const earliest = Math.max(fragmentStart, notBefore);
    const offset = earliest - origin;
    const steps = offset <= 0 ? 0 : Math.ceil(offset / stepMs);

    for (
      let occupiedStart = origin + steps * stepMs;
      occupiedStart + occupiedMs <= fragmentEnd;
      occupiedStart += stepMs
    ) {
      const billedStart = occupiedStart + billedOffsetMs;

      slots.push({
        staffId: free.staffId,
        startsAt: new Date(billedStart),
        endsAt: new Date(billedStart + billedDurationMs),
      });
    }
  }

  return slots;
}

/**
 * Les créneaux proposables de tous les praticiens candidats.
 *
 * Le tri est **(instant, praticien)** et non l'ordre d'arrivée : deux praticiens
 * libres à la même heure produisent deux créneaux, et sans second critère leur
 * ordre suivrait celui de la base — qui n'en garantit aucun. Un calendrier qui
 * change d'ordre d'un rafraîchissement à l'autre passe pour instable, et une
 * assertion de test réussirait une fois sur deux.
 *
 * Aucun regroupement n'est fait ici : deux praticiens libres à 10:00 rendent
 * deux créneaux. Choisir lequel proposer — l'option « premier disponible » —
 * relève de #36, qui a sa propre règle d'affectation à documenter ; la fondre
 * ici priverait ce ticket-là de la matière sur laquelle décider.
 */
export function computeSlots(input: SlotComputation): StaffSlot[] {
  assertComputable(input.shape);

  const notBefore = input.notBefore.getTime();
  const slots = input.staff.flatMap((free) => slotsForStaff(free, input.shape, notBefore));

  return slots.sort((left, right) => {
    const byInstant = left.startsAt.getTime() - right.startsAt.getTime();

    return byInstant !== 0 ? byInstant : left.staffId.localeCompare(right.staffId);
  });
}
