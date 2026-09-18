import { cookies } from 'next/headers';
import { z } from 'zod';

/**
 * La présence d'une cliente connectée, lisible **partout chez le salon** (#1045).
 *
 * ## Pourquoi un cookie à part
 *
 * Les jetons de session sont bornés à `/{slug}/compte` (`compte/session.ts`) :
 * la vitrine et le tunnel ne les reçoivent jamais, et c'est très bien ainsi —
 * un jeton ne voyage que là où on s'en sert. Mais l'en-tête du salon doit dire
 * « Alice » sur la vitrine comme dans l'espace client (BM-COMPTE-01).
 *
 * Élargir le chemin des jetons aurait posé un problème sans remède propre : les
 * cookies déjà posés sur `/{slug}/compte` auraient survécu à la déconnexion, et
 * le navigateur aurait envoyé les deux homonymes — le plus spécifique d'abord,
 * donc le périmé. Next ne sait pas écrire deux cookies du même nom dans une
 * réponse pour effacer l'ancien.
 *
 * D'où ce cookie-ci : posé sur `/{slug}`, il ne porte **que le prénom et le
 * nom**, jamais un jeton, et n'autorise rien. Il sert à afficher, pas à
 * décider : une page qui a besoin du compte lit toujours la vraie session.
 * Un cookie de présence qui survivrait à une session expirée montrerait au pire
 * « Alice » sur un lien qui mène à la connexion.
 */

export const PRESENCE_COOKIE = 'spa_account_presence';

export interface AccountPresence {
  readonly firstName: string;
  readonly lastName: string;
}

/** Relu sans confiance : la valeur vient du navigateur. */
const presenceSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100),
});

export function presenceCookieValue(user: AccountPresence): string {
  return JSON.stringify({ firstName: user.firstName, lastName: user.lastName });
}

export function parsePresence(raw: string | undefined): AccountPresence | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed = presenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Les attributs du cookie : ceux de la session, sur tout le salon. */
export function presenceCookieOptions(tenantSlug: string, maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/${encodeURIComponent(tenantSlug)}`,
    maxAge,
  } as const;
}

/** La cliente connectée chez ce salon, telle que l'en-tête la salue — ou `null`. */
export async function readAccountPresence(): Promise<AccountPresence | null> {
  const store = await cookies();
  return parsePresence(store.get(PRESENCE_COOKIE)?.value);
}
