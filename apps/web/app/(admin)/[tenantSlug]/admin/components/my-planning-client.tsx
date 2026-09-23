'use client';

import type { AppointmentStatus } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { deskStatusActions } from '@/lib/admin/appointment-desk';
import { appointmentStatusLabelInSentence } from '@/lib/appointment-status';

import { markDeskAppointmentStatusAction } from '../calendrier/actions';
import { useAdminSessionRenewal } from './use-admin-session-renewal';

/**
 * Les deux morceaux interactifs de « Mon planning » (#813) — le reste de
 * l'écran est rendu par le serveur.
 *
 * Leurs mots viennent du namespace `admin-my-planning` (#1104), à une exception
 * près : le **statut** inséré dans « Marquer honoré » est lu dans
 * `lib/appointment-status.ts`, seul endroit du front où ce vocabulaire s'écrit.
 * C'est exactement le montage du tiroir de rendez-vous du planning du salon
 * (`appointment-panel.tsx`, #917) — le verbe appartient à l'écran, le statut au
 * module de vocabulaire.
 */

/** Le rafraîchissement de l'écran : toutes les minutes, et au retour sur l'onglet. */
export const MY_PLANNING_REFRESH_MS = 60_000;

/**
 * Relit l'emploi du temps toutes les minutes et au retour sur l'onglet —
 * sixième critère de #813, « comme dans le tunnel ».
 *
 * Une praticienne garde l'écran ouvert sur son téléphone entre deux soins : une
 * réservation prise en ligne pendant ce temps doit y apparaître sans qu'elle ait
 * à recharger. Rien ne part tant que l'onglet est caché — un téléphone en poche
 * n'a pas à interroger le serveur.
 */
export function MyPlanningAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    };
    const timer = window.setInterval(refresh, MY_PLANNING_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router]);

  return null;
}

/**
 * Les gestes qu'un praticien peut faire sur **son** rendez-vous : le
 * confirmer, le dire honoré ou non honoré.
 *
 * Ce sont ceux du planning du salon (`deskStatusActions`), bornés par ce que la
 * matrice de #812 ouvre au praticien — `appointment:write:own`, que l'API
 * vérifie de son côté. « Honoré » et « non honoré » n'ont de sens qu'une fois
 * le rendez-vous commencé : ils ne sont pas proposés avant.
 */
export function MyAppointmentActions({
  tenantSlug,
  appointmentId,
  status,
  started,
}: {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  readonly status: AppointmentStatus;
  readonly started: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('admin-my-planning');
  const locale = useLocale();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const [pending, setPending] = useState<AppointmentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actions = deskStatusActions(status).filter(
    (action) => action.status === 'confirmed' || started,
  );

  if (actions.length === 0) {
    return null;
  }

  const mark = async (target: AppointmentStatus): Promise<void> => {
    setPending(target);
    setError(null);
    try {
      const result = await markDeskAppointmentStatusAction(tenantSlug, appointmentId, {
        status: target,
      });
      if (result.ok) {
        router.refresh();
        return;
      }
      if (renewIfExpired(result)) {
        return;
      }
      setError(result.message);
    } catch {
      setError(t('actions.serverSilent'));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="spa-my-appointment__actions">
      {actions.map((action) => (
        <Button
          disabled={pending !== null && pending !== action.status}
          key={action.status}
          loading={pending === action.status}
          loadingLabel={t('actions.saving')}
          onClick={() => void mark(action.status)}
          variant={action.variant}
        >
          {/* Le verbe appartient à l'écran, le statut au module de vocabulaire :
              « Confirmer le rendez-vous » nomme un acte, « Marquer honoré »
              constate ce qui a eu lieu au salon (#917). */}
          {action.status === 'confirmed'
            ? t('actions.confirm')
            : t('actions.mark', {
                status: appointmentStatusLabelInSentence(action.status, locale),
              })}
        </Button>
      ))}
      {error === null ? null : (
        <p className="spa-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
