'use client';

import {
  canRecordAppointmentOutcome,
  isAppointmentNotStartedRefusal,
  type AppointmentStatus,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { deskStatusActions } from '@/lib/admin/appointment-desk';
import { appointmentStatusLabelInSentence } from '@/lib/appointment-status';

import { markDeskAppointmentStatusAction } from '../calendrier/actions';
import { useAdminSessionRenewal } from './use-admin-session-renewal';
import { BEFORE_ANY_HOUR, useAppointmentClock } from './use-appointment-clock';

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
 * vérifie de son côté.
 *
 * ## « Honoré » et « non honoré » attendent l'heure du soin
 *
 * Cet écran le savait déjà, mais à sa façon : il recevait un booléen `started`
 * que la page serveur calculait sur place, quand le tiroir du comptoir, lui,
 * ne savait rien et offrait les deux gestes sur un rendez-vous du mois
 * prochain. Deux écrans, deux lectures, un seul contrat — la règle vient
 * désormais de `canRecordAppointmentOutcome` (`@spa/shared`), et les deux la
 * lisent (#1210).
 *
 * ## Inertes plutôt qu'absents
 *
 * Ils étaient filtrés, ils sont maintenant **désactivés avec leur motif** :
 * un bouton qui disparaît ne dit pas pourquoi, et la praticienne qui cherche
 * « Marquer honoré » sur le rendez-vous de 14 h à 13 h 50 conclurait que le
 * produit ne le lui propose pas. La même forme est retenue au comptoir, pour
 * que le même refus se dise du même côté du salon.
 */
export function MyAppointmentActions({
  tenantSlug,
  appointmentId,
  status,
  startsAt,
  renderedAt,
}: {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  readonly status: AppointmentStatus;
  /** L'heure **facturée** du soin, telle que l'API la rend. */
  readonly startsAt: string;
  /** L'instant du rendu serveur — la graine de l'horloge, voir `useAppointmentClock`. */
  readonly renderedAt?: string;
}) {
  const router = useRouter();
  const t = useTranslations('admin-my-planning');
  const locale = useLocale();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const now = useAppointmentClock(renderedAt ?? null);
  const [pending, setPending] = useState<AppointmentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actions = deskStatusActions(status);
  // `null` — l'horloge n'a pas encore parlé — vaut « antérieur à tout » : le
  // premier rendu ferme les constats plutôt que de les ouvrir.
  const recordable = (target: AppointmentStatus): boolean =>
    canRecordAppointmentOutcome(target, startsAt, now ?? BEFORE_ANY_HOUR);
  const waiting = now !== null && actions.some((action) => !recordable(action.status));

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
      // L'heure a pu passer entre le rendu et le clic, et l'horloge du poste
      // n'est pas celle du serveur : le refus dit alors d'attendre, et non de
      // recommencer (#1210).
      setError(
        isAppointmentNotStartedRefusal(result.code, result.details)
          ? t('actions.notStarted')
          : result.message,
      );
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
          disabled={(pending !== null && pending !== action.status) || !recordable(action.status)}
          key={action.status}
          loading={pending === action.status}
          loadingLabel={t('actions.saving')}
          onClick={() => void mark(action.status)}
          // Un bouton désactivé n'annonce pas son motif : le titre le porte à la
          // souris, et la ligne ci-dessous le dit à tout le monde.
          title={recordable(action.status) ? undefined : t('actions.notStartedHint')}
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
      {!waiting ? null : <p className="spa-field__hint">{t('actions.notStarted')}</p>}
      {error === null ? null : (
        <p className="spa-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
