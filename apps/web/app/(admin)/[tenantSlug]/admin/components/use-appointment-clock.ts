'use client';

import { useEffect, useState } from 'react';

/**
 * L'horloge des écrans de planning — la source de `now` qui ne casse pas
 * l'hydratation (#1210).
 *
 * ## Le problème qu'elle résout
 *
 * `canRecordAppointmentOutcome` (`@spa/shared`) a besoin d'un instant, et un
 * `Date.now()` lu pendant le rendu d'un composant client est exactement ce qui
 * produit un écart d'hydratation : le serveur rend son horloge, le navigateur
 * rejoue la sienne, et React trouve deux arbres différents. L'écart est rare —
 * il faut que l'instant tombe de part et d'autre de l'heure du soin entre les
 * deux rendus —, ce qui en fait précisément le genre de défaut qu'on ne
 * reproduit pas.
 *
 * ## Deux usages, une seule écriture
 *
 * - **Avec une graine** — un écran rendu par le serveur lui passe *son* instant.
 *   Le premier rendu du navigateur lit alors la même valeur que celui du
 *   serveur : l'hydratation est identique par construction, et il n'y a aucun
 *   clignotement. C'est le cas de « Mon planning », dont la page serveur connaît
 *   déjà `now`.
 * - **Sans graine** — l'horloge ne parle qu'après le montage, et rend `null`
 *   avant. C'est le cas du tiroir du comptoir, qui n'existe qu'à la suite d'un
 *   clic et n'est donc jamais rendu par le serveur avec un rendez-vous dedans.
 *
 * ## Elle avance — mais **à partir de la graine**, pas de l'horloge du poste
 *
 * Un tiroir reste ouvert pendant qu'on décroche le téléphone. L'heure du soin
 * peut passer entre l'ouverture et le geste, et un écran qui garde l'instant de
 * son montage continuerait de refuser un constat devenu légitime. Le pas est
 * celui de la grille du planning, qui n'a pas besoin de la seconde.
 *
 * Ce qui avance, c'est **l'écart écoulé depuis le montage**, ajouté à la graine :
 * l'écran suit donc l'horloge du **serveur**, décalée du temps qui passe, et non
 * celle du poste. La différence n'est pas théorique — un poste de comptoir dont
 * la pendule avance d'un jour ouvrirait sinon « Marquer non honoré » sur le
 * rendez-vous de demain, c'est-à-dire exactement le geste terminal et sans
 * retour que ce ticket ferme. Le serveur reste l'arbitre de toute façon
 * (`isAppointmentNotStartedRefusal`), mais un écran qui propose un geste que
 * l'API refusera est un écran qui ment.
 *
 * Sans graine, il n'y a rien à quoi s'ancrer et l'horloge du poste fait foi —
 * c'est le cas du tiroir, qui n'est rendu par aucun serveur.
 */

/** Le pas de l'horloge — la demi-minute, comme la granularité du planning. */
export const APPOINTMENT_CLOCK_MS = 30_000;

/**
 * L'instant à prendre tant que l'horloge n'a pas parlé : **antérieur à tout**.
 *
 * Le premier rendu penche ainsi du côté qui *ferme* les constats, jamais du
 * côté qui les ouvre — un bouton qu'on désactive après coup est un bouton qu'on
 * a offert, et « honoré » comme « non honoré » sont terminaux et sans retour.
 */
export const BEFORE_ANY_HOUR = Number.NEGATIVE_INFINITY;

/**
 * L'instant courant, en millisecondes — `null` tant que le navigateur n'a pas
 * pris la main et qu'aucune graine n'a été fournie.
 */
export function useAppointmentClock(seed?: string | number | null): number | null {
  const anchor = seedInstant(seed);
  const [now, setNow] = useState<number | null>(anchor);

  useEffect(() => {
    // L'écart entre l'horloge du serveur et celle du poste, mesuré une fois au
    // montage. Nul en l'absence de graine : il n'y a alors rien à corriger.
    const drift = anchor === null ? 0 : anchor - Date.now();
    const tick = (): void => {
      setNow(Date.now() + drift);
    };

    // Tout de suite, et non au premier battement : un écran semé par le serveur
    // resterait sinon trente secondes sur un instant déjà consommé par le trajet
    // de la page.
    tick();
    const timer = window.setInterval(tick, APPOINTMENT_CLOCK_MS);

    return () => {
      window.clearInterval(timer);
    };
    // L'ancre et non la graine brute : deux chaînes différentes qui désignent le
    // même instant ne doivent pas reposer l'écart, et un rendu de plus ne doit
    // pas le recalculer — c'est le décalage du **montage** qui fait foi.
  }, [anchor]);

  return now;
}

/** La graine, ramenée à des millisecondes — `null` si elle est illisible. */
function seedInstant(seed: string | number | null | undefined): number | null {
  if (seed === null || seed === undefined) {
    return null;
  }

  const instant = typeof seed === 'number' ? seed : Date.parse(seed);

  return Number.isNaN(instant) ? null : instant;
}
