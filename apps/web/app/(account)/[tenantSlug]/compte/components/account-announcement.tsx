'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Notification, type NotificationTone } from '@/components/ui/notification';

/**
 * L'annonce d'un geste mené à son terme dans l'espace client — #746.
 *
 * ## Ce qui manquait
 *
 * « Déplacer au mercredi 16 septembre 2026 à 14:55 » et « Confirmer
 * l'annulation » ramenaient l'une et l'autre à la liste **sans un mot**. La carte
 * quittait « Rendez-vous à venir » et réapparaissait sous « Historique », souvent
 * hors de vue à 360 px : rien ne disait que l'opération avait abouti, là où le
 * tunnel, lui, confirme sa réservation par un bandeau
 * (`(booking)/…/steps/confirmation-step.tsx`).
 *
 * WCAG 2.2 AA, critère **4.1.3 Messages d'état** : un changement d'état obtenu
 * sans changement de contexte doit être annoncé par un message
 * *programmatiquement déterminable*. `docs/design/appointments/states.md`
 * § « Règles générales » pose déjà la même exigence pour les états vides et
 * d'erreur — « annoncée via une région `aria-live` ». Le succès ne s'en exempte
 * pas.
 *
 * ## La région est **permanente**, et c'est tout l'enjeu
 *
 * Une région `aria-live` insérée **avec** son message n'est annoncée par aucun
 * lecteur d'écran de façon fiable : l'annonce se déclenche sur une *mutation
 * observée* d'une région déjà suivie. Rendre `<Notification>` au retour sur la
 * liste — ce qui aurait suffi visuellement — n'aurait donc rien annoncé du tout.
 *
 * D'où le découpage : la région est posée par le **layout** de l'espace client
 * (`layout.tsx`), c'est-à-dire avant tout écran et avant tout geste, et reste
 * vide. Les gestes n'y écrivent qu'après. Le nœud du DOM est le même du premier
 * rendu à l'annonce — c'est ce que la suite `account-success-announcement`
 * vérifie par identité de nœud, et non par présence de texte.
 *
 * Le layout est aussi ce qui fait **survivre l'annonce au report** : l'écran de
 * choix de créneau (`/{slug}/compte/rendez-vous/{id}/report`) et la liste
 * partagent ce layout, que l'App Router conserve d'une navigation à l'autre.
 * L'état de ce fournisseur traverse donc le `router.replace` du report, là où un
 * état porté par la page aurait été démonté avec elle. Rien ne transite par
 * l'adresse : un `?annonce=…` aurait rejoué le succès à chaque F5, et se serait
 * tu sur une seconde annulation, faute de changer de valeur.
 *
 * ## L'annonce se lit sur la liste, pas sur l'écran qu'on quitte
 *
 * La demande porte le chemin où elle doit être lue. Le report annonce donc avant
 * de naviguer, mais rien ne s'affiche tant que la liste n'est pas là : un bandeau
 * de succès posé une demi-seconde au-dessus du panneau « Reporter mon
 * rendez-vous » se lirait comme un rendez-vous déplacé deux fois.
 *
 * Et l'annonce ne **suit** pas la visiteuse : une fois lue, un détour par
 * `/{slug}/compte/coordonnees` l'efface. Sans cela, « Votre rendez-vous est
 * annulé » se rallumerait à chaque retour sur la liste, longtemps après le geste.
 */

/** Le geste dont on annonce l'aboutissement. */
export type AccountAnnouncementKind = 'appointment-cancelled' | 'appointment-rescheduled';

export interface AccountAnnouncementRequest {
  readonly kind: AccountAnnouncementKind;
  /**
   * L'instant concerné, **déjà mis en forme** dans le fuseau de l'établissement.
   *
   * Mis en forme par l'appelant et non ici : la carte et l'écran de report ont
   * l'un et l'autre le fuseau du salon sous la main, et la phrase doit nommer la
   * même heure que le bouton qu'on vient de cliquer. La région, elle, n'a aucune
   * raison de connaître un fuseau.
   *
   * C'est aussi ce qui distingue deux annonces successives : deux annulations
   * d'affilée portent des heures différentes, donc un texte différent, donc une
   * mutation que la région annonce. Un libellé fixe serait resté muet la seconde
   * fois.
   */
  readonly when: string;
  /** L'écran où l'annonce se lit — la liste, jamais celui d'où part le geste. */
  readonly path: string;
}

interface AnnouncementWording {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: (when: string) => string;
}

/**
 * Les mots, tenus ici plutôt que chez les appelants — deux écrans qui annoncent
 * la même chose doivent l'annoncer de la même façon.
 *
 * Les tons reprennent ceux du tunnel : une réservation obtenue est un `success`,
 * une annulation obtenue un `info` (`confirmation-step.tsx` — « Votre rendez-vous
 * est annulé »). Annuler réussit sans être une bonne nouvelle.
 *
 * Chaque phrase dit **où la ligne est passée**. C'est le constat de l'audit :
 * à 360 px la carte réapparaît sous « Historique », hors de vue — le message
 * qui se contenterait de dire « c'est fait » laisserait chercher.
 */
const WORDING: Record<AccountAnnouncementKind, AnnouncementWording> = {
  'appointment-cancelled': {
    tone: 'info',
    title: 'Votre rendez-vous est annulé',
    body: (when) =>
      `Celui du ${when} ne figure plus à l’agenda du salon : vous le retrouvez sous « Historique », plus bas.`,
  },
  'appointment-rescheduled': {
    tone: 'success',
    title: 'Votre rendez-vous est déplacé',
    body: (when) => `Il est désormais fixé au ${when}, sous « Rendez-vous à venir ».`,
  },
};

type Announce = (request: AccountAnnouncementRequest) => void;

/**
 * Hors fournisseur, annoncer ne fait rien — et ne casse rien.
 *
 * Une carte montée seule — ce que font les suites unitaires, et ce que ferait un
 * écran futur posé hors du layout — ne doit pas se solder par une exception :
 * l'annonce est un service de l'écran, pas une dépendance de la ligne.
 */
const SILENCE: Announce = () => undefined;

const AnnounceContext = createContext<Announce>(SILENCE);

/**
 * Deux contextes et non un seul objet : les cartes n'ont aucune raison d'être
 * rendues à nouveau parce qu'un bandeau vient d'apparaître au-dessus d'elles, et
 * `announce` ne change jamais.
 */
const MessageContext = createContext<AccountAnnouncementRequest | null>(null);

/** Le geste par lequel un écran de l'espace client annonce ce qu'il vient d'obtenir. */
export function useAccountAnnouncement(): Announce {
  return useContext(AnnounceContext);
}

interface AccountAnnouncementProviderProps {
  readonly children: ReactNode;
}

/**
 * Le porteur de l'annonce, posé par le layout — donc au-dessus de la liste
 * **et** de l'écran de report.
 *
 * Il n'ajoute aucun nœud au DOM : la mise en page reste exactement celle du
 * layout, et `children` traverse la frontière serveur/client sans encombre.
 */
export function AccountAnnouncementProvider({ children }: AccountAnnouncementProviderProps) {
  const path = usePathname();
  const [request, setRequest] = useState<AccountAnnouncementRequest | null>(null);
  /** L'annonce a-t-elle déjà atteint l'écran où elle devait se lire ? */
  const delivered = useRef(false);

  const announce = useCallback<Announce>((next) => {
    delivered.current = false;
    setRequest(next);
  }, []);

  const visible = request !== null && request.path === path;

  useEffect(() => {
    if (request === null) {
      return;
    }

    if (visible) {
      delivered.current = true;
      return;
    }

    // Lue puis quittée : l'annonce s'efface. Tant qu'elle n'a **pas** été lue,
    // elle attend son écran — c'est le cas du report, qui annonce depuis la page
    // qu'il s'apprête à quitter.
    if (delivered.current) {
      setRequest(null);
    }
  }, [request, visible]);

  return (
    <AnnounceContext.Provider value={announce}>
      <MessageContext.Provider value={visible ? request : null}>{children}</MessageContext.Provider>
    </AnnounceContext.Provider>
  );
}

/**
 * La région `aria-live` de l'espace client — vide la plupart du temps, et
 * **toujours montée**.
 *
 * Deux détails qui ne sont pas des détails :
 *
 * - `spa-visually-hidden` tant qu'il n'y a rien à dire. La classe sort l'élément
 *   du flux (`position: absolute`, `base.css`), si bien qu'une région vide ne
 *   consomme pas une gouttière de `.spa-account__main` — 32 px au-dessus du menu
 *   du compte, sur tous les écrans, pour rien. Elle reste dans le DOM et dans
 *   l'arbre d'accessibilité : c'est la classe qui change, jamais le nœud, et
 *   React ne le remplace donc pas ;
 * - `aria-atomic="true"` pour que le titre et la phrase soient lus d'un bloc. Un
 *   titre lu seul — « Votre rendez-vous est déplacé » — perdrait justement la
 *   nouvelle heure.
 *
 * Le bandeau visible est celui du design system, sans un style de plus : c'est le
 * composant par lequel le tunnel confirme sa réservation. Son `role="status"`
 * fait double emploi avec la région qui le porte, mais il vient du design system
 * et ne se modifie pas d'ici — deux régions imbriquées annoncent une fois, là où
 * un bandeau posé **à côté** d'une annonce invisible aurait fait lire la phrase
 * deux fois.
 */
export function AccountAnnouncementRegion() {
  const message = useContext(MessageContext);
  const wording = message === null ? null : WORDING[message.kind];

  return (
    <div
      className={message === null ? 'spa-visually-hidden' : undefined}
      aria-live="polite"
      aria-atomic="true"
    >
      {message === null || wording === null ? null : (
        <Notification tone={wording.tone} title={wording.title}>
          <p>{wording.body(message.when)}</p>
        </Notification>
      )}
    </div>
  );
}
