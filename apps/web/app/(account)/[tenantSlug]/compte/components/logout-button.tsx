'use client';

import { useTranslations } from 'next-intl';
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
 *
 * ## Pourquoi les mots viennent de `shell.account` — #1124
 *
 * Le bouton n'appartient à aucun écran de l'espace client : le gabarit le pose
 * dans le menu du compte, qui coiffe les sept écrans. Ses libellés rejoignent
 * donc ceux de la coquille — le titre de l'espace et la salutation —, là où le
 * gabarit lit déjà les siens, plutôt que de rester au catalogue des écrans.
 */
interface LogoutButtonProps {
  readonly tenantSlug: string;
}

export function LogoutButton({ tenantSlug }: LogoutButtonProps) {
  const t = useTranslations('shell.account');
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
      loadingLabel={t('signingOut')}
      onClick={() => void logout()}
    >
      {t('signOut')}
    </Button>
  );
}
