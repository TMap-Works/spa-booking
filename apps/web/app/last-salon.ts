import { slugSchema } from '@spa/shared';
import { cookies } from 'next/headers';

/**
 * Le cookie qui retient le dernier salon ouvert depuis l'accueil.
 *
 * Il ne porte qu'un slug — l'adresse publique d'un salon, que n'importe qui peut
 * lire sur sa vitrine — et ne sert qu'à épargner une seconde saisie à la
 * personne qui revient. C'est un réglage d'interface demandé par son geste,
 * pas un traceur : aucun tiers ne le lit, et il ne quitte jamais ce domaine.
 *
 * `httpOnly` et `sameSite: 'lax'` comme les cookies de session
 * (`compte/session.ts`) : le front n'a aucune raison de le lire en JavaScript.
 */
export const LAST_SALON_COOKIE = 'spa_dernier_salon';

/** Six mois : le rythme d'un rendez-vous de coiffure ou de soin reste en deçà. */
const LAST_SALON_MAX_AGE_SECONDS = 60 * 60 * 24 * 183;

/**
 * Le slug retenu, ou `null`. La valeur vient du navigateur : elle est relue par
 * le schéma du contrat, et une valeur que le contrat refuse est ignorée plutôt
 * que d'être envoyée à l'API.
 */
export async function readLastSalon(): Promise<string | null> {
  const stored = (await cookies()).get(LAST_SALON_COOKIE)?.value;
  const parsed = slugSchema.safeParse(stored);

  return parsed.success ? parsed.data : null;
}

export async function rememberSalon(tenantSlug: string): Promise<void> {
  (await cookies()).set(LAST_SALON_COOKIE, tenantSlug, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: LAST_SALON_MAX_AGE_SECONDS,
  });
}
