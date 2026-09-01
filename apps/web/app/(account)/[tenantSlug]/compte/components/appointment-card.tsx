'use client';

import type { AppointmentScope, BookedAppointment, TimeZone } from '@spa/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { formatDateTimeInTimeZone, formatMoney, timeZoneMention } from '@/lib/format';

import { cancelOwnAppointmentAction } from '../actions';
import { accountPath } from '../paths';
import { appointmentBadge, isStillActionable } from './appointment-status';

/**
 * Une ligne d'historique, avec ses deux gestes : reporter et annuler (#47,
 * troisième critère).
 *
 * Client Component parce qu'il porte un état — le désarmement du bouton et le
 * message d'erreur — et **seulement pour cela** : la liste qui le contient reste
 * un Server Component, si bien qu'aucun jeton ni aucune donnée de session
 * n'entre dans le bundle du navigateur. Ce composant ne reçoit que le
 * rendez-vous et le fuseau du salon.
 *
 * ## L'annulation demande confirmation, le report non
 *
 * Annuler est irréversible : le statut `CANCELLED` est terminal, et le créneau
 * repart à la vente dans la seconde. Le geste passe donc par une confirmation
 * explicite (web-frontend §5). Reporter, lui, mène à un écran de choix de
 * créneau où plus rien n'est validé tant qu'on n'a pas cliqué — la confirmation
 * y est l'écran lui-même.
 *
 * ## Les gestes dépendent de la moitié, pas seulement du statut
 *
 * `isStillActionable` ne regarde que le statut, et cela ne suffit pas : un
 * rendez-vous d'hier que le salon n'a pas encore marqué « honoré » reste
 * `confirmed`, et le serveur le range — à raison — dans l'historique. Y offrir
 * les deux gestes serait faux des deux côtés : « Reporter » mène à un écran qui
 * cherche le rendez-vous dans la moitié « à venir » et rend 404, et « Annuler »
 * **aboutit** — `confirmed → cancelled` est une transition licite —, faisant
 * passer pour annulée une visite qui a bien eu lieu, et faussant le comptage des
 * visites honorées du CDC §1.4. La moitié d'où vient la ligne est donc passée
 * explicitement, et c'est elle qui commande.
 */
interface AppointmentCardProps {
  readonly tenantSlug: string;
  readonly appointment: BookedAppointment;
  readonly timeZone: TimeZone;
  /** Le nom de la prestation, quand le catalogue a pu le rendre. */
  readonly serviceName: string | null;
  /** La moitié d'historique d'où vient cette ligne — voir l'en-tête. */
  readonly scope: AppointmentScope;
}

export function AppointmentCard({
  tenantSlug,
  appointment,
  timeZone,
  serviceName,
  scope,
}: AppointmentCardProps) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge = appointmentBadge(appointment);
  const actionable = scope === 'upcoming' && isStillActionable(appointment);
  const mention = timeZoneMention(timeZone);

  const cancel = async (): Promise<void> => {
    // La garde en tête du gestionnaire double le `disabled` du bouton : entre le
    // clic et le rendu suivant, React laisse passer un second événement
    // (web-frontend §3).
    if (cancelling) {
      return;
    }

    setCancelling(true);
    setError(null);

    const result = await cancelOwnAppointmentAction(tenantSlug, appointment.id);

    if (!result.ok) {
      setError(result.message);
      setCancelling(false);
      return;
    }

    setConfirming(false);
    // La liste est rendue côté serveur : c'est elle qu'il faut refaire, pas un
    // état local à recoller. Le rendez-vous annulé bascule alors de lui-même de
    // « à venir » vers l'historique.
    router.refresh();
  };

  return (
    <li className="spa-appointment">
      <div className="spa-appointment__heading">
        <p className="spa-appointment__when">
          {formatDateTimeInTimeZone(appointment.startsAt, timeZone)}
          {mention === null ? null : (
            <span className="spa-appointment__timezone"> ({mention})</span>
          )}
        </p>
        <span className={`spa-appointment__badge spa-appointment__badge--${badge.tone}`}>
          {badge.label}
        </span>
      </div>

      <p className="spa-appointment__service">
        {serviceName ?? 'Prestation'}
        <span className="spa-appointment__price"> · {formatMoney(appointment.price)}</span>
      </p>

      {appointment.clientNote === null || appointment.clientNote === '' ? null : (
        <p className="spa-appointment__note">« {appointment.clientNote} »</p>
      )}

      {error === null ? null : (
        <Notification tone="danger" title="L’annulation n’a pas abouti">
          <p>{error}</p>
        </Notification>
      )}

      {!actionable ? null : (
        <div className="spa-appointment__actions">
          <Link
            className="spa-button spa-button--neutral"
            href={accountPath(tenantSlug, `/rendez-vous/${appointment.id}/report`)}
          >
            <span className="spa-button__label">Reporter</span>
          </Link>

          {confirming ? (
            <>
              <p className="spa-appointment__confirm" role="alert">
                Annuler ce rendez-vous ? Le créneau repart immédiatement à la réservation.
              </p>
              <Button
                variant="danger"
                loading={cancelling}
                loadingLabel="Annulation en cours…"
                onClick={() => void cancel()}
              >
                Confirmer l’annulation
              </Button>
              <Button variant="quiet" disabled={cancelling} onClick={() => setConfirming(false)}>
                Garder ce rendez-vous
              </Button>
            </>
          ) : (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              Annuler
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
