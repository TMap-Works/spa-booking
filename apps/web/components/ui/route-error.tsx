'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from './button';
import { Notification } from './notification';

interface RouteErrorProps {
  /** Ce qui n'a pas pu s'afficher, du point de vue de qui regarde. */
  readonly title: string;
  /** Phrase complète, invitation comprise — rien ne lui est concaténé. */
  readonly message: string;
  /** Le `reset` que Next passe à `error.tsx`. */
  readonly reset: () => void;
}

/**
 * Le contenu des `error.tsx` : un encart et une reprise (#830).
 *
 * ## Pourquoi ces écrans en avaient besoin
 *
 * Les pages savent rendre leur propre encart quand **l'API** échoue
 * (`admin/guard.tsx`, `booking-error-notice.tsx`). Ce qui leur échappe — une
 * panne du rendu lui-même — remontait jusqu'à l'écran d'erreur générique de
 * Next, sans navigation ni reprise. Une frontière par espace le rattrape sous le
 * layout de cet espace : le rail, la barre du compte et le bandeau du tunnel
 * restent en place, et l'état d'erreur laisse une issue
 * (`docs/design/appointments/states.md`, « Règles générales »).
 *
 * ## Pourquoi `router.refresh()` avant `reset()`
 *
 * `reset()` seul rejoue le rendu **client** de la frontière. Or la panne vient le
 * plus souvent d'un Server Component, dont le rendu en échec est déjà dans le
 * cache du routeur : il reviendrait tel quel. `router.refresh()` redemande la
 * route au serveur, et `reset()` démonte l'encart pour la laisser s'afficher —
 * les deux dans une même transition, pour que l'encart reste en place tant que
 * la nouvelle réponse n'est pas arrivée.
 *
 * ## Le message affiché n'est jamais celui de l'erreur
 *
 * En production, Next remplace le message d'une erreur serveur par un texte
 * générique, et celui d'une erreur client peut nommer un détail interne. Chaque
 * `error.tsx` passe donc sa propre phrase, comme le reste de `apps/web` le fait
 * de ses messages (`booking-error-notice.tsx`).
 *
 * Le bouton se désactive dès le premier clic (`Button`, web-frontend §3) : un
 * double clic ne relance qu'une reprise.
 */
export function RouteError({ title, message, reset }: RouteErrorProps) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  return (
    <Notification tone="danger" title={title}>
      <p>{message}</p>
      <Button
        loading={retrying}
        loadingLabel="Nouvelle tentative en cours…"
        onClick={() => {
          startRetry(() => {
            router.refresh();
            reset();
          });
        }}
        variant="neutral"
      >
        Réessayer
      </Button>
    </Notification>
  );
}
