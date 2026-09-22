'use client';

import {
  APPOINTMENT_FEED_EVENT,
  appointmentFeedEventSchema,
  type AppointmentFeedEvent,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

/**
 * Le temps réel des rendez-vous, côté navigateur.
 *
 * ## Ce qu'il fait
 *
 * Il tient ouverte **une** connexion `EventSource` vers la route de flux de
 * l'espace courant (`/{salon}/admin/flux` ou `/{salon}/compte/flux`), et à
 * chaque changement annoncé :
 *
 * 1. il prévient les écrans qui se sont abonnés (`useAppointmentFeed`) — le
 *    planning du comptoir, qui tient son propre cache de périodes, et les
 *    bandeaux d'annonce ;
 * 2. il relit la page (`router.refresh()`) : les écrans rendus par le serveur —
 *    tableau de bord, « Mon planning », liste de la cliente — se remettent à jour
 *    sans perdre l'état de leurs composants clients.
 *
 * Il ne relit **rien** lui-même : le message dit qu'un rendez-vous a changé, les
 * écrans relisent par leurs routes habituelles. Voir
 * `packages/shared/src/schemas/appointment-feed.ts`.
 *
 * ## Ce qu'il fait quand la connexion tombe
 *
 * `EventSource` se reconnecte seul après une coupure réseau ou la fin normale du
 * flux (l'API le referme toutes les dix minutes). Il abandonne, en revanche, sur
 * un refus HTTP — session expirée (401), API injoignable (503) : la connexion est
 * alors reprise ici, à intervalle croissant.
 *
 * Toute reconnexion est suivie d'une relecture : un changement survenu pendant
 * la coupure n'a été annoncé à personne.
 *
 * ## Un onglet caché ne garde pas sa connexion
 *
 * Un flux ouvert occupe une connexion HTTP, et un navigateur n'en ouvre que six
 * par origine en HTTP/1.1 — six onglets du back-office et plus rien ne se
 * charge. L'onglet caché ferme donc la sienne, et la rouvre — avec une
 * relecture — quand on y revient : l'écran qu'on regarde est toujours à jour,
 * celui qu'on ne regarde pas n'a pas à l'être.
 */

/** Regroupe les changements rapprochés en une seule relecture de page. */
const REFRESH_DEBOUNCE_MS = 300;

/** Premier délai de reprise après un refus, puis doublé jusqu'au plafond. */
const RETRY_INITIAL_MS = 5_000;

const RETRY_MAX_MS = 60_000;

/**
 * Ce qu'un écran abonné reçoit : un changement annoncé, ou l'avis qu'il a pu en
 * manquer — la connexion vient d'être reprise après une coupure, et rien ne dit
 * ce qui est passé entre-temps.
 */
export type AppointmentFeedNotice =
  | { readonly kind: 'change'; readonly event: AppointmentFeedEvent }
  | { readonly kind: 'resync' };

type FeedListener = (notice: AppointmentFeedNotice) => void;

type Subscribe = (listener: FeedListener) => () => void;

const FeedContext = createContext<Subscribe | null>(null);

/**
 * Abonne un écran aux changements de rendez-vous de son périmètre.
 *
 * Hors d'un `AppointmentFeedProvider` — un test, une page sans session —, le
 * crochet ne fait rien : l'écran reste celui d'avant, rafraîchi à la main.
 */
export function useAppointmentFeed(listener: FeedListener): void {
  const subscribe = useContext(FeedContext);
  const latest = useRef(listener);

  useEffect(() => {
    latest.current = listener;
  });

  useEffect(() => {
    if (subscribe === null) {
      return undefined;
    }

    return subscribe((notice) => {
      latest.current(notice);
    });
  }, [subscribe]);
}

interface AppointmentFeedProviderProps {
  /** La route de flux de l'espace — voir `lib/appointment-feed-relay.ts`. */
  readonly feedPath: string;
  readonly children: ReactNode;
}

export function AppointmentFeedProvider({ feedPath, children }: AppointmentFeedProviderProps) {
  const router = useRouter();
  const listeners = useRef(new Set<FeedListener>());

  const subscribe = useCallback<Subscribe>((listener) => {
    listeners.current.add(listener);

    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    // Rendu serveur, ou navigateur trop ancien : l'écran se lit comme avant.
    if (typeof EventSource === 'undefined') {
      return undefined;
    }

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = RETRY_INITIAL_MS;
    // Une première ouverture n'a rien manqué : la page vient d'être rendue. Sauf
    // si l'onglet est né caché — ouvert en arrière-plan —, auquel cas la page a
    // pu vieillir avant qu'on la regarde.
    let caughtUp = document.visibilityState !== 'hidden';

    const refresh = (): void => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const notify = (notice: AppointmentFeedNotice): void => {
      for (const listener of listeners.current) {
        listener(notice);
      }
    };

    const disconnect = (): void => {
      clearTimeout(retryTimer);
      source?.close();
      source = null;
    };

    const connect = (): void => {
      disconnect();

      const opened = new EventSource(feedPath);
      source = opened;

      opened.addEventListener('open', () => {
        retryDelay = RETRY_INITIAL_MS;

        if (!caughtUp) {
          refresh();
          // Aucun changement précis à annoncer : les écrans à cache propre
          // relisent tout ce qu'ils montrent.
          notify({ kind: 'resync' });
        }

        caughtUp = true;
      });

      opened.addEventListener(APPOINTMENT_FEED_EVENT, (message: MessageEvent<string>) => {
        const event = parseFeedEvent(message.data);

        if (event === null) {
          return;
        }

        notify({ kind: 'change', event });
        refresh();
      });

      opened.addEventListener('error', () => {
        // Tant que l'état est `CONNECTING`, le navigateur reprend de lui-même :
        // il n'y a qu'à noter que quelque chose a pu passer entre-temps.
        caughtUp = false;

        if (opened.readyState !== EventSource.CLOSED) {
          return;
        }

        // Refus HTTP : le navigateur a abandonné, la reprise est à nous.
        opened.close();
        if (source === opened) {
          source = null;
        }
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      });
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        disconnect();
        caughtUp = false;
        return;
      }

      if (source === null) {
        retryDelay = RETRY_INITIAL_MS;
        connect();
      }
    };

    if (document.visibilityState !== 'hidden') {
      connect();
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(refreshTimer);
      disconnect();
    };
  }, [feedPath, router]);

  return <FeedContext.Provider value={subscribe}>{children}</FeedContext.Provider>;
}

/** Le message du flux, validé contre le contrat — ou rien. */
function parseFeedEvent(data: string): AppointmentFeedEvent | null {
  let payload: unknown;

  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }

  const parsed = appointmentFeedEventSchema.safeParse(payload);

  return parsed.success ? parsed.data : null;
}
