import type { PublicTenant } from '@spa/shared';

import { SalonAuthScreen } from '@/components/auth/salon-auth-screen';
import { readSessionNotice } from '@/lib/session-refresh';

import { LoginForm } from '../components/login-form';
import { readAccessToken, readRefreshToken } from '../session';
import { accountTenant } from '../tenant';

/**
 * L'écran de connexion — **la seule page de l'espace client qui n'exige pas de
 * session**, avec l'inscription.
 *
 * Elle n'appelle donc pas `readAccountData` : la garde vit dans chaque page, et
 * ces deux-là s'en passent délibérément plutôt que d'être exemptées par une
 * liste tenue ailleurs. Une exemption par liste finit toujours par contenir une
 * page de trop.
 *
 * ## Le cadre d'accueil est porté ici, et non par le gabarit (#1052)
 *
 * Son titre nomme le salon **et l'écran** — « Bienvenue chez Maison Lotus » ici,
 * « Créez votre compte Maison Lotus » à l'inscription. Un layout de l'App Router
 * ne sait pas quelle route il enveloppe, et il n'est pas rejoué d'un écran à
 * l'autre du même segment : le titre calculé là-haut serait resté celui de la
 * page précédente après un clic sur « Créer mon compte ».
 */

export const dynamic = 'force-dynamic';

interface LoginPageProps {
  readonly params: Promise<{ readonly tenantSlug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ params, searchParams }: LoginPageProps) {
  const { tenantSlug } = await params;
  const { motif } = await searchParams;

  /*
   * La fiche est déjà lue par le gabarit, dans la même passe de rendu :
   * `accountTenant` est mémoïsé par `cache` de React, et cette seconde lecture
   * ne coûte aucun appel de plus. Un slug inconnu a fait 404 là-haut ; ici, une
   * panne de l'API ne doit pas emporter l'écran de connexion — on se contente
   * alors d'un cadre sans identité, plutôt que de refuser de servir le
   * formulaire.
   */
  let tenant: PublicTenant | null;
  try {
    tenant = await accountTenant(tenantSlug);
  } catch {
    tenant = null;
  }

  /*
   * Le gabarit écrit-il déjà un titre de premier niveau ?
   *
   * Il le fait dès qu'un cookie de session subsiste — « Bonjour Marie ». Or
   * cet écran est servi **avec** ses cookies quand le renouvellement de session
   * échoue sans être refusé : `session/refresh` les conserve et renvoie ici
   * avec `?motif=renouvellement-indisponible` (#860). Le titre du cadre
   * descend alors d'un rang, pour qu'il n'y ait jamais deux `h1` sur l'écran.
   *
   * La condition est celle du gabarit, à la lettre (`../layout.tsx`) : deux
   * lectures d'un même cookie, et non deux règles.
   */
  const signedIn = (await readAccessToken()) !== null || (await readRefreshToken()) !== null;

  return (
    <SalonAuthScreen tenant={tenant} intent="connexion" headlineAs={signedIn ? 'p' : 'h1'}>
      {/*
        Le motif n'est pas comparé ici à une chaîne écrite sur place (#860) : il
        y en a désormais deux, et chaque écran qui les réécrirait finirait par en
        oublier un. `readSessionNotice` écarte aussi ce que personne n'a écrit.
      */}
      <LoginForm tenantSlug={tenantSlug} notice={readSessionNotice(motif)} />
    </SalonAuthScreen>
  );
}
