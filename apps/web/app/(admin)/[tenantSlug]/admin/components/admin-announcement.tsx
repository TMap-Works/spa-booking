'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
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
 * L'annonce d'un geste mené à son terme dans le back-office — #1037.
 *
 * ## Ce qui manquait
 *
 * « Créer la prestation » faisait un `router.push` nu vers la fiche
 * (`service-form.tsx`) : l'écran basculait **sans un mot**, et rien ne
 * distinguait une prestation qu'on venait de créer d'une prestation qu'on venait
 * d'ouvrir depuis le catalogue. Le même formulaire annonçait pourtant
 * « Prestation enregistrée » quand on enregistrait une prestation **existante** —
 * deux issues du même geste, deux traitements.
 *
 * WCAG 2.2 AA, critère **4.1.3 Messages d'état** : un changement d'état obtenu
 * sans changement de contexte doit être annoncé par un message
 * *programmatiquement déterminable*. `.claude/skills/web-frontend/SKILL.md` §6
 * pose la même exigence pour les états d'un écran, succès compris.
 *
 * ## Pourquoi un fournisseur, et pas un bandeau posé sur la fiche
 *
 * Parce que le geste **change d'écran**. Un état porté par `/catalogue/nouveau`
 * serait démonté avec lui, et un état porté par `/catalogue/{id}` ne saurait pas
 * d'où l'on vient. Le layout du back-office, lui, est conservé par l'App Router
 * d'une navigation à l'autre du segment `admin` : l'état posé ici traverse le
 * `router.push`, là où rien d'autre ne le traverse.
 *
 * Rien ne transite par l'adresse : un `?annonce=…` aurait rejoué le succès à
 * chaque F5 — c'est l'écartement explicite de l'issue, et déjà celui du
 * précédent de l'espace client (`(account)/…/components/account-announcement.tsx`,
 * #746) dont ce fichier reprend le geste sans rien lui ajouter.
 *
 * ## La région est **permanente**, et c'est tout l'enjeu
 *
 * Une région `aria-live` insérée **avec** son message n'est annoncée par aucun
 * lecteur d'écran de façon fiable : l'annonce se déclenche sur une *mutation
 * observée* d'une région déjà suivie. Rendre `<Notification>` à l'arrivée sur la
 * fiche — ce qui aurait suffi visuellement — n'aurait donc rien annoncé du tout.
 *
 * D'où le découpage : la région est posée par le **layout** du back-office
 * (`layout.tsx`), c'est-à-dire avant tout écran et avant tout geste, et reste
 * vide. Les gestes n'y écrivent qu'après. Le nœud du DOM est le même du premier
 * rendu à l'annonce — c'est ce que la suite `admin-success-announcement` vérifie
 * par identité de nœud, et non par présence de texte.
 *
 * ## L'annonce se lit sur l'écran d'arrivée, pas sur celui qu'on quitte
 *
 * La demande porte le chemin où elle doit être lue. Le formulaire annonce donc
 * avant de naviguer, mais rien ne s'affiche tant que la fiche n'est pas là : un
 * bandeau de succès posé une demi-seconde au-dessus du formulaire de création se
 * lirait comme une prestation créée deux fois.
 *
 * Et l'annonce ne **suit** pas la gérante : une fois lue, un détour par le
 * planning l'efface. Sans cela, « Prestation « Gommage » créée » se rallumerait à
 * chaque retour sur la fiche, longtemps après le geste.
 */

/**
 * Ce qu'on annonce : un geste mené à son terme, ou — depuis le planning temps
 * réel — un rendez-vous arrivé ou annulé d'ailleurs, que le flux vient de
 * signaler (`admin-live-announcements.tsx`).
 */
export type AdminAnnouncementKind = 'service-created' | 'appointment-booked' | 'appointment-cancelled';

export interface AdminAnnouncementRequest {
  readonly kind: AdminAnnouncementKind;
  /**
   * Le nom de l'objet créé, tel que l'API vient de l'enregistrer.
   *
   * Nommer l'objet est la moitié du ticket : « c'est fait » ne dit pas *quoi*,
   * et l'écran d'arrivée porte déjà le nom en titre sans rien apprendre de ce
   * qui vient de se passer.
   *
   * C'est aussi ce qui distingue deux annonces successives : deux créations
   * d'affilée portent des noms différents, donc un texte différent, donc une
   * mutation que la région annonce.
   */
  readonly subject: string;
  /** L'écran où l'annonce se lit — celui d'arrivée, jamais celui d'où part le geste. */
  readonly path: string;
  /**
   * Où mène le lien du bandeau, quand il dépend de ce qui est annoncé — le jour
   * du planning où tombe un rendez-vous. À défaut, l'ancre de la formulation.
   */
  readonly href?: string;
}

/**
 * Le **ton** de chaque annonce — l'une des deux seules parts de l'annonce qui ne
 * se traduisent pas (#1192).
 *
 * Les **phrases**, elles, vivent dans le catalogue : `announcement.<motif>` du
 * namespace `admin-catalog`, une entrée `title`, `body` et `next` par motif.
 * C'étaient jusqu'ici trois littéraux français, si bien que « Prestation
 * « Massage suédois » créée » s'affichait sur la fiche anglaise à laquelle la
 * création venait de mener. Un seul namespace pour les trois motifs, et non un
 * par écran d'origine : la région est **un** composant, et lui faire lire deux
 * catalogues pour une seule table de mots aurait coûté un crochet de plus sans
 * rien isoler.
 *
 * Ce que les phrases disent n'a pas bougé. Celle de la création dit **ce qu'il
 * reste à faire** pour que la prestation existe vraiment côté cliente — le
 * constat du panneau des praticiens, mot pour mot : « tant qu'aucun praticien ne
 * pratique cette prestation, le moteur de disponibilité ne proposera aucun
 * créneau pour elle » (`service-staff-panel.tsx`). Le **sujet** inséré, lui,
 * n'est jamais traduit : le nom d'une prestation est la saisie du salon, et le
 * jour et l'heure d'un rendez-vous sont déjà mis en forme par l'appelant, dans le
 * fuseau du salon et la langue de la requête.
 *
 * Le ton de la création reprend le bandeau d'édition du même formulaire,
 * « Prestation enregistrée » : une création obtenue est un `success`. Les deux
 * annonces du temps réel, elles, disent ce qui arrive au planning **sans** que
 * l'équipe l'ait fait : `info` et `warning` plutôt que `success`, ce n'est pas
 * l'issue d'un de ses gestes. C'est le même partage que dans l'espace client
 * (`account-announcement.tsx`), dont ce fichier reprend le geste.
 */
const TONES: Record<AdminAnnouncementKind, NotificationTone> = {
  'service-created': 'success',
  'appointment-booked': 'info',
  'appointment-cancelled': 'warning',
};

/**
 * L'ancre du geste suivant, quand l'annonce n'apporte pas d'adresse à elle.
 *
 * Une ancre et non un chemin : l'annonce se lit sur l'écran qui porte déjà la
 * section visée, et l'y amener ne coûte aucun aller-retour. Le lien du design
 * system reste un `<Link>` — c'est lui qui gère le défilement et le focus.
 *
 * Les deux annonces du temps réel n'y figurent pas : leur geste suivant est le
 * jour du planning où tombe le rendez-vous, que l'appelant calcule et passe en
 * `href` (`admin-live-announcements.tsx`).
 */
const NEXT_HASH: Partial<Record<AdminAnnouncementKind, string>> = {
  'service-created': '#prestation-praticiens',
};

type Announce = (request: AdminAnnouncementRequest) => void;

/**
 * Hors fournisseur, annoncer ne fait rien — et ne casse rien.
 *
 * Un formulaire monté seul — ce que fait `service-form.test.tsx`, et ce que
 * ferait un écran futur posé hors du layout — ne doit pas se solder par une
 * exception : l'annonce est un service de l'écran, pas une dépendance du
 * formulaire.
 */
const SILENCE: Announce = () => undefined;

const AnnounceContext = createContext<Announce>(SILENCE);

/**
 * Deux contextes et non un seul objet : les écrans n'ont aucune raison d'être
 * rendus à nouveau parce qu'un bandeau vient d'apparaître au-dessus d'eux, et
 * `announce` ne change jamais.
 */
const MessageContext = createContext<AdminAnnouncementRequest | null>(null);

/** Le geste par lequel un écran du back-office annonce ce qu'il vient d'obtenir. */
export function useAdminAnnouncement(): Announce {
  return useContext(AnnounceContext);
}

interface AdminAnnouncementProviderProps {
  readonly children: ReactNode;
}

/**
 * Le porteur de l'annonce, posé par le layout — donc au-dessus de l'écran de
 * création **et** de la fiche.
 *
 * Il n'ajoute aucun nœud au DOM : la mise en page reste exactement celle du
 * layout — la grille `.spa-admin` et son rail n'ont pas à composer avec un
 * conteneur de plus —, et `children` traverse la frontière serveur/client sans
 * encombre.
 */
export function AdminAnnouncementProvider({ children }: AdminAnnouncementProviderProps) {
  const path = usePathname();
  const [request, setRequest] = useState<AdminAnnouncementRequest | null>(null);
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
    // elle attend son écran — c'est le cas de la création, qui annonce depuis le
    // formulaire qu'elle s'apprête à quitter.
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
 * La région `aria-live` du back-office — vide la plupart du temps, et
 * **toujours montée**.
 *
 * Deux détails qui ne sont pas des détails :
 *
 * - `spa-visually-hidden` tant qu'il n'y a rien à dire. La classe sort l'élément
 *   du flux (`position: absolute`, `styles/base.css`), si bien qu'une région
 *   vide ne consomme pas une gouttière de `.spa-admin__content` au-dessus du
 *   titre de chaque écran du back-office, sur les sept écrans, pour rien. Elle
 *   reste dans le DOM et dans l'arbre d'accessibilité : c'est la classe qui
 *   change, jamais le nœud, et React ne le remplace donc pas ;
 * - `aria-atomic="true"` pour que le titre et la phrase soient lus d'un bloc. Un
 *   titre lu seul — « Prestation « Gommage » créée » — perdrait justement ce
 *   qu'il reste à faire.
 *
 * Le bandeau visible est celui du design system, sans un style de plus : c'est
 * le composant par lequel le même formulaire confirme déjà un enregistrement.
 * Son `role="status"` fait double emploi avec la région qui le porte, mais il
 * vient du design system et ne se modifie pas d'ici — deux régions imbriquées
 * annoncent une fois, là où un bandeau posé **à côté** d'une annonce invisible
 * aurait fait lire la phrase deux fois.
 */
export function AdminAnnouncementRegion() {
  const t = useTranslations('admin-catalog');
  const message = useContext(MessageContext);
  const href = message === null ? undefined : (message.href ?? NEXT_HASH[message.kind]);

  return (
    <div
      className={message === null ? 'spa-visually-hidden' : undefined}
      aria-live="polite"
      aria-atomic="true"
    >
      {message === null ? null : (
        <Notification
          tone={TONES[message.kind]}
          /* Le motif compose la clé, comme dans l'espace client
             (`account-announcement.tsx`) : les entrées du catalogue portent
             exactement les noms des motifs, si bien qu'il n'y a ici aucune table
             de correspondance à tenir à jour. La conversion de type est le prix
             de cette clé calculée — `tsc` ne sait pas qu'un motif compose une
             clé, et les trois clés ont la même forme. */
          title={t(`announcement.${message.kind}.title` as 'announcement.service-created.title', {
            subject: message.subject,
          })}
        >
          <p>
            {t(`announcement.${message.kind}.body` as 'announcement.service-created.body')}{' '}
            {href === undefined ? null : (
              <Link href={href}>
                {t(`announcement.${message.kind}.next` as 'announcement.service-created.next')}
              </Link>
            )}
          </p>
        </Notification>
      )}
    </div>
  );
}
