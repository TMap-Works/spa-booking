'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Le pays de l'établissement, pour les champs téléphone qui ne le reçoivent pas
 * en propriété (#825).
 *
 * Six des sept formulaires qui saisissent un numéro sont rendus sous un gabarit
 * qui a **déjà** lu l'établissement — le back-office (`admin/layout.tsx`) et
 * l'espace client (`compte/layout.tsx`) appellent tous deux la vitrine
 * publique. Descendre son pays de page en panneau, puis de panneau en
 * formulaire, aurait ajouté une propriété à une douzaine de composants qui
 * n'en font rien ; le contexte la pose une fois, au gabarit.
 *
 * `null` quand l'établissement n'a pas publié d'adresse : `PhoneField` retombe
 * alors sur son repli (`FALLBACK_PHONE_COUNTRY`), comme sans fournisseur.
 */
const PhoneCountryContext = createContext<string | null>(null);

export function PhoneCountryProvider({
  country,
  children,
}: {
  readonly country: string | null;
  readonly children: ReactNode;
}) {
  return <PhoneCountryContext.Provider value={country}>{children}</PhoneCountryContext.Provider>;
}

export function usePhoneCountry(): string | null {
  return useContext(PhoneCountryContext);
}
