'use client';

import type { BookedAppointment, PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Notification, type NotificationTone } from '@/components/ui/notification';
import {
  BOOKING_STEPS,
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
 * Le tunnel de réservation (#45) — prestation, créneau, coordonnées,
 * récapitulatif, confirmation.
 *
 * Client Component, parce qu'il porte l'état du parcours ; il est monté par un
 * Server Component qui a déjà rendu la vitrine et le catalogue. Le `"use
 * client"` est donc **ici** et pas sur la page : le placer plus haut ferait
 * basculer toute la page côté client et coûterait le référencement de la
 * surface qui génère le revenu (skill web-frontend §1).
 *
 * L'état vit dans `sessionStorage` — voir `lib/booking/draft.ts` pour le
 * pourquoi. Le composant se contente de le relire au montage et de le réécrire à
 * chaque changement.
 */
export function BookingTunnel({ tenant, services }: BookingTunnelProps) {
  const [draft, setDraft] = useState<BookingDraft>(emptyBookingDraft);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);

  // Relecture du brouillon. `sessionStorage` n'existe pas au rendu serveur :
  // l'état de départ est donc toujours vierge, et l'étape réelle n'apparaît
  // qu'après le montage — d'où l'écran d'attente ci-dessous plutôt qu'un
  // affichage de la première étape qui sauterait aussitôt à la bonne.
  useEffect(() => {
    const stored = readBookingDraft(tenant.slug);

    setDraft({ ...stored, step: reachableStep(stored) });
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
    setDraft((current) => ({ ...current, appointment }));
  }, []);

  const restart = useCallback(() => {
    setNotice(null);
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

  return (
    <main className="spa-card">
      <h1 className="spa-card__title">Réserver chez {tenant.name}</h1>
      {zoneMention === null ? null : (
        <p className="spa-card__meta">Tous les horaires sont affichés en {zoneMention}.</p>
      )}

      <ol className="spa-card__meta" aria-label="Étapes de la réservation">
        {BOOKING_STEPS.map((name, index) => (
          <li key={name} aria-current={name === step ? 'step' : undefined}>
            {STEP_LABELS[name]}
            {/* Séparateur visuel, masqué à l'arbre d'accessibilité : la liste
                ordonnée dit déjà la séquence, un lecteur d'écran n'a pas à
                entendre un point médian entre chaque étape. Il est posé en fin
                d'élément et non en tête, pour tomber avant la puce numérotée du
                suivant plutôt qu'après elle. */}
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
          onCancelled={onCancelled}
          onRestart={restart}
        />
      ) : null}
    </main>
  );
}
