'use client';

import { ERROR_CODES, type AvailabilityResponse, type TimeZone, type UtcInstant } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { SlotPicker } from '@/components/booking/slot-picker';
import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { formatDateTimeInTimeZone, timeZoneMention } from '@/lib/format';

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
 * ## Le sélecteur de créneau est celui du tunnel (#622)
 *
 * Il l'était par l'intention et pas par le code : cet écran dépliait les quinze
 * journées d'un coup, toutes leurs heures visibles, sans bande de journées ni
 * regroupement Matin / Après-midi / Soir. Mesuré à 360 px, cela faisait 4 960 px
 * de haut — six hauteurs d'écran — et le bouton de validation restait deux mille
 * pixels sous le créneau qu'on venait de choisir : rien à l'écran ne disait
 * comment poursuivre.
 *
 * C'est maintenant [`SlotPicker`](../../../../../components/booking/slot-picker.tsx),
 * le composant de l'étape 3 du tunnel, qui rend le choix : une bande de journées
 * compacte, puis la grille d'**une seule** journée. Le même geste se fait donc au
 * même endroit, au clavier comme à la souris, et une correction apportée à l'un
 * des deux écrans profite à l'autre.
 *
 * ## Le créneau actuel se montre, il ne se choisit pas (#442)
 *
 * Depuis que le calendrier écarte de son calcul le rendez-vous en cours de
 * déplacement, la liste contient les créneaux qui le **chevauchent** — c'est
 * l'objet du ticket : un soin d'une heure doit pouvoir bouger d'un quart
 * d'heure. Elle contient donc aussi, nécessairement, l'heure actuelle du
 * rendez-vous.
 *
 * Ce créneau-là est rendu, mais inerte, et porte le mot « actuel ». Le retirer
 * ferait un trou inexplicable dans la journée ; le laisser cliquable ferait
 * proposer « déplacer au samedi 14:00 » un rendez-vous déjà fixé au samedi
 * 14:00 — un aller-retour en base pour rien, et une phrase qui se contredit.
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
  const [chosen, setChosen] = useState<UtcInstant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null);

  const mention = timeZoneMention(timeZone);

  // Comparaison d'instants et non de chaînes : rien ne garantit que le
  // calendrier et l'historique écrivent le même moment avec la même précision,
  // et « …T14:00:00Z » ne s'égale pas à « …T14:00:00.000Z ».
  const currentInstant = Date.parse(currentStartsAt);
  const currentSlotNote = useCallback(
    (startsAt: UtcInstant): string | null =>
      Date.parse(startsAt) === currentInstant ? 'actuel' : null,
    [currentInstant],
  );

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

      <SlotPicker
        days={availability.days}
        timeZone={timeZone}
        headingId="report-creneaux-titre"
        selectedSlot={chosen}
        lockedSlotNote={currentSlotNote}
        busy={submitting}
        onChoose={setChosen}
        emptyState={
          <div className="spa-empty-state">
            <p className="spa-empty-state__title">Aucun créneau disponible</p>
            <p className="spa-empty-state__description">
              Le calendrier ne propose rien pour cette prestation dans les prochaines semaines.
              Contactez le salon pour convenir d’une autre date.
            </p>
          </div>
        }
      />

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
