'use client';

import {
  canRecordAppointmentOutcome,
  isAppointmentNotStartedRefusal,
  isOutcomeAppointmentStatus,
  type AppointmentStatus,
  type OutcomeAppointmentStatus,
} from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { deskStatusActions } from '@/lib/admin/appointment-desk';
import { appointmentStatusLabelInSentence } from '@/lib/appointment-status';
import { refusalMessage } from '@/lib/refusal';

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

/**
 * Ce que le refus d'un constat garde — un **motif**, jamais sa phrase (#1354).
 *
 * Il rangeait un texte : celui du catalogue pour les deux cas que cet écran
 * nomme lui-même, et `result.message` pour le reste. Le sélecteur de langue du
 * rail pose un cookie et laisse Next rejouer la route **sans navigation**
 * (`i18n/actions.ts`) : la ligne de rendez-vous n'est pas démontée, son état ne
 * bouge pas, et la phrase restait écrite dans la langue d'avant sous des boutons
 * qui, eux, suivaient le rendu.
 *
 * Deux formes, parce que les deux refus n'ont pas la même source : la clé de
 * catalogue quand cet écran dit mieux que le contrat — « attendez l'heure du
 * rendez-vous », « le serveur ne répond pas » —, et le **code** du refus pour
 * tout le reste, dont `refusalMessage` tire la phrase du contrat partagé.
 *
 * Le `message` de l'action ne remonte plus, et rien ne s'y perd : depuis #1234
 * il vaut déjà `errorMessage(code, locale)` (`action-result.ts`), c'est-à-dire
 * exactement ce que `refusalMessage` écrit — à ceci près qu'il le réécrit à
 * chaque rendu.
 */
type MarkFailure =
  | { readonly kind: 'key'; readonly key: 'actions.notStarted' | 'actions.serverSilent' }
  | { readonly kind: 'refusal'; readonly code: string };

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
 *
 * ## Un constat se confirme avant de s'écrire — #1409
 *
 * Les deux constats sont **terminaux** : `APPOINTMENT_STATUS_TRANSITIONS` ne
 * fait partir aucune transition de `completed` ni de `no_show`, et l'API refuse
 * tout retour en `INVALID_STATE_TRANSITION`. Ils étaient pourtant côte à côte, à
 * portée de pouce sur un téléphone, et s'appliquaient au premier appui : une
 * cliente honorée marquée absente ne se rattrapait pas — il fallait annuler puis
 * reposer le rendez-vous, ce que le cycle de vie refuse justement depuis un état
 * terminal.
 *
 * Le premier appui ne marque donc plus rien : il **pose la question**, en nommant
 * la cliente et l'heure du soin — « Marquer le rendez-vous de Rina Andriamena à
 * 10:05 non honoré ? Ce choix est définitif. » —, et remplace les deux gestes par
 * leurs réponses. C'est ce que web-frontend §5 exige d'une action destructive, et
 * c'est le montage que le tiroir du comptoir tient déjà pour l'annulation
 * (`appointment-panel.tsx`, #754), où le même ticket l'étend aux deux constats.
 *
 * Nommer la cliente et l'heure n'est pas de l'ornement : trois rendez-vous
 * dépliés posent trois questions identiques, et « Confirmer ? » ne dirait pas
 * laquelle on est en train de clore.
 *
 * **Confirmer, en revanche, reste en un appui** : `confirmed` n'est pas terminal
 * — le cycle de vie en laisse partir l'annulation comme les deux constats —, et
 * une question posée sur un geste réversible apprend à les expédier toutes.
 */
export function MyAppointmentActions({
  tenantSlug,
  appointmentId,
  status,
  startsAt,
  renderedAt,
  clientName,
  timeLabel,
}: {
  readonly tenantSlug: string;
  readonly appointmentId: string;
  readonly status: AppointmentStatus;
  /** L'heure **facturée** du soin, telle que l'API la rend. */
  readonly startsAt: string;
  /** L'instant du rendu serveur — la graine de l'horloge, voir `useAppointmentClock`. */
  readonly renderedAt?: string;
  /**
   * La cliente que la question nomme — « Rina Andriamena », le nom entier que la
   * ligne affiche déjà (`clientLabel`, #1404).
   */
  readonly clientName: string;
  /**
   * L'heure du soin **telle que la ligne l'écrit** — « 10:05 », « 10:05 AM » à
   * New York.
   *
   * Composée par la page serveur et non ici : c'est elle qui tient le fuseau de
   * l'établissement et la région d'affichage (`formatTimeInTimeZone`), et la
   * question doit citer l'heure que la praticienne a sous les yeux, à la minute
   * près. La recomposer dans le navigateur l'exposerait au fuseau du poste.
   */
  readonly timeLabel: string;
}) {
  const router = useRouter();
  const t = useTranslations('admin-my-planning');
  const locale = useLocale();
  const { renewIfExpired } = useAdminSessionRenewal(tenantSlug);
  const now = useAppointmentClock(renderedAt ?? null);
  const [pending, setPending] = useState<AppointmentStatus | null>(null);
  /** Le **motif** du refus, pas sa phrase (#1354) — voir `MarkFailure`. */
  const [error, setError] = useState<MarkFailure | null>(null);
  /**
   * Le constat dont la question est posée, ou `null` — premier temps de #1409.
   *
   * Le **statut visé** plutôt qu'un booléen : c'est lui que la question nomme et
   * que la réponse écrit, et deux constats partagent cet état sans qu'on puisse
   * les confondre.
   */
  const [confirming, setConfirming] = useState<OutcomeAppointmentStatus | null>(null);
  /**
   * Le constat dont on vient de **revenir**, ou `null` — ce qui reprend le focus.
   *
   * « Revenir » disparaît avec la question qu'il referme, et le focus retomberait
   * sur `document.body` : la tabulation repartirait du haut de la page, loin de la
   * ligne qu'on est en train de lire. Les deux gestes du premier temps sont
   * remontés à cet instant précis, si bien que leur `autoFocus` repose le focus
   * là où il était avant la question — sur le geste qu'on vient d'abandonner.
   */
  const [returned, setReturned] = useState<OutcomeAppointmentStatus | null>(null);
  // La question porte un identifiant : c'est par lui que le bouton qui prend le
  // focus l'annonce (`aria-describedby`), le libellé « Revenir » ne disant pas à
  // lui seul sur quoi l'on revient.
  const questionId = `${useId()}-question`;

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
          ? { kind: 'key', key: 'actions.notStarted' }
          : { kind: 'refusal', code: result.code },
      );
    } catch {
      setError({ kind: 'key', key: 'actions.serverSilent' });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="spa-my-appointment__actions">
      {confirming !== null ? (
        /* Le second temps du constat — #1409. Les deux gestes ont cédé la place
           à la question et à ses deux réponses : laisser « Marquer honoré » à
           côté de « Marquer non honoré » pendant qu'on répond à l'un des deux
           est exactement ce qui fait cliquer à côté, et c'est l'arbitrage que le
           pied du tiroir du comptoir tient déjà (#754). */
        <>
          <p className="spa-my-appointment__confirm" id={questionId}>
            {t('actions.markQuestion', {
              client: clientName,
              status: appointmentStatusLabelInSentence(confirming, locale),
              time: timeLabel,
            })}
          </p>
          <Button
            // Le bouton qu'on vient d'activer a disparu avec le premier temps :
            // sans reprise du focus, la tabulation repartirait du haut de la
            // page. Il va au geste **inoffensif** — un `Entrée` resté enfoncé ne
            // doit pas écrire le constat qu'on vient tout juste de questionner.
            autoFocus
            aria-describedby={questionId}
            disabled={pending !== null}
            onClick={() => {
              // Le geste qu'on abandonne reprendra le focus au rendu suivant :
              // sans cela, la tabulation repartirait du haut de la page.
              setReturned(confirming);
              setConfirming(null);
            }}
            variant="quiet"
          >
            {t('actions.markBack')}
          </Button>
          <Button
            // L'accent, et il est seul : pendant la question, la réponse est
            // l'action principale de la ligne (`styles/README.md`).
            loading={pending === confirming}
            loadingLabel={t('actions.saving')}
            onClick={() => void mark(confirming)}
            variant="accent"
          >
            {/* Le même libellé qu'au premier temps, au mot près : la réponse dit
                ce qu'elle fait, et un verbe de confirmation générique — « Oui »,
                « Confirmer » — obligerait à relire la question pour savoir
                lequel des deux constats on écrit. */}
            {t('actions.mark', {
              status: appointmentStatusLabelInSentence(confirming, locale),
            })}
          </Button>
        </>
      ) : (
        actions.map((action) => (
          <Button
            // Le geste dont on vient de refermer la question reprend le focus en
            // remontant — voir `returned`. `false` partout ailleurs : ces boutons
            // ne sont remontés qu'à ce moment-là, et jamais au premier rendu.
            autoFocus={returned === action.status}
            disabled={(pending !== null && pending !== action.status) || !recordable(action.status)}
            key={action.status}
            loading={pending === action.status}
            loadingLabel={t('actions.saving')}
            // Un constat ne s'écrit pas au premier appui : il se demande (#1409).
            // La confirmation n'est pas offerte à `confirmed`, qui n'est pas
            // terminal — voir l'en-tête de ce composant.
            onClick={() => {
              if (isOutcomeAppointmentStatus(action.status)) {
                setConfirming(action.status);
                return;
              }

              void mark(action.status);
            }}
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
        ))
      )}
      {!waiting ? null : <p className="spa-field__hint">{t('actions.notStarted')}</p>}
      {error === null ? null : (
        <p className="spa-field__error" role="alert">
          {/* La phrase est écrite ici, dans la langue de ce rendu (#1354). */}
          {error.kind === 'key' ? t(error.key) : refusalMessage(error, locale)}
        </p>
      )}
    </div>
  );
}
