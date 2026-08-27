/**
 * Algèbre d'intervalles UTC — fusion et soustraction (#33).
 *
 * C'est ici que « un praticien absent ne doit apparaître dans aucun créneau »
 * devient calculable. Le moteur de disponibilité (booking-engine §3, étape 2)
 * construit les fenêtres de travail d'un praticien, puis leur **retranche** ses
 * indisponibilités. Ce module est cette soustraction, et rien d'autre.
 *
 * ## Pourquoi une soustraction, et pas un filtre
 *
 * Écarter les créneaux « qui tombent pendant une absence » suppose d'avoir
 * d'abord découpé la journée en créneaux, donc de tester chaque créneau contre
 * chaque absence : le résultat dépend alors du pas de découpage. Un déjeuner de
 * 12:15 à 12:45 laisserait intact un créneau de 12:00 à 13:00 avec un pas
 * horaire, et le praticien serait proposé pendant son absence.
 *
 * Retrancher **avant** de découper donne le bon résultat quel que soit le pas :
 * la fenêtre 09:00–18:00 moins 12:15–12:45 vaut deux fenêtres, et le découpage
 * qui suit ne peut plus produire un créneau à cheval.
 *
 * ## Ce que ce module ne connaît pas
 *
 * Ni Prisma, ni HTTP, ni le fuseau du tenant, ni la forme des fenêtres de
 * travail — récurrentes ou non. Des `Date` et des `Date` : ce sont des instants
 * UTC, et deux instants se comparent sans fuseau. Un congé qui traverse un
 * changement d'heure n'y demande donc aucun traitement particulier — c'est la
 * *construction* des bornes qui relève du fuseau (`availability.time.ts`), pas
 * leur arithmétique.
 *
 * Fonctions pures, sans état : elles ne mutent aucun argument et rendent
 * toujours de nouveaux objets.
 */

import type { UtcRange } from './availability.time';

/** `[startsAt, endsAt[` — borne haute exclue, comme partout dans le module. */
function isNonEmpty(range: UtcRange): boolean {
  return range.endsAt.getTime() > range.startsAt.getTime();
}

/** Copie défensive : les bornes rendues ne partagent aucune `Date` mutable. */
function copy(startsAt: number, endsAt: number): UtcRange {
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

/**
 * Trie et fusionne des intervalles qui se chevauchent ou se touchent.
 *
 * Deux absences qui se recouvrent ne sont que la même absence dite deux fois :
 * les fusionner d'abord rend la soustraction linéaire et, surtout, la rend
 * **indépendante de l'ordre d'insertion en base**. Sans cette étape, retrancher
 * `[10, 12[` puis `[11, 13[` d'une même fenêtre demanderait de recoller des
 * morceaux déjà découpés.
 *
 * Les intervalles **adjacents** sont fusionnés eux aussi (`[9, 12[` et
 * `[12, 14[` donnent `[9, 14[`). Ils décrivent une seule absence continue, et
 * les laisser séparés produirait entre eux une fenêtre libre de durée nulle —
 * un créneau que le découpage ne saurait pas ignorer.
 *
 * Les intervalles vides ou inversés sont **écartés** : la base les refuse déjà
 * (`CHECK ("ends_at" > "starts_at")`), mais cette fonction sert aussi des
 * fenêtres calculées, où un intervalle vide est un résultat légitime dont on
 * n'a plus rien à faire.
 */
export function mergeRanges(ranges: readonly UtcRange[]): UtcRange[] {
  const sorted = ranges
    .filter(isNonEmpty)
    .map((range) => ({ start: range.startsAt.getTime(), end: range.endsAt.getTime() }))
    .sort((left, right) => left.start - right.start);

  const merged: { start: number; end: number }[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];

    // `>=` et non `>` : c'est ce qui recolle les intervalles adjacents.
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }

    merged.push({ start: range.start, end: range.end });
  }

  return merged.map((range) => copy(range.start, range.end));
}

/**
 * Retranche `blocked` de `windows` — le calcul du critère « les plages bloquées
 * retirent bien les créneaux correspondants ».
 *
 * Les quatre positions relatives sont traitées par le même balayage :
 *
 * | Position de l'absence | Ce qu'il reste de la fenêtre |
 * |---|---|
 * | avant, ou après, sans se toucher | la fenêtre entière |
 * | mord sur le début | un morceau, décalé à la fin de l'absence |
 * | mord sur la fin | un morceau, tronqué au début de l'absence |
 * | au milieu | **deux** morceaux |
 * | recouvre tout | rien — le praticien n'a aucun créneau ce jour-là |
 *
 * Le dernier cas est celui du congé sur plusieurs jours : chaque journée de
 * travail qu'il recouvre disparaît entièrement, sans que rien d'autre n'ait à
 * connaître la notion de « congé ».
 *
 * Le résultat est trié, fusionné et sans intervalle vide — donc directement
 * découpable en créneaux.
 */
export function subtractRanges(
  windows: readonly UtcRange[],
  blocked: readonly UtcRange[],
): UtcRange[] {
  const holes = mergeRanges(blocked);

  if (holes.length === 0) {
    return mergeRanges(windows);
  }

  const remaining: UtcRange[] = [];

  for (const window of mergeRanges(windows)) {
    // Curseur : début de ce qu'il reste de la fenêtre courante. Il n'avance
    // jamais en arrière, ce qui rend le balayage linéaire — les trous étant
    // triés, celui qu'on vient de traiter ne peut plus concerner ce curseur.
    let cursor = window.startsAt.getTime();
    const windowEnd = window.endsAt.getTime();

    for (const hole of holes) {
      const holeStart = hole.startsAt.getTime();
      const holeEnd = hole.endsAt.getTime();

      if (holeEnd <= cursor) {
        continue;
      }
      if (holeStart >= windowEnd) {
        break;
      }
      if (holeStart > cursor) {
        remaining.push(copy(cursor, holeStart));
      }

      cursor = Math.max(cursor, holeEnd);

      if (cursor >= windowEnd) {
        break;
      }
    }

    if (cursor < windowEnd) {
      remaining.push(copy(cursor, windowEnd));
    }
  }

  return remaining;
}

/**
 * `true` si les deux intervalles ont au moins un instant en commun.
 *
 * La comparaison est stricte des deux côtés parce que la borne haute est
 * exclue : une absence qui finit exactement quand un créneau commence ne le
 * bloque pas. C'est ce qui rend un rendez-vous à 14:00 possible après un congé
 * qui court « jusqu'à 14:00 », et c'est la même convention que celle de la
 * contrainte d'exclusion d'`appointments` (`tstzrange` en `[)`).
 */
export function rangesOverlap(left: UtcRange, right: UtcRange): boolean {
  return (
    left.startsAt.getTime() < right.endsAt.getTime() &&
    right.startsAt.getTime() < left.endsAt.getTime()
  );
}
