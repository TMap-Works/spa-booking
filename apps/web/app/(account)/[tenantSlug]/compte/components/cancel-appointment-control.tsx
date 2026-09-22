'use client';

import type { BookedAppointment, TimeZone } from '@spa/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notification } from '@/components/ui/notification';
import { formatDateTimeInTimeZone } from '@/lib/format';

import { cancelOwnAppointmentAction } from '../actions';
import { accountPath } from '../paths';
import { useAccountAnnouncement } from './account-announcement';
import { useAccountDisplay } from './account-display-locale';
import { useAccountSessionRenewal } from './use-account-session-renewal';

/**
 * L'annulation d'un rendez-vous par la cliente, **en deux temps** — le seul
 * endroit de l'espace client où ce geste s'écrit (#1053).
 *
 * ## Pourquoi un composant à part
 *
 * Depuis #1053 le prochain rendez-vous est une carte héros et les suivants des
 * cartes compactes : deux habillages, un seul geste. Recopier l'état, la garde
 * anti-double-clic, l'annonce et le rafraîchissement dans les deux aurait été la
 * façon la plus sûre de les faire diverger — c'est exactement ce que
 * `lib/appointment-status.ts` a dû recoller ailleurs (#917).
 *
 * ## Les deux temps, et pourquoi ils ne se négocient pas
 *
 * Annuler est irréversible : `CANCELLED` est terminal et le créneau repart à la
 * vente dans la seconde. Le geste passe donc par une confirmation explicite
 * (web-frontend §5). Reporter, lui, mène à un écran de choix de créneau où rien
 * n'est validé tant qu'on n'a pas cliqué — la confirmation y est l'écran même.
 *
 * ## L'annulation aboutie s'annonce, et pas ici (#746)
 *
 * Le rafraîchissement qui suit fait quitter la liste « à venir » au rendez-vous,
 * et ce composant est démonté avec lui. Le message part donc vers la région
 * `aria-live` du gabarit (`account-announcement.tsx`), que `router.refresh()`
 * conserve.
 */
interface CancelAppointmentControlProps {
  readonly tenantSlug: string;
  readonly appointment: BookedAppointment;
  readonly timeZone: TimeZone;
  /**
   * `quiet` sur une carte compacte, `link` sur la carte héros — où « Annuler »
   * est un lien de danger sous deux actions en contour, et non un troisième
   * bouton qui se disputerait l'accent avec elles.
   */
  readonly tone?: 'quiet' | 'link';
  /** Ce que la page doit refaire une fois l'annulation aboutie. */
  readonly onCancelled: () => void;
}

export function CancelAppointmentControl({
  tenantSlug,
  appointment,
  timeZone,
  tone = 'quiet',
  onCancelled,
}: CancelAppointmentControlProps) {
  const t = useTranslations('account.cancel');
  const display = useAccountDisplay();
  const announce = useAccountAnnouncement();
  const { renewIfExpired } = useAccountSessionRenewal(tenantSlug);
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setCancelling(false);
      if (!renewIfExpired(result)) {
        setError(result.message);
      }
      return;
    }

    setConfirming(false);
    // L'annonce est posée **avant** le rafraîchissement, et c'est ce qui la rend
    // possible : la carte est sur le point de disparaître, et avec elle tout état
    // qu'elle porterait.
    announce({
      kind: 'appointment-cancelled',
      when: formatDateTimeInTimeZone(appointment.startsAt, timeZone, display),
      path: accountPath(tenantSlug),
    });
    onCancelled();
  };

  return (
    <>
      {error === null ? null : (
        <Notification tone="danger" title={t('failureTitle')}>
          <p>{error}</p>
        </Notification>
      )}

      {confirming ? (
        <>
          <p className="spa-appointment__confirm" role="alert">
            {t('confirm')}
          </p>
          <Button
            variant="danger"
            loading={cancelling}
            loadingLabel={t('loading')}
            onClick={() => void cancel()}
          >
            {t('confirmAction')}
          </Button>
          <Button variant="quiet" disabled={cancelling} onClick={() => setConfirming(false)}>
            {t('keep')}
          </Button>
        </>
      ) : (
        <span className={tone === 'link' ? 'spa-appointment__cancel' : undefined}>
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            {t('action')}
          </Button>
        </span>
      )}
    </>
  );
}
