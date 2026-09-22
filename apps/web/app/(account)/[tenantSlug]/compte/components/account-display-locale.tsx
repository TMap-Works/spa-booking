'use client';

import { useLocale } from 'next-intl';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { DisplayLocale } from '@/lib/format';

/**
 * Ce qui décide de la **mise en forme** dans l'espace client — la langue lue sur
 * la requête, et le pays de l'établissement (#847).
 *
 * ## Pourquoi un contexte, et non une propriété de plus
 *
 * `lib/format.ts` demande les deux : la langue dit les mots qu'`Intl` ne connaît
 * pas, le pays dit l'ordre des chiffres — « 9/1/2026 » en `en-US`, « 01/09/2026 »
 * en `en-GB`, et les deux sont de l'anglais. La langue, un Client Component la
 * lit seul (`useLocale`). Le pays, non : il vient de la fiche publique, que seul
 * le gabarit a chargée.
 *
 * Le descendre de page en liste, de liste en carte et de carte en bouton
 * d'annulation aurait ajouté la même propriété à six composants qui n'en font
 * rien d'autre que la retransmettre. Le gabarit le pose une fois — exactement le
 * motif de `components/ui/phone-country.tsx` (#825), qui a déjà tranché cette
 * question pour le même arbre de composants et le même champ de la même fiche.
 *
 * ## Hors fournisseur, le repli est celui de `lib/format.ts`
 *
 * `null` — c'est-à-dire « l'établissement n'a pas publié de pays » —, ce qui
 * ramène `formattingLocale` à sa région de repli documentée : `fr` → `fr-FR`,
 * `en` → `en-US`. Une carte montée seule dans une suite unitaire se comporte
 * donc comme avant ce ticket, sans avoir à monter un fournisseur.
 */
const AccountCountryContext = createContext<string | null>(null);

export function AccountDisplayLocaleProvider({
  countryCode,
  children,
}: {
  /** `Tenant.address.country` — ISO 3166-1 alpha-2, ou rien. */
  readonly countryCode: string | null;
  readonly children: ReactNode;
}) {
  return (
    <AccountCountryContext.Provider value={countryCode}>{children}</AccountCountryContext.Provider>
  );
}

/**
 * La langue et le pays à passer à `lib/format.ts`, depuis un Client Component.
 *
 * Mémoïsé, et ce n'est pas une précaution de style : l'historique regroupe sa
 * liste par mois dans un `useMemo` dont c'est une dépendance, et un objet neuf à
 * chaque rendu ferait rejouer le regroupement — donc deux `Intl.DateTimeFormat`
 * et un tri — à chaque frappe sur un filtre.
 */
export function useAccountDisplay(): DisplayLocale {
  const locale = useLocale();
  const countryCode = useContext(AccountCountryContext);

  return useMemo(() => ({ locale, countryCode }), [countryCode, locale]);
}
