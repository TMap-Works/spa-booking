'use client';

import {
  ERROR_CODES,
  type BookedAppointment,
  type PublicService,
  type PublicTenant,
  type UtcInstant,
} from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { bookAppointmentAction } from '../actions';

import { Recap } from './recap';

interface SummaryStepProps {
  readonly tenant: PublicTenant;
  readonly service: PublicService;
  readonly staffId: string | null;
  readonly startsAt: UtcInstant;
  readonly contact: ContactDraft;
  readonly onBack: () => void;
  readonly onBooked: (appointment: BookedAppointment) => void;
  readonly onSlotLost: (message: string) => void;
}

/**
 * Récapitulatif et validation — quatrième critère d'acceptation de #45.
 *
 * ## Le bouton se désactive dès le premier clic
 *
 * Deux verrous, et les deux sont nécessaires :
 *
 * - `Button` pose `disabled` dès que `loading` l'est, ce qui écarte le second
 *   clic ;
 * - la garde `if (submitting) return` en tête du gestionnaire écarte l'appel
 *   qu'un clavier ou un script pourrait déclencher entre le clic et le rendu qui
 *   désactive le bouton. Sans elle, le `disabled` n'est qu'une protection
 *   d'affichage — React ne réagit pas avant la fin du gestionnaire en cours.
 *
 * Un double clic ne doit jamais produire deux réservations (skill web-frontend
 * §3).
 */
export function SummaryStep({
  tenant,
  service,
  staffId,
  startsAt,
  contact,
  onBack,
  onBooked,
  onSlotLost,
}: SummaryStepProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffName = service.staff.find((member) => member.id === staffId)?.displayName ?? null;

  const confirm = async () => {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);

    const result = await bookAppointmentAction(tenant.slug, {
      serviceId: service.id,
      ...(staffId === null ? {} : { staffId }),
      startsAt,
      client: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        ...(contact.phone === '' ? {} : { phone: contact.phone }),
      },
      ...(contact.clientNote === '' ? {} : { clientNote: contact.clientNote }),
    });

    if (result.ok) {
      onBooked(result.data);

      return;
    }

    // Le créneau parti pendant la saisie n'est pas une panne : c'est le cas
    // normal sous concurrence, et il se traite par un retour au calendrier.
    if (result.code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
      onSlotLost(result.message);

      return;
    }

    setError(result.message);
    // Le bouton se réarme : l'erreur est peut-être passagère, et la cliente doit
    // pouvoir réessayer sans recharger la page.
    setSubmitting(false);
  };

  return (
    <section aria-label="Récapitulatif de votre réservation">
      <h2 className="spa-card__title">Vérifiez votre réservation</h2>

      {error === null ? null : (
        <Notification tone="danger" title="La réservation n’a pas abouti">
          <p>{error}</p>
        </Notification>
      )}

      <Recap
        tenant={tenant}
        serviceName={service.name}
        staffName={staffName}
        startsAt={startsAt}
        price={service.price}
        contact={contact}
      />

      <div className="spa-card__footer">
        <Button variant="quiet" onClick={onBack} disabled={submitting}>
          Corriger mes coordonnées
        </Button>
        <Button
          variant="accent"
          loading={submitting}
          loadingLabel="Réservation en cours…"
          onClick={() => {
            void confirm();
          }}
        >
          Confirmer la réservation
        </Button>
      </div>
    </section>
  );
}
