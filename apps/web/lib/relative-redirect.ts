import { NextResponse } from 'next/server';

import { sitePath } from '@/lib/site-path';

/**
 * Une redirection **relative** — `Location: /chemin` —, que le navigateur résout
 * sur l'URL qu'il vient lui-même de demander (#856).
 *
 * ## Pourquoi pas `NextResponse.redirect(new URL(chemin, request.nextUrl))`
 *
 * Parce que l'hôte de `request.nextUrl` n'est pas celui du navigateur. Next
 * construit l'URL d'une requête sur l'adresse **d'écoute** du serveur, pas sur
 * l'en-tête `Host` (`initURL`, `next/dist/server/lib/router-utils/resolve-routes`) :
 *
 * - `localhost` sous `next dev` — un navigateur venu par `127.0.0.1` était
 *   renvoyé sur un autre hôte, sans ses cookies, donc à la connexion. C'est ce
 *   que le scénario e2e de #856 a fait apparaître ;
 * - `0.0.0.0` dans l'image, qui pose `HOSTNAME=0.0.0.0` pour que l'ALB joigne la
 *   tâche (`apps/web/Dockerfile`) — une adresse d'écoute, injoignable comme
 *   destination.
 *
 * Une URL relative ne dépend ni de l'un ni de l'autre, et n'a pas à faire
 * confiance à un en-tête que le client contrôle.
 *
 * ## Ce qui est refusé
 *
 * Tout ce qui n'est pas, **une fois normalisé**, un chemin du site — voir
 * `sitePath`. Un `Location` relatif en `//…` mènerait sur un autre domaine. Les
 * appelants passent des chemins déjà revalidés (`safeAdminNext`, `safeNext`, les
 * fonctions de `paths.ts`) : la levée signale une erreur de programmation, et
 * les routes construisent leur réponse **avant** d'appeler l'API, pour qu'elle
 * ne puisse jamais tomber entre la rotation d'un jeton et la pose de son cookie.
 */
export function redirectWithinSite(path: string): NextResponse {
  const location = sitePath(path);

  if (location === null) {
    throw new Error(`redirection hors du site refusée : « ${path} »`);
  }

  return new NextResponse(null, { status: 307, headers: { location } });
}
