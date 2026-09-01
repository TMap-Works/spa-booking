'use client';

import type { BookedAppointment, PublicService, PublicTenant, UtcInstant } from '@spa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
import { timeZoneMention } from '@/lib/format';

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
   * Le créneau a été pris pendant que la cliente saisissait ses coordonnées.
   *
   * Ce n'est pas une erreur exceptionnelle, c'est le cas normal sous
   * concurrence (skill web-frontend §3) : on la ramène au choix du créneau **en
   * conservant tout le reste**, et on le lui dit.
   */
  const onSlotLost = useCallback((message: string) => {
    setNotice({
      tone: 'warning',
      title: 'Ce créneau vient d’être réservé',
      body: `${message} Vos coordonnées sont conservées : choisissez un autre horaire.`,
    });
    setDraft((current) => ({ ...current, startsAt: null, step: 'creneau' }));
  }, []);

  const onCancelled = useCallback((appointment: BookedAppointment) => {
    setNotice(null);
    setDraft((current) => ({ ...current, appointment }));
  }, []);

  const restart = useCallback(() => {
    setNotice(null);
    setDraft(emptyBookingDraft());
  }, []);

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
        <Notification tone={notice.tone} title={notice.title}>
          <p>{notice.body}</p>
        </Notification>
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
