'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { logoutAction } from '../actions';
import { loginPath } from '../paths';

/**
 * Fermeture de session.
 *
 * ## Pourquoi un bouton et non un lien
 *
 * Une déconnexion écrit — elle révoque le jeton de rafraîchissement en base et
 * efface deux cookies. Un lien la rendrait déclenchable par un simple `GET`,
 * donc par une image insérée dans une page tierce : pas une fuite, mais un
 * moyen de couper la session de quelqu'un sans son accord. Le geste passe donc
 * par une action serveur, comme toute écriture de cette surface.
 */
interface LogoutButtonProps {
  readonly tenantSlug: string;
}

export function LogoutButton({ tenantSlug }: LogoutButtonProps) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const logout = async (): Promise<void> => {
    if (leaving) {
      return;
    }

    setLeaving(true);
    await logoutAction(tenantSlug);
    // `replace` et non `push` : la page de compte ne doit pas rester dans
    // l'historique du navigateur d'une session qu'on vient de fermer.
    router.replace(loginPath(tenantSlug));
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
