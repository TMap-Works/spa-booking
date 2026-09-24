'use client';

import type { BookedAppointment, PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BookingStepSkeleton } from '@/components/booking/step-skeleton';
import { BookingSummaryAside, type BookingSummary } from '@/components/booking/summary-bar';
import { BookingTunnelHeader } from '@/components/booking/tunnel-header';
import { BookingProgress } from '@/components/booking/tunnel-progress';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import type { AccountPresence } from '@/lib/account-presence';
import {
  bookingSearch,
  contactAccountKey,
  draftForAccount,
  draftFromSearch,
  emptyBookingDraft,
  readBookingDraft,
  reachableStep,
  writeBookingDraft,
  type BookingDraft,
  type BookingStep,
  type ContactDraft,
} from '@/lib/booking/draft';
import { formatDateTimeInTimeZone, timeZoneMention, type DisplayLocale } from '@/lib/format';

import { AccountGateStep } from './steps/account-gate-step';
import { ConfirmationStep } from './steps/confirmation-step';
import { ContactStep } from './steps/contact-step';
import { ServiceStep } from './steps/service-step';
import { SlotStep } from './steps/slot-step';
import { SummaryStep } from './steps/summary-step';

/**
 * L'étape que « ← Retour » rouvre, ou `null` quand il n'y a rien derrière.
 *
 * La première étape n'a pas de précédente, et la confirmation est terminale :
 * le rendez-vous est pris, et revenir au récapitulatif y réserverait une
 * seconde fois (#732). Le bouton n'est alors pas rendu du tout.
 */
const PREVIOUS_STEP: Readonly<Record<BookingStep, BookingStep | null>> = {
  prestation: null,
  creneau: 'prestation',
  coordonnees: 'creneau',
  recapitulatif: 'coordonnees',
  confirmation: null,
};

interface Notice {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: string;
}

interface BookingTunnelProps {
  readonly tenant: PublicTenant;
  readonly services: readonly PublicService[];
  /**
   * La vitrine du salon — où mène « ✕ Quitter » (#1047).
   *
   * Le chemin arrive en propriété plutôt que d'être recomposé ici : c'est la
   * page qui tient l'arborescence des routes (`salon-data.ts`), comme pour
   * l'en-tête de la vitrine.
   */
  readonly exitHref: string;
  /**
   * La cliente connectée chez ce salon, ou `null` (#1050).
   *
   * Lue **côté serveur** par la page, dans le cookie de présence posé par #1045
   * : un Client Component ne peut pas la lire lui-même — le cookie est
   * `httpOnly`, et c'est très bien ainsi. Elle traverse donc l'arbre comme une
   * propriété, jamais par l'URL ni par `sessionStorage`.
   *
   * Depuis le 2026-09-22, **réserver exige un compte** : sans elle, l'étape
   * « Coordonnées » cède la place à `AccountGateStep`, et le récapitulatif
   * n'est pas atteignable. Elle ne décide pourtant de rien côté serveur — le
   * cookie sert à afficher —, et c'est l'action de réservation qui a le dernier
   * mot (`actions.ts`).
   */
  readonly presence: AccountPresence | null;
  /**
   * L'écran de connexion du salon, avec le tunnel en retour (#1087).
   *
   * Composé par la page comme `exitHref`, et pour la même raison : c'est elle
   * qui tient l'arborescence des routes (`salon-data.ts`).
   */
  readonly loginHref: string;
  /** L'écran d'inscription du salon, avec le tunnel en retour — même raison. */
  readonly registerHref: string;
  /**
   * L'état de départ, lu **dans l'adresse par le serveur** (#1055).
   *
   * Sans lui, le premier rendu du tunnel partait d'un brouillon vierge : la
   * progression annonçait « Étape 1 sur 4 · Quelle prestation ? » quelle que
   * soit l'étape demandée, au-dessus d'une carte grise sans forme, et basculait
   * sur l'étape reprise à l'hydratation (audit `d20260918-1`). `etape=` et
   * `prestation=` sont pourtant dans l'URL, et l'URL, le serveur l'a : c'est
   * `initial-draft.ts` qui la résout, contre le catalogue de cette page.
   *
   * Ce qui ne voyage pas dans l'adresse — coordonnées, rendez-vous obtenu —
   * reste absent ici et n'arrive qu'à la relecture de `sessionStorage`, dans
   * l'effet d'hydratation ci-dessous. C'est le même partage des rôles que
   * partout ailleurs (`lib/booking/draft.ts`), vu depuis le serveur.
   */
  readonly initialDraft: BookingDraft;
}

/**
 * Quelque chose a-t-il été choisi ou tapé ?
 *
 * C'est ce qui décide si « Quitter » demande confirmation. Le brouillon vit
 * dans `sessionStorage` et meurt avec l'onglet : sortir d'un tunnel où l'on a
 * déjà tapé son nom n'est pas le même geste que sortir d'un tunnel qu'on vient
 * d'ouvrir, et seul le second se fait sans rien demander.
 *
 * Le consentement n'y figure pas : cocher une case n'est pas une saisie qu'on
 * regretterait de perdre, et elle ne peut de toute façon l'être qu'à une étape
 * où le reste du formulaire est déjà rempli.
 */
function hasDraftInput(draft: BookingDraft): boolean {
  const { firstName, lastName, email, phone, clientNote } = draft.contact;

  return (
    draft.serviceId !== null ||
    draft.startsAt !== null ||
    [firstName, lastName, email, phone, clientNote].some((value) => value.trim() !== '')
  );
}

/**
 * L'effet qui écrit l'adresse — de disposition dans le navigateur, passif au
 * rendu serveur.
 *
 * `useLayoutEffect` ne s'exécute pas au rendu serveur et React le dit sur la
 * console, ce qu'un parcours critique qui vérifie la console ne tolère pas.
 * Cette bascule est l'idiome habituel : le serveur n'a de toute façon ni
 * historique ni adresse à corriger, et le choix est figé au chargement du
 * module — jamais au fil des rendus, ce qui changerait l'ordre des hooks.
 *
 * Pourquoi un effet de disposition est indispensable ici : voir l'effet
 * lui-même, plus bas.
 */
const useHistoryEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Le créneau retenu ne tombe pas au geste retour (#947).
 *
 * ## Ce qui se passait
 *
 * L'entrée d'historique d'une étape est écrite **en y arrivant**, avant que le
 * choix qu'on y fait n'existe : celle de l'étape « Créneau » ne porte donc pas
 * de `creneau`, qui n'est retenu qu'au clic qui la quitte. Le geste retour
 * depuis « Coordonnées » rendait ainsi une étape amnésique — barre de résumé
 * sans date, calendrier rouvert au premier jour libre, alors que la cliente
 * venait de choisir son horaire. `BM-TUNNEL-08`
 * (`docs/design/benchmark/parcours-client.md`) le dit à l'endroit : « la cliente
 * retrouve la même étape avec les mêmes choix ».
 *
 * ## Pourquoi ici, et non en réécrivant l'entrée qu'on quitte
 *
 * Parce qu'une entrée ne se corrige pas dans le même rendu qu'un `pushState` :
 * deux écritures d'adresse d'affilée écartent l'action serveur qui suit, et
 * l'étape reste en squelette (voir l'effet d'adresse, « Une écriture par
 * rendu »). Le rattrapage se fait donc à l'arrivée plutôt qu'au départ, et ne
 * coûte aucune écriture : l'effet d'adresse remet de lui-même le `creneau` dans
 * l'entrée retrouvée, **sur place**, puisqu'on vient de l'historique.
 *
 * ## Pourquoi c'est légitime alors que « l'URL fait foi »
 *
 * La règle de `draftFromSearch` vise le **lien partagé** : ce qu'il ne dit pas
 * n'a pas été choisi. Or un `popstate` ne peut pas venir d'un lien — il ramène
 * toujours à une entrée que ce tunnel a écrite lui-même, dans cet onglet, et
 * qui est par construction en retard sur ce qui a été choisi après elle. Un
 * lien ouvert dans un onglet neuf passe, lui, par l'hydratation, qui ne touche
 * pas à cette fonction.
 *
 * Le repli ne vaut que si l'entrée retrouvée décrit **la même question** : même
 * prestation, même praticien. Ces deux-là changés, le créneau venait d'un autre
 * agenda et n'a plus rien à dire — c'est déjà ce que `chooseService` et
 * `chooseStaff` font en le faisant tomber.
 */
function keepChosenSlot(current: BookingDraft, merged: BookingDraft): BookingDraft {
  const rewound =
    merged.startsAt === null &&
    current.startsAt !== null &&
    merged.serviceId !== null &&
    merged.serviceId === current.serviceId &&
    merged.staffId === current.staffId;

  return rewound ? { ...merged, startsAt: current.startsAt } : merged;
}

/**
 * Le rendez-vous obtenu ne tombe pas non plus au geste retour (#732, #1152).
 *
 * `draftFromSearch` fait tomber le rendez-vous dès que l'adresse ne décrit plus
 * le parcours qui l'a produit — c'est ce qui empêche le lien « Choisir » de la
 * vitrine de rouvrir la confirmation précédente (#1152). Mais une entrée
 * d'historique n'est pas un lien : elle a été écrite par ce tunnel-ci, dans cet
 * onglet, **avant** la réservation, et elle est donc par construction en retard
 * sur elle — exactement pour la même raison que le créneau ci-dessus.
 *
 * Sans ce repli, deux gestes retour depuis la confirmation retrouvaient l'entrée
 * de l'étape « Créneau », qui ne porte pas de `creneau` : le rendez-vous sortait
 * du brouillon — donc du `sessionStorage`, que l'autosauvegarde réécrit —, la
 * cliente perdait sa référence et son bouton « Annuler ce rendez-vous », et le
 * tunnel la laissait repartir confirmer une seconde fois ce qu'elle venait de
 * réserver, ce que #732 interdit.
 *
 * Le repli s'arrête là où le défaut reprendrait : une entrée qui nomme **une
 * autre prestation**. Deux réservations peuvent se suivre dans le même onglet —
 * la seconde ouverte par un lien de la vitrine, qui fait justement tomber le
 * rendez-vous de la première —, et l'historique garde alors les entrées de la
 * première derrière celles de la seconde. Y reposer le rendez-vous en cours
 * recomposerait le récapitulatif inventé de #1152, par l'autre bout. Une entrée
 * qui ne nomme **aucune** prestation, elle, ne contredit rien : c'est la
 * première du tunnel, et le rendez-vous y reste — c'est le « on ressort du
 * tunnel sans jamais retomber sur un récapitulatif » de #732.
 */
function keepBookedAppointment(current: BookingDraft, merged: BookingDraft): BookingDraft {
  const booked = current.appointment;
  const rewound =
    merged.appointment === null &&
    booked !== null &&
    (merged.serviceId === null || merged.serviceId === booked.serviceId);

  return rewound ? { ...merged, appointment: booked } : merged;
}

/**
 * Le tunnel de réservation (#45) — prestation, créneau, coordonnées,
 * récapitulatif, confirmation.
 *
 * Client Component, parce qu'il porte l'état du parcours ; il est monté par un
 * Server Component qui a déjà rendu la vitrine et le catalogue. Le `"use
 * client"` est donc **ici** et pas sur la page : le placer plus haut ferait
 * basculer toute la page côté client et coûterait le référencement de la
 * surface qui génère le revenu (skill web-frontend §1).
 *
 * L'état vit dans l'URL et dans `sessionStorage` — voir `lib/booking/draft.ts`
 * pour le partage des rôles. Le composant relit les deux au montage, réécrit le
 * stockage à chaque changement, et tient l'adresse à jour à chaque étape.
 *
 * ## La langue (#846)
 *
 * ### Le sélecteur est en **pied de colonne**, et non dans l'en-tête
 *
 * L'en-tête du tunnel se réduit à « ← Retour » et « ✕ Quitter » (BM-TUNNEL-10),
 * et c'est tout l'objet de #1047 : l'attention reste sur la réservation. Le
 * choix de la langue est un **réglage d'affichage**, du même ordre que le thème
 * — `SalonShell` le range pour cette raison dans le pied de la vitrine et de
 * l'espace client (#845). Il ferme donc la colonne de l'étape, à la place où
 * l'on cherche les réglages, sans disputer la sienne à aucune des deux
 * commandes du haut.
 *
 * Il est un **frère** des étapes et jamais leur descendant : le sélecteur est
 * lui-même un `<form>`, et trois des cinq étapes en sont un — un formulaire
 * imbriqué n'est pas du HTML valide, et le navigateur en démonterait un.
 *
 * ### Changer de langue ne perd pas ce qui a été choisi
 *
 * `setLocaleAction` est une action serveur : Next rejoue la route courante
 * après elle, **sans navigation**. Ce composant n'est donc ni démonté ni
 * remonté, son état survit tel quel, et même s'il l'était, le brouillon vit dans
 * `sessionStorage` et dans l'adresse. Ce sont `useState(() => initialDraft)`,
 * l'effet d'hydratation et l'effet d'adresse qui le garantissent : la langue ne
 * les touche pas.
 *
 * ### Les dates, les heures et le fuseau
 *
 * `display` porte la langue résolue et le pays de l'établissement ; le
 * **fuseau** reste celui du salon, quelle que soit la langue (ADR 0006).
 */
export function BookingTunnel({
  tenant,
  services,
  exitHref,
  presence,
  loginHref,
  registerHref,
  initialDraft,
}: BookingTunnelProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  /**
   * Ce qui décide de la mise en forme des dates, des heures et des montants —
   * la langue de la requête et le pays de l'établissement (#846).
   *
   * Mémoïsé pour que les rappels qui le lisent — `onSlotLost` — ne changent pas
   * d'identité à chaque rendu du tunnel.
   */
  const countryCode = tenant.address?.country ?? null;
  const display: DisplayLocale = useMemo(() => ({ locale, countryCode }), [locale, countryCode]);
  // L'étape et les choix que l'adresse porte, dès le premier rendu — celui du
  // serveur, que l'hydratation rejoue à l'identique (#1055). Le reste du
  // brouillon arrive de `sessionStorage` dans l'effet ci-dessous.
  const [draft, setDraft] = useState<BookingDraft>(() => initialDraft);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  /**
   * Le rendez-vous affiché vient du brouillon relu, et non d'une réponse de
   * l'API obtenue dans cette page (#732).
   *
   * Il ne s'agit pas d'un détail d'affichage : le brouillon est écrit **une
   * fois**, à la réservation, et rien ne le relit. Reporté ou annulé depuis
   * l'espace client, le rendez-vous reste donc annoncé « enregistré » ici, à son
   * ancien horaire. Tant qu'aucune lecture publique d'un rendez-vous n'existe
   * côté API, l'écran de confirmation doit au moins savoir qu'il montre un
   * instantané — c'est ce que ce drapeau lui dit.
   */
  const [restoredAppointment, setRestoredAppointment] = useState(false);
  /**
   * L'étape que l'URL affiche déjà.
   *
   * C'est ce qui distingue « le visiteur a changé d'étape » — une entrée
   * d'historique de plus, pour que le geste retour revienne d'une étape — de
   * « l'étape n'a pas bougé, seuls les choix ont changé » — l'adresse se
   * corrige sur place, sans empiler une entrée par praticien essayé.
   */
  const historyStepRef = useRef<BookingStep | null>(null);
  /**
   * Le geste retour vient de nous ramener ici (#733).
   *
   * Ce qui suit un `popstate` corrige l'adresse **sur place**, quelle que soit
   * l'étape quittée : `reachableStep` a le dernier mot sur l'entrée retrouvée —
   * un récapitulatif dont les coordonnées sont reparties, une confirmation dont
   * le rendez-vous a disparu — et empiler une entrée pour cette correction
   * ferait grossir la pile au moment précis où le visiteur cherche à en sortir.
   */
  const cameFromHistoryRef = useRef(false);
  /**
   * Le brouillon tel qu'il a été écrit dans `sessionStorage` la dernière fois (#737).
   *
   * Il sert à une seule chose : écrire le brouillon **sans passer par un
   * rendu**, quand l'instant ne permet pas d'en attendre un — voir
   * `saveContact`.
   */
  const persistedDraftRef = useRef<BookingDraft>(emptyBookingDraft());
  /**
   * L'étape vient d'être rouverte par « ← Retour », et le focus est à rattraper
   * (#740, #1047) — voir `goBack`.
   */
  const backJumpRef = useRef(false);
  /** Le titre de l'étape, cible de ce rattrapage. */
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  /**
   * La réservation a refusé faute de compte — voir `onSignInRequired`.
   *
   * La présence reçue en propriété a été lue au rendu serveur de la page, et
   * elle peut avoir vieilli : une déconnexion dans un autre onglet efface le
   * cookie sans que cet écran-ci l'apprenne. Le refus est alors le seul signal,
   * et ce drapeau le fait prévaloir sur la propriété.
   *
   * Depuis #1207, ce refus est celui de la **route** `/{slug}/compte/reservation`
   * — la session y est lue pour de bon, et non plus devinée d'un cookie de
   * présence qui n'autorise rien (`booking-request.ts`).
   */
  const [signedOut, setSignedOut] = useState(false);
  /** La cliente connectée, telle que cet écran doit la tenir pour vraie. */
  const account = signedOut ? null : presence;
  /**
   * À qui le brouillon de cet onglet a le droit d'appartenir (#1151).
   *
   * Lue sur la **propriété** et non sur `account` : c'est l'identité que le
   * serveur a vouée à cette page, et c'est elle qui doit décider du sort de
   * coordonnées déjà écrites dans `sessionStorage`. `signedOut`, lui, est un
   * refus constaté en cours de route — il ramène à l'écran de connexion **sans
   * rien perdre** (`onSignInRequired`), et la cliente qui se reconnecte sous le
   * même compte retrouve sa saisie. Si elle se reconnecte sous un autre, la page
   * est rendue à neuf et c'est cette clé-ci, fraîche, qui tranche.
   */
  const presenceAccount = contactAccountKey(presence?.email);

  // Relecture du brouillon. Depuis #1055, l'étape et les choix de l'adresse sont
  // déjà là — le serveur les a résolus (`initial-draft.ts`) —, mais
  // `sessionStorage` ne se lit toujours qu'ici : coordonnées et rendez-vous
  // obtenu n'arrivent donc qu'après le montage, d'où le squelette ci-dessous,
  // qui prend au moins la forme de la bonne étape.
  //
  // L'URL est relue **par-dessus** le stockage : c'est elle qui fait foi dès
  // qu'elle porte l'étape, sans quoi un lien partagé rouvrirait le parcours de
  // l'onglet plutôt que celui qu'on lui a envoyé (#733).
  //
  // Le compte a le dernier mot sur les **coordonnées** (#1151) : un brouillon
  // laissé par une autre cliente dans cet onglet n'entre pas dans cet écran-ci.
  // Le tri se fait **ici**, avant que l'étape « Coordonnées » ne soit montée :
  // `ContactStep` est un formulaire non contrôlé, qui ne lit ses valeurs par
  // défaut qu'au montage — les lui retirer un rendu plus tard les laisserait
  // dans ses champs. Tant que `hydrated` est faux, c'est le squelette qui est
  // rendu, et aucun champ n'existe encore.
  useEffect(() => {
    const merged = draftForAccount(
      draftFromSearch(window.location.search, readBookingDraft(tenant.slug)),
      presenceAccount,
    );
    const step = reachableStep(merged);

    // Laissé vide, et non posé à l'étape : l'effet de synchronisation qui suit
    // y inscrira l'étape **réellement affichée**, qui n'est pas toujours
    // celle-ci — une prestation retirée du catalogue ramène l'écran à
    // `prestation` sans que le brouillon en sache rien. Tant qu'il est vide,
    // l'adresse se corrige sur place : l'arrivée sur la page n'est pas un
    // changement d'étape et ne doit pas pousser une entrée d'historique que
    // personne n'a demandée.
    historyStepRef.current = null;
    setDraft({ ...merged, step });
    setRestoredAppointment(merged.appointment !== null);
    setHydrated(true);
  }, [tenant.slug, presenceAccount]);

  useEffect(() => {
    if (hydrated) {
      persistedDraftRef.current = draft;
      writeBookingDraft(tenant.slug, draft);
    }
  }, [hydrated, draft, tenant.slug]);

  const selectedService = useMemo(
    () => services.find((service) => service.id === draft.serviceId) ?? null,
    [services, draft.serviceId],
  );

  /**
   * L'étape effectivement affichée.
   *
   * Elle n'est pas toujours celle du brouillon : une prestation retirée du
   * catalogue entre deux visites laisse un `serviceId` que plus rien ne résout,
   * et le récapitulatif n'aurait alors ni nom ni prix à montrer. On revient à la
   * première étape qui a du sens, plutôt que d'afficher un écran troué.
   *
   * Le récapitulatif est aussi refusé à qui n'est pas connectée (2026-09-22) :
   * un brouillon d'avant la règle, ou un lien `?etape=recapitulatif`, porte
   * parfois des coordonnées complètes, et `reachableStep` l'ouvrirait. On
   * revient alors à « Coordonnées », c'est-à-dire à l'écran de connexion.
   */
  const step: BookingStep =
    draft.appointment !== null
      ? 'confirmation'
      : selectedService === null
        ? 'prestation'
        : account === null && draft.step === 'recapitulatif'
          ? 'coordonnees'
          : draft.step;
  /** L'étape « Coordonnées » barre la route : il faut un compte pour réserver. */
  const gated = account === null && step === 'coordonnees';

  /**
   * L'adresse suit l'étape affichée (#733).
   *
   * ## Pourquoi l'API du navigateur et non `router.push`
   *
   * Il ne s'agit pas de naviguer : l'écran est déjà monté, il ne change pas de
   * route, et seule son adresse doit dire la vérité. Un `router.push` en ferait
   * une navigation complète — remontage de la page, et sur un Server Component
   * en `force-dynamic`, un nouveau rendu serveur avec ses appels à l'API. Next
   * reconnaît les appels natifs et garde son routeur d'accord avec eux, pour un
   * coût bien moindre : la recherche du nœud de cache de la nouvelle adresse.
   *
   * ## Pourquoi en `useLayoutEffect`, et pas en `useEffect`
   *
   * Ce n'est pas une préférence : c'est la condition pour que le tunnel
   * fonctionne. Écrire l'adresse fait dispatcher à Next une action `RESTORE`,
   * et sa file d'actions **écarte l'action serveur en vol** quand une
   * navigation arrive par-dessus (`app-router-instance.js` :
   * « Navigations take priority over any pending actions »,
   * `pending.discarded = true`). La promesse de l'action écartée ne se résout
   * jamais.
   *
   * Or chaque étape charge ses données dans un `useEffect` — `SlotStep`
   * interroge les disponibilités dès son montage. En `useEffect`, l'ordre du
   * commit est : l'enfant d'abord, le parent ensuite ; l'adresse s'écrivait donc
   * **après** le départ de l'action, et le calendrier restait en squelette
   * jusqu'à la revalidation d'une minute. C'est ce qui a fait échouer le
   * parcours critique.
   *
   * Les effets de disposition, eux, s'exécutent **tous** avant les effets
   * passifs, quel que soit l'étage de l'arbre. L'action `RESTORE` est donc
   * déposée dans la file avant que l'étape ne demande ses données : celle-ci
   * s'y range derrière, au lieu d'être écartée par elle.
   *
   * ## Pousser, ou corriger sur place
   *
   * Une entrée d'historique par **changement d'étape**, et une seule : c'est ce
   * qui fait que le geste retour revient d'une étape au lieu de sortir du
   * tunnel. Tout le reste — un praticien changé, un créneau repris, une lettre
   * tapée dans le formulaire — corrige l'entrée courante : empiler une entrée
   * par frappe rendrait le bouton « retour » inutilisable.
   *
   * La confirmation fait exception et **remplace** l'entrée du récapitulatif :
   * le rendez-vous est pris, cet écran est terminal (#732), et il n'y a rien à
   * revenir confirmer une seconde fois. Un visiteur qui insiste sur le retour
   * ressort du tunnel, sans jamais retomber sur un récapitulatif qui
   * réserverait deux fois.
   *
   * Deux autres corrections se posent sur place, et pour la même raison : la
   * première adresse de la page — l'arrivée n'est pas un changement d'étape —,
   * et celle que `reachableStep` rectifie après un retour arrière. Les pousser
   * ferait grossir la pile d'historique à chaque appui sur « retour », c'est-à-dire
   * au moment exact où le visiteur demande qu'elle diminue.
   *
   * ## Une écriture d'adresse par rendu, jamais deux (#947)
   *
   * Chaque appel à `replaceState` ou `pushState` dépose une action `RESTORE`
   * dans la file de Next, et une file où deux d'entre elles se suivent ne rend
   * pas la main à l'action serveur qui arrive derrière : la promesse de
   * `loadAvailabilityAction` ne se résolvait plus, et l'étape « Créneau »
   * restait en squelette jusqu'à la revalidation d'une minute — exactement la
   * panne que la section précédente décrit, et le parcours critique l'a
   * attrapée. Corriger l'entrée qu'on quitte **avant** d'en empiler une
   * nouvelle était la façon évidente de lui faire garder les choix faits sur
   * elle ; c'est cette voie-là qui est fermée. Le créneau retenu est donc
   * rattrapé au retour arrière, par le brouillon — voir l'écouteur `popstate`
   * ci-dessous.
   *
   * ## Ce qui n'y va pas
   *
   * Les coordonnées et le rendez-vous obtenu restent hors de l'adresse
   * (`lib/booking/draft.ts`). Et la prestation n'y figure que si le catalogue la
   * résout encore : une prestation retirée entre deux visites laisserait sinon
   * un identifiant mort dans une URL qu'on partage.
   */
  useHistoryEffect(() => {
    if (!hydrated) {
      return;
    }

    // Consommé à chaque passage, et pas seulement quand l'adresse change : le
    // drapeau ne vaut que pour le rendu qui suit immédiatement le retour
    // arrière.
    const cameFromHistory = cameFromHistoryRef.current;

    cameFromHistoryRef.current = false;

    const search = bookingSearch(
      { ...draft, step, serviceId: selectedService?.id ?? null },
      window.location.search,
    );
    const url = `${window.location.pathname}${search}`;
    // `null` au premier passage : l'adresse de départ n'a encore été écrite par
    // personne, et rien ne s'est donc « changé » en arrivant.
    const previousStep = historyStepRef.current;

    historyStepRef.current = step;

    if (url === `${window.location.pathname}${window.location.search}`) {
      // Rien à corriger : c'est le cas de tous les rendus où seule la saisie a
      // changé, et celui du retour arrière qui retrouve une entrée déjà exacte.
      // Un retour arrière qui rattrape le créneau retenu (#947), lui, passe
      // outre : l'entrée retrouvée ne le portait pas, et c'est `cameFromHistory`
      // qui fait poser la correction **sur place**, sans empiler d'entrée.
      return;
    }

    if (
      cameFromHistory ||
      previousStep === null ||
      previousStep === step ||
      step === 'confirmation'
    ) {
      window.history.replaceState(null, '', url);
    } else {
      window.history.pushState(null, '', url);
    }
  }, [hydrated, draft, step, selectedService]);

  /**
   * Le geste retour du navigateur — la navigation principale sur mobile (#733).
   *
   * L'étape et les choix sont relus dans l'adresse où le navigateur vient de
   * nous ramener ; les coordonnées, elles, restent celles du brouillon en cours,
   * puisqu'elles n'ont jamais quitté le stockage. Revenir d'une étape ne coûte
   * donc jamais un formulaire déjà rempli.
   *
   * `reachableStep` reste le dernier mot : l'adresse peut avoir été bricolée,
   * mise en favori avant un déploiement, ou décrire un état que le brouillon ne
   * porte plus.
   */
  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const onPopState = (): void => {
      setNotice(null);
      // L'effet de synchronisation corrigera l'adresse sur place : ce qui suit
      // un retour arrière ne crée jamais d'entrée.
      cameFromHistoryRef.current = true;
      setDraft((current) => {
        const merged = keepBookedAppointment(
          current,
          keepChosenSlot(current, draftFromSearch(window.location.search, current)),
        );

        return { ...merged, step: reachableStep(merged) };
      });
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [hydrated]);

  const chooseService = useCallback((serviceId: string, staffId: string | null) => {
    setNotice(null);
    setDraft((current) => ({
      ...current,
      serviceId,
      staffId,
      // Changer de prestation ou de praticien invalide le créneau retenu : sa
      // durée et son agenda ne sont plus les mêmes.
      startsAt: null,
      step: 'creneau',
    }));
  }, []);

  /**
   * Le praticien changé depuis l'étape créneau (#44).
   *
   * C'est le même champ du brouillon que celui posé à l'étape prestation : il
   * n'y a qu'un praticien retenu, et le reprendre ici plutôt que d'obliger à
   * remonter d'un écran ne lui donne pas une seconde vie. `null` vaut « premier
   * disponible », pas « pas encore choisi ».
   */
  const chooseStaff = useCallback((staffId: string | null) => {
    setNotice(null);
    // Le créneau retenu tombe avec le praticien : il venait de son agenda.
    setDraft((current) => ({ ...current, staffId, startsAt: null }));
  }, []);

  const chooseSlot = useCallback((startsAt: UtcInstant) => {
    setNotice(null);
    setDraft((current) => ({ ...current, startsAt, step: 'coordonnees' }));
  }, []);

  /**
   * Report de la saisie en cours, sans changement d'étape — voir `ContactStep`.
   *
   * L'écriture dans `sessionStorage` est faite **ici et tout de suite**, en plus
   * de celle que l'effet ci-dessus fera au rendu suivant (#737). Ce doublon n'en
   * est pas un : il y a un instant où le second chemin n'arrive jamais.
   *
   * `ContactStep` verse la saisie au masquage de la page — `pagehide`,
   * `visibilitychange` —, c'est-à-dire sur le dernier signal qu'un navigateur
   * donne avant de laisser partir l'onglet. Or le chemin normal du brouillon est
   * `setDraft` → rendu → effet passif, et React planifie ses effets passifs dans
   * une tâche distincte (`MessageChannel`), pas dans une microtâche : cette
   * tâche-là n'a pas lieu quand le document s'en va. La saisie qu'on croyait
   * sauver serait perdue exactement dans le cas que le ticket décrit.
   *
   * L'état React reste mis à jour par un `setDraft` fonctionnel, qui fait foi ;
   * la référence n'est qu'un instantané de la dernière écriture, et l'effet
   * rattrape sans bruit l'écart si elle a pris du retard.
   */
  const saveContact = useCallback(
    (contact: ContactDraft) => {
      // Le propriétaire est posé **à l'écriture**, et c'est la seule façon qu'il
      // soit juste : ces coordonnées sont celles que la cliente connectée vient
      // de taper ou de laisser telles quelles, et `draftForAccount` s'en servira
      // pour les refuser à la suivante (#1151).
      const persisted = { ...persistedDraftRef.current, contact, contactAccount: presenceAccount };

      persistedDraftRef.current = persisted;
      writeBookingDraft(tenant.slug, persisted);
      setDraft((current) => ({ ...current, contact, contactAccount: presenceAccount }));
    },
    [tenant.slug, presenceAccount],
  );

  const submitContact = useCallback(
    (contact: ContactDraft) => {
      setDraft((current) => ({
        ...current,
        contact,
        contactAccount: presenceAccount,
        step: 'recapitulatif',
      }));
    },
    [presenceAccount],
  );

  const goTo = useCallback((target: BookingStep) => {
    setNotice(null);
    setDraft((current) => ({ ...current, step: target }));
  }, []);

  /**
   * Le même geste, déclenché depuis « ← Retour » de l'en-tête (#740, #1047).
   *
   * Il se distingue de `goTo` par le focus. Le bouton cliqué **peut cesser
   * d'exister** au rendu suivant — c'est le cas du retour vers la première
   * étape, qui n'a pas de précédente —, et le focus retomberait alors sur
   * `<body>` : la navigation au clavier repartirait du haut du document au
   * moment précis où la visiteuse vient de demander à revenir en arrière.
   *
   * Le rattrapage se pose sur le **titre de l'étape**, et pas seulement dans ce
   * cas-là : c'est la phrase qui dit où l'on vient d'arriver — « Quelle
   * prestation souhaitez-vous ? » —, et la tabulation repart de là sur le
   * contenu de l'étape. C'est le motif habituel d'une navigation sans
   * rechargement (skill web-frontend §7).
   */
  const goBack = useCallback(
    (target: BookingStep) => {
      backJumpRef.current = true;
      goTo(target);
    },
    [goTo],
  );

  const onBooked = useCallback((appointment: BookedAppointment) => {
    setNotice(null);
    // Le rendez-vous sort de la réponse de l'API : à cet instant précis, et à
    // cet instant seulement, l'écran peut l'annoncer enregistré.
    setRestoredAppointment(false);
    setDraft((current) => ({ ...current, appointment, step: 'confirmation' }));
  }, []);

  /**
   * Le créneau a été pris pendant que la cliente saisissait ses coordonnées (#46).
   *
   * Ce n'est pas une erreur exceptionnelle, c'est le cas normal sous
   * concurrence (skill web-frontend §3). Trois choses en découlent, et ce sont
   * les trois premiers critères de l'issue :
   *
   * - **les créneaux sont rechargés.** Revenir à l'étape `creneau` démonte le
   *   récapitulatif et remonte `SlotStep`, qui interroge les disponibilités à
   *   son montage : la cliente ne choisit jamais dans la liste périmée qui
   *   vient de lui coûter sa réservation. Le test du tunnel l'exige
   *   explicitement, pour qu'un remaniement qui garderait l'étape montée
   *   échoue au lieu de laisser la liste figée ;
   * - **tout le reste est conservé.** Seul `startsAt` tombe. Prestation,
   *   praticien et coordonnées restent dans le brouillon — et donc dans
   *   `sessionStorage` : la cliente n'a qu'un horaire à reprendre, pas un
   *   formulaire ;
   * - **l'explication est écrite ici**, à partir du créneau perdu, et non
   *   reprise du corps d'erreur de l'API. Le `message` du contrat s'adresse à
   *   un développeur, il est traduisible et peut changer sans préavis ; seul le
   *   `code` engage l'API (skill web-frontend §2). Le rappel de l'horaire perdu
   *   dans le fuseau du salon vaut mieux qu'un « ce créneau » : entre le clic et
   *   l'écran, la cliente ne sait plus toujours lequel elle visait.
   *
   * La phrase ne nomme en revanche **aucune cause**. `SLOT_NO_LONGER_AVAILABLE`
   * couvre, du côté de l'API, toutes les façons dont ce créneau n'est plus
   * réservable — pris entre-temps, mais aussi sorti des horaires du praticien,
   * tombé sous le préavis minimum pendant la saisie, ou couvert par un congé
   * (`public-appointments.controller.ts`). Écrire « quelqu'un d'autre l'a
   * réservé » serait faux dans la moitié de ces cas, et faux à l'écran d'une
   * cliente qui n'a aucun moyen de vérifier.
   */
  const onSlotLost = useCallback(() => {
    const lost = draft.startsAt;

    setNotice({
      tone: 'warning',
      title: t('tunnel.notices.slotLost.title'),
      // Deux messages et non une phrase composée d'un morceau variable : le
      // français dit « Le lundi 1 septembre à 09:00 », l'anglais « Your time on
      // Monday, 1 September at 9:00 AM », et la préposition n'est pas au même
      // endroit. `null` n'arrive de toute façon pas depuis le récapitulatif,
      // qui ne s'affiche pas sans créneau — c'est le type qui l'impose ici.
      body:
        lost === null
          ? t('tunnel.notices.slotLost.body')
          : t('tunnel.notices.slotLost.bodyWithSlot', {
              slot: formatDateTimeInTimeZone(lost, tenant.timezone, display),
            }),
    });
    setDraft((current) => ({ ...current, startsAt: null, step: 'creneau' }));
  }, [draft.startsAt, display, t, tenant.timezone]);

  /**
   * L'action de réservation a refusé faute de compte (2026-09-22).
   *
   * Le récapitulatif ne s'ouvre qu'à une cliente connectée, et ce refus ne
   * devrait donc jamais arriver — sauf quand le cookie de présence a disparu
   * depuis le rendu de la page : une déconnexion dans un autre onglet, une
   * session arrivée à échéance. La cliente est ramenée à l'écran de connexion,
   * **sans rien perdre** : prestation, créneau et coordonnées restent au
   * brouillon, exactement comme après un créneau perdu (#46).
   */
  const onSignInRequired = useCallback(() => {
    setSignedOut(true);
    setNotice({
      tone: 'warning',
      // Écrite ici et non reprise du corps d'erreur de l'API, pour la raison
      // déjà donnée à `onSlotLost` : seul le `code` engage l'API.
      title: t('tunnel.notices.sessionEnded.title'),
      body: t('tunnel.notices.sessionEnded.body'),
    });
    setDraft((current) => ({ ...current, step: 'coordonnees' }));
  }, [t]);

  const onCancelled = useCallback((appointment: BookedAppointment) => {
    setNotice(null);
    // Même raison qu'à la réservation : l'annulation vient d'être confirmée par
    // l'API, l'état affiché redevient celui du salon.
    setRestoredAppointment(false);
    setDraft((current) => ({ ...current, appointment }));
  }, []);

  /**
   * « Réserver à nouveau » — la sortie de l'écran terminal (#732).
   *
   * Le brouillon repart vierge, y compris les coordonnées : une nouvelle
   * réservation n'est pas forcément pour la même personne, et le tunnel ne doit
   * pas resservir un e-mail à qui vient de rendre son poste.
   */
  const restart = useCallback(() => {
    setNotice(null);
    setRestoredAppointment(false);
    setDraft(emptyBookingDraft());
  }, []);

  /**
   * Le focus suit la notification quand elle apparaît.
   *
   * Le bouton qui vient d'être cliqué — « Confirmer la réservation » — disparaît
   * avec son étape. Sans ce déplacement, le focus retomberait sur `<body>` et la
   * navigation au clavier repartirait du haut du document, au moment précis où
   * il faut lire ce qui s'est passé puis choisir un autre horaire. Le parcours
   * de réservation doit rester praticable sans souris (skill web-frontend §7).
   */
  useEffect(() => {
    if (notice !== null) {
      noticeRef.current?.focus();
    }
  }, [notice]);

  /**
   * Le focus suit l'étape rouverte par « ← Retour » (#740, #1047).
   *
   * Même correction que celle de la notification juste au-dessus, et pour la
   * même raison : le bouton cliqué peut disparaître avec son état, et le focus
   * retomberait sur `<body>`. Le parcours de réservation doit rester praticable
   * sans souris (skill web-frontend §7).
   *
   * Posé sur `step` et non sur le drapeau : c'est le changement d'étape qui doit
   * déclencher le rattrapage, et le drapeau ne fait que distinguer le retour en
   * arrière de tout le reste — un bouton « Continuer » ne renvoie pas le focus
   * au titre de l'écran qu'il vient d'ouvrir, la suite de la tabulation y mène
   * déjà.
   */
  useEffect(() => {
    if (backJumpRef.current) {
      backJumpRef.current = false;
      titleRef.current?.focus();
    }
  }, [step]);

  const zoneMention = hydrated ? timeZoneMention(tenant.timezone, display) : null;

  /**
   * Ce que le tunnel rappelle de la réservation en cours (#735, #1047).
   *
   * Un seul objet, composé ici et passé aux surfaces qui le rendent — la barre
   * basse de l'étape, la colonne de bureau, la feuille dépliée. Les étapes n'ont
   * ainsi rien à savoir du catalogue pour rappeler ce qui a été choisi.
   *
   * `null` tant qu'aucune prestation n'est résolue : il n'y a alors ni durée, ni
   * prix, ni praticien à nommer.
   */
  const summary: BookingSummary | null =
    selectedService === null
      ? null
      : {
          serviceName: selectedService.name,
          durationMinutes: selectedService.durationMinutes,
          price: selectedService.price,
          staffName:
            selectedService.staff.find((member) => member.id === draft.staffId)?.displayName ??
            null,
          startsAt: draft.startsAt,
          timeZone: tenant.timezone,
          // La **région** de mise en forme voyage avec le fuseau, et pour la
          // même raison : ces faits sont ceux du salon, pas du navigateur
          // (#846). La langue, elle, est lue par les surfaces qui rendent le
          // rappel.
          countryCode,
        };

  /**
   * Les deux étapes où le rappel est rendu (#735).
   *
   * Ce sont exactement celles que l'audit de conception a relevées : « Créneau »,
   * où l'écran ne portait que le nom de la prestation — son prix avait disparu
   * avec l'étape précédente —, et « Coordonnées », où plus rien ne rappelait ni
   * la prestation, ni la date, ni l'heure, ni le prix. Les trois autres sont
   * écartées, chacune pour sa raison :
   *
   * - **« Prestation »**, parce que le choix n'y est pas encore *retenu* :
   *   `ServiceStep` garde sa sélection dans son propre état jusqu'à la
   *   soumission, si bien qu'un rappel alimenté par le brouillon annoncerait la
   *   prestation précédente pendant qu'on en désigne une autre — deux réponses
   *   différentes à la même question, sur le même écran. Rien n'y manque pour
   *   autant : depuis #741, chaque carte de l'étape porte sa durée et son prix ;
   * - **« Récapitulatif »**, parce que ces faits **y sont l'écran**. Le
   *   wireframe garde la barre à son étape 5, mais cette étape-là est le
   *   paiement — un conteneur Stripe, sous lequel un rappel a tout son sens.
   *   Le tunnel du MVP n'en a pas : l'étape porte le récapitulatif entier, et un
   *   rappel à côté de lui redirait trois de ses lignes ;
   * - **« Confirmation »**, parce que `wireframes.md` l'écarte explicitement à
   *   l'étape 6 : « Plus d'indicateur d'étape ni de barre collante : le tunnel
   *   est terminé ».
   */
  const recalled = summary !== null && (step === 'creneau' || step === 'coordonnees');

  /** L'étape que « ← Retour » rouvre — `null` quand il n'y a rien derrière. */
  const previousStep = PREVIOUS_STEP[step];

  return (
    // Le tunnel porte désormais son propre en-tête et son `<main>` (#1047) : le
    // layout voisin n'est plus qu'une enveloppe de page. C'est ce qui permet à
    // l'en-tête de se réduire à « ← Retour » et « ✕ Quitter » — deux commandes
    // qui dépendent de l'étape et du brouillon, donc de cet état-ci
    // (BM-TUNNEL-10).
    <>
      <BookingTunnelHeader
        tenantName={tenant.name}
        exitHref={exitHref}
        onBack={
          previousStep === null
            ? null
            : () => {
                goBack(previousStep);
              }
        }
        // Avant l'hydratation, le brouillon n'a pas encore été relu : annoncer
        // « rien à perdre » serait faux pour qui revient sur l'onglet, et la
        // sortie demande donc confirmation par défaut.
        //
        // La confirmation fait exception : le rendez-vous est pris, il n'y a
        // plus de réservation en cours à interrompre, et retenir la visiteuse
        // sur un écran terminal n'aurait rien à protéger (#732).
        unsavedWork={step !== 'confirmation' && (!hydrated || hasDraftInput(draft))}
      />

      <main className="spa-booking__main" id="contenu">
        <div
          className={
            recalled ? 'spa-booking__frame spa-booking__frame--aside' : 'spa-booking__frame'
          }
        >
          <div className="spa-booking__content">
            <BookingProgress
              step={step}
              // Tue à l'étape « Prestation » : aucun horaire n'y est affiché,
              // et une mention de fuseau au-dessus d'un catalogue de
              // prestations répond à une question que l'écran ne pose pas. Elle
              // reparaît dès le calendrier, où elle qualifie ce qu'on lit.
              timeZoneMention={step === 'prestation' ? null : zoneMention}
              titleRef={titleRef}
              // Le titre de l'étape qui barre la route est lu **ici** et non
              // exporté par `AccountGateStep` : une constante de module ne peut
              // pas lire le catalogue (#846). C'est de toute façon le tunnel
              // qui rend la progression, donc le seul à afficher ce titre.
              title={gated ? t('tunnel.gateStep.title') : undefined}
            />

            {notice === null ? null : (
              // `tabIndex={-1}` rend l'enveloppe focalisable par programme sans
              // l'insérer dans l'ordre de tabulation : elle ne devient une étape
              // du clavier ni avant ni après avoir reçu le focus.
              <div ref={noticeRef} tabIndex={-1}>
                <Notification tone={notice.tone} title={notice.title}>
                  <p>{notice.body}</p>
                </Notification>
              </div>
            )}

            {!hydrated ? (
              // Le squelette de **cette** étape, et non une carte grise unique
              // (#1055, `BM-ECRAN-01`) : lignes de prestation, bande de jours et
              // pastilles d'horaires, champs du formulaire, carte
              // récapitulatif. L'étape vient de l'adresse, lue par le serveur.
              <BookingStepSkeleton
                step={step}
                services={services}
                selectedServiceId={draft.serviceId}
              />
            ) : step === 'prestation' ? (
              <ServiceStep
                services={services}
                selectedServiceId={draft.serviceId}
                selectedStaffId={draft.staffId}
                // La région de mise en forme des durées et des tarifs, comme à
                // l'étape du créneau et dans le rappel : elle est celle du
                // salon, pas du navigateur (#846).
                countryCode={countryCode}
                onSubmit={chooseService}
              />
            ) : step === 'creneau' && selectedService !== null ? (
              <SlotStep
                tenant={tenant}
                service={selectedService}
                staffId={draft.staffId}
                // Le créneau déjà retenu, quand on revient sur l'étape (#947) :
                // l'écran s'ouvre sur son mois et le marque, au lieu de repartir
                // du mois courant et de la première journée libre.
                startsAt={draft.startsAt}
                // Le rappel de la barre basse. Il est rendu par l'étape et non
                // ici, parce que c'est l'étape qui porte l'action primaire, et
                // qu'une soumission doit rester dans son formulaire
                // (`components/booking/summary-bar.tsx`).
                summary={summary}
                onBack={() => {
                  goTo('prestation');
                }}
                onStaffChange={chooseStaff}
                onChoose={chooseSlot}
              />
            ) : gated ? (
              // Réserver exige un compte : la visiteuse qui n'en a pas ouvert
              // s'arrête ici, avec ses choix rappelés, et repart vers la
              // connexion ou l'inscription du salon (2026-09-22).
              <AccountGateStep
                tenantName={tenant.name}
                summary={summary}
                loginHref={loginHref}
                registerHref={registerHref}
                onBack={() => {
                  goTo('creneau');
                }}
              />
            ) : step === 'coordonnees' ? (
              <ContactStep
                // Le compte **est** l'identité de ce formulaire (#1151).
                // `ContactStep` est non contrôlé : `useForm` ne lit
                // `defaultValues` qu'au montage, et React réutiliserait
                // l'instance en place — les champs garderaient les coordonnées
                // de la cliente précédente alors que le brouillon vient de les
                // rendre. La clé force le remontage au seul instant où c'est ce
                // qu'on veut : un changement de compte. Elle est stable tant
                // que la session l'est, et ne coûte donc aucun remontage
                // ailleurs.
                key={presenceAccount ?? ''}
                contact={draft.contact}
                tenantSlug={tenant.slug}
                // Le pays de l'établissement, d'où le téléphone tire son
                // indicatif par défaut (#1028). `address` est absente tant que
                // le salon n'a pas publié la sienne, et `null` dit alors
                // exactement ce que l'API en dira : pas de pays, donc pas de
                // numéro national acceptable.
                //
                // Lire le pays **dans l'adresse** ne perd rien : la contrainte
                // `tenants_address_completeness_check` veut qu'`address_line1`,
                // `city` et `country_code` soient les trois nuls ou les trois
                // renseignés, si bien que cette lecture vaut
                // `tenants.country_code` — la colonne même que le pipe serveur
                // consulte.
                countryCode={tenant.address?.country ?? null}
                summary={summary}
                // La cliente connectée, telle que le serveur l'a lue (#1050).
                presence={account}
                onSave={saveContact}
                onBack={() => {
                  goTo('creneau');
                }}
                onSubmit={submitContact}
              />
            ) : step === 'recapitulatif' && selectedService !== null && draft.startsAt !== null ? (
              <SummaryStep
                tenant={tenant}
                service={selectedService}
                staffId={draft.staffId}
                startsAt={draft.startsAt}
                contact={draft.contact}
                // Les trois corrections du récapitulatif (#1051, BM-TUNNEL-01) :
                // chaque bloc rouvre **son** étape, et le brouillon garde tout le
                // reste — c'est le « corriger sans repartir de zéro » du motif.
                //
                // Elles passent par `goBack` et non `goTo` : le « Modifier »
                // cliqué vit **dans** le récapitulatif, que le changement
                // d'étape démonte aussitôt. Sans rattrapage, le focus retombe
                // sur `<body>` et la tabulation repart du haut du document au
                // moment précis où la visiteuse vient de demander à corriger
                // quelque chose (#740, skill web-frontend §7).
                onBack={() => {
                  goBack('coordonnees');
                }}
                onEditSlot={() => {
                  goBack('creneau');
                }}
                onEditService={() => {
                  goBack('prestation');
                }}
                onBooked={onBooked}
                onSlotLost={onSlotLost}
                onSignInRequired={onSignInRequired}
              />
            ) : step === 'confirmation' && draft.appointment !== null ? (
              <ConfirmationStep
                tenant={tenant}
                service={selectedService}
                appointment={draft.appointment}
                contact={draft.contact}
                restored={restoredAppointment}
                onCancelled={onCancelled}
                onRestart={restart}
              />
            ) : null}

            {/*
              Le sélecteur de langue ferme la colonne de l'étape, et non
              l'en-tête (#846).

              C'est un réglage d'affichage, du même ordre que le thème, et il est
              rangé au même endroit que dans `components/salon/salon-shell.tsx` :
              le pied. L'en-tête du tunnel, lui, se réduit à « ← Retour » et
              « ✕ Quitter » (BM-TUNNEL-10) — un troisième contrôle y disputerait
              la place aux deux seules commandes de l'écran.

              **Frère des étapes, jamais leur descendant** : le sélecteur est un
              `<form>`, et trois des cinq étapes en sont un. Un formulaire
              imbriqué n'est pas du HTML valide.

              Sans enveloppe ni classe nouvelle : `.spa-booking__content` est une
              colonne flex à gouttière, et `.spa-locale-switcher` porte déjà son
              `align-self`.
            */}
            <LocaleSwitcher />
          </div>

          {/* La colonne de bureau, rendue par le tunnel et non par l'étape :
              elle est la seconde piste de la grille, donc une sœur du contenu.
              En dessous de 64 rem, la feuille l'efface — la barre basse de
              l'étape y dit la même chose en une ligne. */}
          {recalled && summary !== null ? <BookingSummaryAside summary={summary} /> : null}
        </div>
      </main>
    </>
  );
}
