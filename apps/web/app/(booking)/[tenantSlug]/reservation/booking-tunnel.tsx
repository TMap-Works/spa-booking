'use client';

import type { BookedAppointment, PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BookingSummaryBar } from '@/components/booking/summary-bar';
import { Notification, type NotificationTone } from '@/components/ui/notification';
import {
  BOOKING_STEPS,
  bookingSearch,
  draftFromSearch,
  emptyBookingDraft,
  readBookingDraft,
  reachableStep,
  writeBookingDraft,
  type BookingDraft,
  type BookingStep,
  type ContactDraft,
} from '@/lib/booking/draft';
import { formatDateTimeInTimeZone, timeZoneMention } from '@/lib/format';

import { ConfirmationStep } from './steps/confirmation-step';
import { ContactStep } from './steps/contact-step';
import { ServiceStep } from './steps/service-step';
import { SlotStep } from './steps/slot-step';
import { SummaryStep } from './steps/summary-step';

const STEP_LABELS: Readonly<Record<BookingStep, string>> = {
  prestation: 'Prestation',
  creneau: 'Créneau',
  coordonnees: 'Coordonnées',
  recapitulatif: 'Récapitulatif',
  confirmation: 'Confirmation',
};

interface Notice {
  readonly tone: NotificationTone;
  readonly title: string;
  readonly body: string;
}

interface BookingTunnelProps {
  readonly tenant: PublicTenant;
  readonly services: readonly PublicService[];
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
 */
export function BookingTunnel({ tenant, services }: BookingTunnelProps) {
  const [draft, setDraft] = useState<BookingDraft>(emptyBookingDraft);
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

  // Relecture du brouillon. Ni l'URL ni `sessionStorage` ne sont lisibles au
  // rendu serveur : l'état de départ est donc toujours vierge, et l'étape réelle
  // n'apparaît qu'après le montage — d'où l'écran d'attente ci-dessous plutôt
  // qu'un affichage de la première étape qui sauterait aussitôt à la bonne.
  //
  // L'URL est relue **par-dessus** le stockage : c'est elle qui fait foi dès
  // qu'elle porte l'étape, sans quoi un lien partagé rouvrirait le parcours de
  // l'onglet plutôt que celui qu'on lui a envoyé (#733).
  useEffect(() => {
    const merged = draftFromSearch(window.location.search, readBookingDraft(tenant.slug));
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
  }, [tenant.slug]);

  useEffect(() => {
    if (hydrated) {
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
   */
  const step: BookingStep =
    draft.appointment !== null
      ? 'confirmation'
      : selectedService === null
        ? 'prestation'
        : draft.step;

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
      // changé, et celui du retour arrière qui vient de nous amener ici.
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
        const merged = draftFromSearch(window.location.search, current);

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

  /** Report de la saisie en cours, sans changement d'étape — voir `ContactStep`. */
  const saveContact = useCallback((contact: ContactDraft) => {
    setDraft((current) => ({ ...current, contact }));
  }, []);

  const submitContact = useCallback((contact: ContactDraft) => {
    setDraft((current) => ({ ...current, contact, step: 'recapitulatif' }));
  }, []);

  const goTo = useCallback((target: BookingStep) => {
    setNotice(null);
    setDraft((current) => ({ ...current, step: target }));
  }, []);

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
    // `null` n'arrive pas depuis le récapitulatif, qui ne s'affiche pas sans
    // créneau — c'est le type qui l'impose ici, et la phrase reste juste.
    const perdu =
      lost === null ? 'Ce créneau' : `Le ${formatDateTimeInTimeZone(lost, tenant.timezone)}`;

    setNotice({
      tone: 'warning',
      title: 'Ce créneau n’est plus disponible',
      body:
        `${perdu} n’est plus réservable : il vient d’être pris, ou il est sorti ` +
        'des horaires ouverts à la réservation. Votre prestation et vos ' +
        'coordonnées sont conservées : il ne vous reste qu’à choisir un autre ' +
        'horaire ci-dessous.',
    });
    setDraft((current) => ({ ...current, startsAt: null, step: 'creneau' }));
  }, [draft.startsAt, tenant.timezone]);

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

  const zoneMention = hydrated ? timeZoneMention(tenant.timezone) : null;

  /**
   * Les deux étapes où la barre de résumé est rendue (#735).
   *
   * Ce sont exactement celles que l'audit de conception a relevées : « Créneau »,
   * où l'écran ne portait que le nom de la prestation — son prix avait disparu
   * avec l'étape précédente —, et « Coordonnées », où plus rien ne rappelait ni
   * la prestation, ni la date, ni l'heure, ni le prix. Les trois autres sont
   * écartées, chacune pour sa raison :
   *
   * - **« Prestation »**, parce que le choix n'y est pas encore *retenu* :
   *   `ServiceStep` garde sa sélection dans son propre état jusqu'à la
   *   soumission, si bien qu'une barre alimentée par le brouillon annoncerait la
   *   prestation précédente pendant qu'on en désigne une autre — deux réponses
   *   différentes à la même question, sur le même écran. Rien n'y manque pour
   *   autant : chaque option du sélecteur porte déjà sa durée et son prix ;
   * - **« Récapitulatif »**, parce que ces faits **y sont l'écran**. Le
   *   wireframe garde la barre à son étape 5, mais cette étape-là est le
   *   paiement — un conteneur Stripe, sous lequel un rappel a tout son sens.
   *   Le tunnel du MVP n'en a pas : l'étape porte le récapitulatif entier, et
   *   une barre collante sous lui redirait trois de ses lignes à quelques
   *   pixels d'elles ;
   * - **« Confirmation »**, parce que `wireframes.md` l'écarte explicitement à
   *   l'étape 6 : « Plus d'indicateur d'étape ni de barre collante : le tunnel
   *   est terminé ».
   */
  const showSummary = step === 'creneau' || step === 'coordonnees';

  return (
    // Ni `<main>` ni `<h1>` ici : le layout voisin porte les deux (#623). Le
    // tunnel n'est plus qu'un panneau dans une page, comme un écran de l'espace
    // compte l'est dans la sienne — et le titre, désormais porté par un Server
    // Component, ne voyage plus dans le bundle client de ce composant-ci.
    <div className="spa-booking__panel">
      {zoneMention === null ? null : (
        <p className="spa-card__meta">Tous les horaires sont affichés en {zoneMention}.</p>
      )}

      {/* `role="list"` explicite : le socle retire le marqueur de tout `<ol>`
          (#625), et Safari retire alors à VoiceOver la sémantique de liste. Sans
          ce rôle, l'`aria-label` ci-dessous ne nomme plus une liste et la
          séquence des étapes — toute l'information que ce fil transporte — n'est
          plus annoncée comme telle (styles/README.md §3). */}
      <ol className="spa-card__meta" role="list" aria-label="Étapes de la réservation">
        {BOOKING_STEPS.map((name, index) => (
          <li key={name} aria-current={name === step ? 'step' : undefined}>
            {STEP_LABELS[name]}
            {/* Séparateur visuel, masqué à l'arbre d'accessibilité : la liste
                ordonnée dit déjà la séquence, un lecteur d'écran n'a pas à
                entendre un point médian entre chaque étape. Il est posé en fin
                d'élément et non en tête du suivant : aucun marqueur n'est plus
                rendu depuis le reset du socle, et le séparateur se rattache donc
                à l'étape qu'il termine. */}
            {index === BOOKING_STEPS.length - 1 ? null : <span aria-hidden="true"> · </span>}
          </li>
        ))}
      </ol>

      {notice === null ? null : (
        // `tabIndex={-1}` rend l'enveloppe focalisable par programme sans
        // l'insérer dans l'ordre de tabulation : elle ne devient une étape du
        // clavier ni avant ni après avoir reçu le focus.
        <div ref={noticeRef} tabIndex={-1}>
          <Notification tone={notice.tone} title={notice.title}>
            <p>{notice.body}</p>
          </Notification>
        </div>
      )}

      {!hydrated ? (
        <div className="spa-card spa-card--loading" aria-busy="true">
          <span className="spa-visually-hidden">Chargement de votre réservation…</span>
          <span className="spa-card__skeleton-line spa-card__skeleton-line--title" />
          <span className="spa-card__skeleton-line" />
          <span className="spa-card__skeleton-line spa-card__skeleton-line--short" />
        </div>
      ) : step === 'prestation' ? (
        <ServiceStep
          services={services}
          selectedServiceId={draft.serviceId}
          selectedStaffId={draft.staffId}
          onSubmit={chooseService}
        />
      ) : step === 'creneau' && selectedService !== null ? (
        <SlotStep
          tenant={tenant}
          service={selectedService}
          staffId={draft.staffId}
          onBack={() => {
            goTo('prestation');
          }}
          onStaffChange={chooseStaff}
          onChoose={chooseSlot}
        />
      ) : step === 'coordonnees' ? (
        <ContactStep
          contact={draft.contact}
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
          onBack={() => {
            goTo('coordonnees');
          }}
          onBooked={onBooked}
          onSlotLost={onSlotLost}
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

      {/* Dernier enfant du panneau, et c'est ce qui la rend collante : elle se
          pose au bas du panneau tant qu'il tient dans la fenêtre, et reste au
          bas de la fenêtre dès que l'étape déborde — l'étape « Créneau » et son
          calendrier, d'abord. */}
      {showSummary ? (
        <BookingSummaryBar tenant={tenant} service={selectedService} startsAt={draft.startsAt} />
      ) : null}
    </div>
  );
}
