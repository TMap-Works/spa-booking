'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';

/**
 * La reprise d'un écran du back-office dont le chargement a échoué (#755).
 *
 * ## Pourquoi un bouton et non un lien vers la même URL
 *
 * `router.refresh()` redemande au serveur la charge utile de la route courante
 * et **remplace le rendu en place** : l'URL ne bouge pas, l'historique non plus,
 * et — c'est ce qui compte ici — l'état des composants clients déjà montés
 * survit. `docs/design/appointments/states.md`, « Règles générales », exige des
 * états d'erreur qu'ils conservent les saisies en cours ; un lien vers la même
 * adresse rejouerait une navigation complète et les jetterait. Sur l'encaissement,
 * cela reviendrait à vider le moyen de paiement choisi devant la cliente.
 *
 * ## Pourquoi la page entière et non l'appel qui a échoué
 *
 * L'appel fautif est parti d'un Server Component : il n'existe pas côté
 * navigateur, et il n'y a rien à rejouer qu'on puisse désigner. Ce qu'on peut
 * redemander, c'est le rendu qui le contient — et c'est exactement ce que le
 * ticket demande, « une action “Réessayer” qui relance la page ».
 *
 * ## L'attente est visible, et le bouton ne part qu'une fois
 *
 * `useTransition` suit le rafraîchissement de bout en bout : sans lui, un clic
 * sur une API encore éteinte ne produirait rien du tout à l'écran, et
 * l'opérateur cliquerait en boucle. `Button` se désactive dès que `loading` est
 * posé (web-frontend §3), si bien qu'un double clic n'envoie qu'une reprise.
 */
export function AdminRetryButton() {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <Button
      loading={retrying}
      loadingLabel="Nouvelle tentative en cours…"
      onClick={() => {
        startRetry(() => {
          router.refresh();
        });
      }}
      variant="neutral"
    >
      Réessayer
    </Button>
  );
}
