'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Le silence après lequel la frappe est versée au brouillon.
 *
 * Le compromis habituel entre « rien n'est perdu » et « on n'écrit pas pour
 * rien » — voir `useDraftAutosave` pour ce que le délai coûte et ce qui ferme
 * sa fenêtre. Exporté pour que les tests éprouvent l'échéance sans la redire.
 */
export const DRAFT_AUTOSAVE_DELAY_MS = 400;

export interface DraftAutosave {
  /** Reporte une écriture, en annulant celle qui était en attente. */
  readonly schedule: () => void;
  /** Écrit tout de suite ce qui était en attente ; sans rien en attente, ne fait rien. */
  readonly flush: () => void;
  /** Abandonne l'écriture en attente — pour qui vient d'écrire lui-même. */
  readonly cancel: () => void;
}

/**
 * Le report du brouillon **à la frappe**, et non à la seule sortie de champ (#737).
 *
 * `docs/design/appointments/README.md` — « Le modèle en six étapes » : la
 * progression est « doublée en `sessionStorage`, pour qu'un rafraîchissement ne
 * perde jamais la saisie ». Le tunnel tenait cette promesse pour tout ce qui se
 * *choisit* — prestation, praticien, créneau — et pour tout champ **quitté** : le
 * formulaire de coordonnées est non contrôlé, et c'est son `focusout` qui versait
 * la saisie au brouillon.
 *
 * Restait le champ encore actif au moment du rechargement, qui n'était jamais
 * enregistré. À 360 px, c'est le cas le plus fréquent et non le cas limite : le
 * geste de rafraîchissement se fait au pouce pendant la frappe, et l'OS réveille
 * un onglet mis en arrière-plan en le rechargeant. « Un mot pour le salon » — le
 * champ le plus long à retaper, et le dernier du formulaire — revenait vide
 * quand les quatre autres avaient survécu.
 *
 * ## Deux moments d'écriture, pas un
 *
 * - **la frappe, débouncée** (`schedule`) : une écriture après un court silence,
 *   et non une par caractère. Le brouillon est réécrit en entier à chaque fois —
 *   sérialisation JSON et rendu du tunnel comprises —, ce qui ne se fait pas
 *   vingt fois dans le mot « allergie ». Le délai est le compromis habituel
 *   entre « rien n'est perdu » et « on n'écrit pas pour rien » ;
 * - **le masquage de la page** (`pagehide`, `visibilitychange`) : la seule
 *   notification qu'un navigateur donne avant de laisser partir — ou de geler —
 *   un onglet. C'est ce qui ferme la fenêtre du délai ci-dessus : un rechargement
 *   déclenché entre la dernière frappe et l'échéance du report verse quand même
 *   la saisie, au lieu de la perdre.
 *
 * `beforeunload` n'y figure pas, à dessein : il n'est pas distribué de façon
 * fiable sur mobile — le cas même que le ticket décrit — et un écouteur posé sur
 * lui suffit, dans plusieurs navigateurs, à écarter la page du cache de
 * navigation arrière. `pagehide` couvre le départ, `visibilitychange` couvre le
 * gel, et les deux sont distribués là où `beforeunload` ne l'est pas.
 *
 * ## Ce que le crochet ne fait pas
 *
 * Il ne sait pas *ce qu'*il enregistre : il reçoit un `save` et décide **quand**
 * l'appeler. La lecture des valeurs du formulaire reste à l'étape, et l'écriture
 * dans `sessionStorage` au tunnel — voir `lib/booking/draft.ts` pour le partage
 * des rôles entre l'URL et le stockage.
 */
export function useDraftAutosave(
  save: () => void,
  delayMs: number = DRAFT_AUTOSAVE_DELAY_MS,
): DraftAutosave {
  /**
   * Le `save` du dernier rendu, et non celui du rendu où le report a été posé.
   *
   * Le report survit à des rendus — c'est tout son objet. Sans ce renvoi, le
   * temporisateur appellerait la fonction capturée à la frappe, qui lit les
   * valeurs d'alors ; et les écouteurs de masquage, posés une fois, seraient
   * réenregistrés à chaque rendu pour suivre une identité qui change.
   */
  const saveRef = useRef(save);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    // Rien en attente : la saisie est déjà au brouillon, et réécrire à
    // l'identique coûterait un rendu du tunnel à chaque changement d'onglet.
    if (timerRef.current === null) {
      return;
    }

    cancel();
    saveRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    cancel();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      saveRef.current();
    }, delayMs);
  }, [cancel, delayMs]);

  /**
   * Le masquage de la page — départ, changement d'onglet, ou gel par l'OS.
   *
   * `visibilitychange` n'est écouté que pour la bascule vers `hidden` : l'onglet
   * qui *revient* n'a rien à enregistrer. Les deux événements peuvent tomber
   * coup sur coup pour un même départ, ce qui est sans conséquence — le premier
   * consomme le report, le second ne trouve plus rien en attente.
   */
  useEffect(() => {
    const onPageHide = (): void => {
      flush();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flush]);

  /**
   * Le démontage de l'étape n'emporte pas le report en attente.
   *
   * Quitter « Coordonnées » par un bouton verse la saisie explicitement, mais
   * le geste retour du navigateur, lui, change d'étape sans passer par nos
   * boutons : le temporisateur serait nettoyé avec son composant, et les
   * dernières lettres tapées perdues à l'écran suivant.
   *
   * `flush` est stable — ses dépendances le sont —, donc ce nettoyage-ci ne
   * s'exécute qu'au démontage, et non entre deux rendus.
   */
  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  return { schedule, flush, cancel };
}
