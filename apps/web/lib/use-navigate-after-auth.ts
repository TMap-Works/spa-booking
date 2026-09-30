'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';

/**
 * La navigation qui suit une authentification réussie — connexion, inscription,
 * activation d'invitation —, et l'attente qu'elle occupe.
 *
 * ## Pourquoi `isSubmitting` ne suffit pas
 *
 * `isSubmitting` de `react-hook-form` retombe dès que le gestionnaire de
 * soumission rend la main, c'est-à-dire dès que l'action serveur a répondu. La
 * navigation vers l'écran de destination, elle, ne fait que commencer : la page
 * est rendue côté serveur, et son rendu prend parfois plusieurs secondes. Entre
 * les deux, le bouton redevenait cliquable sur un écran qui allait disparaître —
 * l'utilisateur croyait l'envoi perdu, et pouvait le rejouer.
 *
 * ## Pourquoi une transition et non un drapeau posé une fois pour toutes
 *
 * `router.replace` et `router.refresh` appelés dans `startTransition` tiennent
 * `pending` à vrai jusqu'à ce que le rendu de destination soit commis. Un
 * drapeau jamais rabaissé ferait la même chose dans le cas nominal, mais
 * figerait le formulaire si la destination renvoyait sur ce même écran (cookie
 * refusé, session aussitôt expirée) : la transition, elle, se termine, et le
 * bouton redevient utilisable.
 */
export function useNavigateAfterAuth(): {
  readonly navigating: boolean;
  readonly navigate: (path: string) => void;
} {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();

  const navigate = useCallback(
    (path: string) => {
      startNavigation(() => {
        router.replace(path);
        // La destination est rendue côté serveur : sans ce rafraîchissement, la
        // navigation servirait le rendu fait **avant** que le cookie de session
        // n'existe : l'espace visé rebondirait aussitôt sur l'écran de
        // connexion, et le tunnel redemanderait des coordonnées que le cookie
        // de présence connaît (#1086).
        router.refresh();
      });
    },
    [router],
  );

  return { navigating, navigate };
}
