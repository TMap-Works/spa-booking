'use client';

import type { BookedAppointment, PublicService, PublicTenant } from '@spa/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import type { ContactDraft } from '@/lib/booking/draft';

import { cancelAppointmentAction } from '../actions';

import { Recap } from './recap';

interface ConfirmationStepProps {
  readonly tenant: PublicTenant;
  /** `null` si la prestation a quitté le catalogue depuis la réservation. */
  readonly service: PublicService | null;
  readonly appointment: BookedAppointment;
  readonly contact: ContactDraft;
  readonly onCancelled: (appointment: BookedAppointment) => void;
  readonly onRestart: () => void;
}

/**
 * Écran de confirmation — cinquième critère d'acceptation de #45 : récapitulatif
 * et lien d'annulation.
 *
 * ## L'annulation demande une confirmation
 *
 * Le geste est destructif et la fenêtre d'annulation d'un salon peut être
 * courte : un clic malheureux ne doit pas coûter le rendez-vous. La confirmation
 * est posée en ligne plutôt qu'en modale — elle tient en deux boutons, et une
 * `<dialog>` déplacerait le focus pour une question à laquelle la réponse est
 * juste au-dessous.
 *
 * ## Ce que cet écran n'est pas
 *
 * Il vit dans l'onglet de la réservation : c'est `sessionStorage` qui le fait
 * survivre à un rafraîchissement, pas une adresse. Le lien d'annulation
 * **durable**, celui qui part dans l'e-mail de confirmation et fonctionne des
 * jours plus tard, relève de la chaîne de notifications et de son ticket.
 */
export function ConfirmationStep({
  tenant,
  service,
  appointment,
  contact,
  onCancelled,
  onRestart,
}: ConfirmationStepProps) {
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCancelled = appointment.status === 'cancelled';
  const staffName =
    service?.staff.find((member) => member.id === appointment.staffId)?.displayName ?? null;

  const cancel = async () => {
    if (cancelling) {
      return;
    }

    setCancelling(true);
    setError(null);

    const result = await cancelAppointmentAction(tenant.slug, appointment.id);

    if (result.ok) {
      onCancelled(result.data);
      setConfirmingCancellation(false);
    } else {
      setError(result.message);
    }

    setCancelling(false);
  };

  return (
    <section aria-label="Confirmation de votre réservation">
      {isCancelled ? (
        <Notification tone="info" title="Votre rendez-vous est annulé">
          <p>
            Il ne figure plus à l’agenda du salon. Vous pouvez en prendre un nouveau quand vous le
            souhaitez.
          </p>
        </Notification>
      ) : (
        <Notification tone="success" title="Votre rendez-vous est enregistré">
          <p>
            Un e-mail de confirmation part vers {contact.email}. Conservez cette page : c’est d’ici
            que vous pouvez annuler.
          </p>
        </Notification>
      )}

      <Recap
        tenant={tenant}
        serviceName={service?.name ?? null}
        staffName={staffName}
        startsAt={appointment.startsAt}
        price={appointment.price}
        contact={contact}
      />

      <p className="spa-card__meta">Référence : {appointment.id}</p>

      {error === null ? null : (
        <Notification tone="danger" title="L’annulation n’a pas abouti">
          <p>{error}</p>
        </Notification>
      )}

      <div className="spa-card__footer">
        {isCancelled ? (
          <Button variant="accent" onClick={onRestart}>
            Prendre un nouveau rendez-vous
          </Button>
        ) : confirmingCancellation ? (
          <>
            <Button
              variant="danger"
              loading={cancelling}
              loadingLabel="Annulation en cours…"
              onClick={() => {
                void cancel();
              }}
            >
              Confirmer l’annulation
            </Button>
            <Button
              variant="quiet"
              disabled={cancelling}
              onClick={() => {
                setConfirmingCancellation(false);
              }}
            >
              Garder mon rendez-vous
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            onClick={() => {
              setError(null);
              setConfirmingCancellation(true);
            }}
          >
            Annuler ce rendez-vous
          </Button>
        )}
      </div>
    </section>
  );
}
