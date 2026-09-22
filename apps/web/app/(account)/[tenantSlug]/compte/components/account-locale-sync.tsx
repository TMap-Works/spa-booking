'use client';

import type { Locale } from '@spa/shared';
import { useLocale } from 'next-intl';
import { useEffect, useRef } from 'react';

import { saveAccountLocaleAction } from '../actions';

/**
 * Le choix du sélecteur de langue, reporté sur le compte — #847, quatrième
 * critère d'acceptation : *« une cliente connectée qui change de langue dans le
 * sélecteur voit ce choix enregistré sur son compte »*.
 *
 * ## Pourquoi ici, et pas dans le sélecteur
 *
 * Le sélecteur (`components/ui/locale-switcher.tsx`) et son action
 * (`i18n/actions.ts`) sont partagés par les trois coquilles du produit : la
 * vitrine publique, l'espace client et le back-office. Deux d'entre elles n'ont
 * aucun compte client à mettre à jour, et la vitrine n'a même pas de jeton sous
 * la main — y poser un appel à `PATCH /auth/me` aurait mis une écriture d'API
 * sur le chemin de chaque changement de langue du produit, y compris là où elle
 * n'a aucun sens.
 *
 * La question ne se pose que dans cet espace : c'est donc lui qui la pose.
 *
 * ## Comment il décide, et pourquoi il ne boucle pas
 *
 * Deux valeurs, lues par le gabarit sur les cookies de #845 :
 *
 * | Valeur | D'où elle vient |
 * |---|---|
 * | `chosen` | le cookie `spa_locale` — **le choix explicite du sélecteur**, et rien d'autre |
 * | `recorded` | le cookie `spa_account_locale` — le miroir de `users.locale` |
 *
 * L'écriture n'a lieu que si les deux existent et diffèrent. Se fier à la langue
 * *affichée* plutôt qu'au cookie explicite aurait enregistré sur le compte ce
 * que l'`Accept-Language` du navigateur avait simplement deviné — une préférence
 * que personne n'a exprimée, là où `locale: null` se lit « aucune » (#844).
 *
 * La boucle est fermée deux fois : par le `ref`, qui ne laisse partir qu'un
 * appel par valeur, et par l'action elle-même, qui remet le miroir à jour — au
 * rendu suivant, les deux valeurs coïncident et l'effet ne fait plus rien.
 *
 * ## Ce que son échec coûte
 *
 * Rien de visible. La langue affichée est déjà la bonne — c'est le cookie
 * explicite qui la donne —, et seul le report sur le compte échoue. Il sera
 * retenté à la navigation suivante. Un bandeau d'erreur pour un geste que
 * personne n'a demandé apprendrait surtout à la cliente que quelque chose ne va
 * pas, sans rien lui donner à faire.
 */
interface AccountLocaleSyncProps {
  readonly tenantSlug: string;
  /** Le choix explicite du sélecteur, ou `null` si personne n'en a fait. */
  readonly chosen: Locale | null;
  /** La préférence déjà enregistrée sur le compte, ou `null`. */
  readonly recorded: Locale | null;
}

export function AccountLocaleSync({ tenantSlug, chosen, recorded }: AccountLocaleSyncProps) {
  /**
   * La langue réellement affichée — elle n'entre pas dans la décision, mais elle
   * garde l'effet en phase avec le rendu : un changement de langue rejoue la
   * route, donc ce composant, et c'est ce qui le réveille.
   */
  const shown = useLocale();
  /**
   * Le dernier **couple** envoyé — un appel par état du serveur, jamais un par
   * rendu.
   *
   * Le couple et non le seul choix : les deux valeurs viennent des cookies, et
   * le miroir change sans que le choix bouge. Une cliente qui choisit l'anglais
   * — reporté sur son compte —, puis retire sa préférence depuis l'écran des
   * coordonnées, puis redemande l'anglais au sélecteur, repose exactement le
   * même `chosen` sur un `recorded` redevenu nul. Se souvenir du seul `chosen`
   * aurait fait tomber ce second choix dans le vide : l'écran serait passé en
   * anglais, le compte serait resté sans préférence, et les e-mails du salon
   * seraient repartis dans l'autre langue.
   *
   * Cette coquille n'est pas démontée par un `router.refresh()` ni par l'action
   * du sélecteur — toutes deux rejouent la route sans navigation —, si bien que
   * ce `ref` survit à la séquence entière.
   */
  const sent = useRef<string | null>(null);

  useEffect(() => {
    const attempt = `${chosen ?? ''}:${recorded ?? ''}`;

    if (chosen === null || chosen === recorded || sent.current === attempt) {
      return;
    }

    sent.current = attempt;
    // Le résultat n'est pas lu : voir l'en-tête sur ce que son échec coûte.
    void saveAccountLocaleAction(tenantSlug, chosen);
  }, [chosen, recorded, shown, tenantSlug]);

  return null;
}
