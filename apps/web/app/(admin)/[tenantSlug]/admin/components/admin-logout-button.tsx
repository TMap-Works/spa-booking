'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { adminLogoutAction } from '../actions';
import { adminLoginPath } from '../paths';

/**
 * Fermeture de la session du back-office (#48, cinquième critère).
 *
 * ## Pourquoi un bouton et non un lien
 *
 * Une déconnexion **écrit** — elle révoque le jeton de rafraîchissement en base
 * et efface deux cookies. Un lien la rendrait déclenchable par un simple `GET`,
 * donc par une image insérée dans une page tierce : pas une fuite, mais un moyen
 * de couper la session de quelqu'un sans son accord. Le geste passe donc par une
 * action serveur, comme toute écriture de cette surface.
 *
 * ## Pourquoi `replace` et non `push`
 *
 * L'écran que l'on vient de quitter ne doit pas rester dans l'historique d'une
 * session fermée : sur un poste de comptoir partagé, un « précédent » suffirait
 * à réafficher le planning depuis le cache du routeur. Le `refresh()` qui suit
 * vide ce cache.
 */
interface AdminLogoutButtonProps {
  readonly tenantSlug: string;
}

export function AdminLogoutButton({ tenantSlug }: AdminLogoutButtonProps) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const logout = async (): Promise<void> => {
    // `Button` se désactive déjà pendant `loading` ; cette garde couvre le
    // premier clic, avant que l'état ne soit peint.
    if (leaving) {
      return;
    }

    setLeaving(true);

    try {
      await adminLogoutAction(tenantSlug);
    } catch {
      // `adminLogoutAction` avale déjà l'échec de l'API : ce qui reste ici est
      // l'échec de l'appel lui-même — serveur Next redémarré, réseau coupé. Le
      // bouton doit alors redevenir cliquable. Le laisser désactivé sur
      // « Déconnexion en cours… » interdirait de retenter, session ouverte, sur
      // le poste de comptoir partagé qui est précisément le cas à couvrir.
      setLeaving(false);
      return;
    }

    router.replace(adminLoginPath(tenantSlug));
    router.refresh();
  };

  return (
    <Button
      variant="quiet"
      loading={leaving}
      loadingLabel="Déconnexion en cours…"
      onClick={() => void logout()}
    >
      Se déconnecter
    </Button>
  );
}
