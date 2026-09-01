'use client';

import { ERROR_CODES, type AvailabilityResponse, type TimeZone } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import {
  formatCalendarDate,
  formatDateTimeInTimeZone,
  formatTimeInTimeZone,
  timeZoneMention,
} from '@/lib/format';

import { rescheduleOwnAppointmentAction } from '../actions';
import { accountPath } from '../paths';

/**
 * Choix d'un nouveau créneau pour un rendez-vous existant (#47, troisième
 * critère).
 *
 * ## Ce que cet écran ne refait pas
 *
 * Le tunnel de réservation. Reporter ne change ni la prestation, ni le
 * praticien, ni le prix — l'API le refuse explicitement
 * (`rescheduleAppointmentRequestSchema` ne porte que l'instant et, au plus, un
 * praticien). Il n'y a donc qu'un choix à faire, et l'écran ne montre que
 * celui-là : les créneaux que le calendrier propose pour **cette** prestation
 * chez **ce** praticien.
 *
 * ## Le 409 n'est pas une erreur exceptionnelle
 *
 * Entre l'affichage et le clic, le créneau a pu être pris. C'est un cas normal
 * sous concurrence (web-frontend §3) : l'écran le dit, recharge les créneaux, et
 * ne perd rien de ce que la visiteuse avait déjà choisi — le rendez-vous
 * d'origine est intact, le report ayant échoué en bloc.
 */
interface RescheduleFormProps {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  /** L'instant actuel du rendez-vous, pour que la visiteuse sache ce qu'elle déplace. */
  readonly currentStartsAt: string;
  readonly serviceName: string | null;
  readonly availability: AvailabilityResponse;
  readonly timeZone: TimeZone;
}

export function RescheduleForm({
  tenantSlug,
  appointmentId,
  currentStartsAt,
  serviceName,
  availability,
  timeZone,
}: RescheduleFormProps) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);

  const mention = timeZoneMention(timeZone);
  const openDays = availability.days.filter((day) => day.slots.length > 0);

  const confirm = async (): Promise<void> => {
    // Deux verrous : celui-ci et le `disabled` du bouton. Un double clic ne doit
    // jamais produire deux reports — le second déplacerait un rendez-vous que le
    // premier vient déjà de remplacer.
    if (submitting || chosen === null) {
      return;
    }

    setSubmitting(true);
    setFailure(null);

    const result = await rescheduleOwnAppointmentAction(tenantSlug, appointmentId, {
      startsAt: chosen,
    });

    if (!result.ok) {
      if (result.code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE) {
        setFailure({
          title: 'Ce créneau vient d’être pris',
          message:
            'Votre rendez-vous n’a pas bougé. Choisissez un autre créneau dans la liste remise à jour.',
        });
        setChosen(null);
        setSubmitting(false);
        // Recharger la page serveur : c'est elle qui lit les créneaux.
        router.refresh();
        return;
      }

      setFailure({ title: 'Le report n’a pas abouti', message: result.message });
      setSubmitting(false);
      return;
    }

    router.replace(accountPath(tenantSlug));
    router.refresh();
  };

  return (
    <section className="spa-account__panel" aria-labelledby="report-titre">
      <h2 className="spa-account__section-title" id="report-titre">
        Reporter mon rendez-vous
      </h2>

      <p className="spa-account__lead">
        {serviceName ?? 'Votre prestation'} — actuellement le{' '}
        <strong>{formatDateTimeInTimeZone(currentStartsAt, timeZone)}</strong>
        {mention === null ? null : <span className="spa-appointment__timezone"> ({mention})</span>}.
      </p>

      {failure === null ? null : (
        <Notification tone="warning" title={failure.title}>
          <p>{failure.message}</p>
        </Notification>
      )}

      {openDays.length === 0 ? (
        <div className="spa-empty-state">
          <p className="spa-empty-state__title">Aucun créneau disponible</p>
          <p className="spa-empty-state__description">
            Le calendrier ne propose rien pour cette prestation dans les prochaines semaines.
            Contactez le salon pour convenir d’une autre date.
          </p>
        </div>
      ) : (
        <div className="spa-reschedule">
          {openDays.map((day) => (
            <div className="spa-reschedule__day" key={day.date}>
              <h3 className="spa-reschedule__date">{formatCalendarDate(day.date)}</h3>
              <ul className="spa-reschedule__slots">
                {day.slots.map((slot) => (
                  <li key={slot.startsAt}>
                    <button
                      type="button"
                      className={`spa-reschedule__slot${
                        chosen === slot.startsAt ? ' spa-reschedule__slot--chosen' : ''
                      }`}
                      aria-pressed={chosen === slot.startsAt}
                      disabled={submitting}
                      onClick={() => setChosen(slot.startsAt)}
                    >
                      {formatTimeInTimeZone(slot.startsAt, timeZone)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="spa-account__actions">
        <Button
          variant="accent"
          disabled={chosen === null}
          loading={submitting}
          loadingLabel="Report en cours…"
          onClick={() => void confirm()}
        >
          {chosen === null
            ? 'Choisissez un créneau'
            : `Déplacer au ${formatDateTimeInTimeZone(chosen, timeZone)}`}
        </Button>
        <Link className="spa-account__nav-link" href={accountPath(tenantSlug)}>
          Renoncer au report
        </Link>
      </div>
    </section>
  );
}
