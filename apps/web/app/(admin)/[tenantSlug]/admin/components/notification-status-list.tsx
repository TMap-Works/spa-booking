import type { Notification as NotificationTrace, TimeZone } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { formatDateTimeInTimeZone, type DisplayLocale } from '@/lib/format';

/**
 * Le statut d'envoi des messages d'un rendez-vous — cinquième critère
 * d'acceptation de #70, « le statut d'envoi est visible dans le back-office ».
 *
 * ## Pourquoi cet écran existe
 *
 * Sans lui, la seule trace d'une confirmation jamais partie est la cliente qui
 * ne vient pas. C'est ce que dit l'en-tête de
 * `packages/shared/src/schemas/notification.ts`, et c'est la raison pour
 * laquelle `attemptCount` et `failureReason` figurent au contrat : un SMS non
 * délivré doit être visible depuis l'écran du salon.
 *
 * ## Ce qu'il n'affiche pas
 *
 * **Ni destinataire, ni contenu.** L'API n'en rend pas — la table n'en porte pas
 * (CDC §5.1) — et l'écran n'a donc rien à cacher : il montre un statut, pas un
 * e-mail. Une personne au comptoir n'a pas besoin de relire le message pour
 * savoir s'il est parti.
 *
 * **Aucun bouton « renvoyer ».** La reprise d'un envoi échoué appartient à SQS
 * et à son backoff natif (notifications §4) ; un bouton au comptoir doublerait
 * la file et masquerait la profondeur de DLQ sur laquelle repose l'alarme de
 * supervision. Ce serait aussi promettre un geste que l'API ne sert pas.
 *
 * ## Le composant est un Server Component
 *
 * Aucun état, aucun effet, aucun écouteur : il reçoit des traces et rend du
 * balisage. Le `'use client'` du tiroir qui l'appelle l'emporte de fait dans le
 * bundle, mais ne pas le déclarer ici le laisse réutilisable tel quel depuis un
 * Server Component — la fiche cliente, le jour où l'API saura filtrer par
 * destinataire (web-frontend §1).
 */

/** Ce que l'écran sait rendre, en plus des traces elles-mêmes. */
interface NotificationStatusListProps {
  readonly notifications: readonly NotificationTrace[] | null;
  readonly timeZone: TimeZone;
  /** `true` tant que la lecture est en vol — l'état de chargement du composant. */
  readonly loading?: boolean;
  /** Le message d'échec de la lecture, s'il y en a eu un. */
  readonly failure?: string | null;
  /**
   * Le pays de l'établissement (#848) — la **région** des dates affichées.
   *
   * Facultatif : sans lui, le repli documenté de `lib/format.ts` s'applique. Il
   * ne touche jamais au fuseau, qui reste celui du salon.
   */
  readonly countryCode?: string | null;
}

/**
 * Les messages que la chaîne d'envoi porte, en clair.
 *
 * Depuis #800, un rendez-vous en laisse **deux** à la confirmation : « Réservation
 * enregistrée » part à la réservation — le rendez-vous est alors à confirmer par
 * le salon —, « Rendez-vous confirmé » quand le salon l'a confirmé. Le premier
 * s'appelait « Confirmation » quand il était seul, et le libellé aurait nommé
 * du même mot deux messages qui disent l'inverse l'un de l'autre.
 *
 * Les trois premiers sont ceux du CDC §1.4. Le quatrième est le lien de
 * réinitialisation d'un mot de passe (#809) : il n'annonce aucun rendez-vous,
 * mais il passe par la même chaîne et laisse donc une ligne dans ce journal —
 * c'est ce que l'écran doit savoir nommer.
 *
 * Les libellés vivent depuis #848 dans `admin-planning.notifications.types`, et
 * la **clé** du catalogue est le type de la trace. L'exhaustivité tenue ici par
 * `Record<NotificationTrace['type'], …>` ne s'y perd pas : le typage du
 * catalogue la rejoue, et un type de notification ajouté au contrat sans sa clé
 * fait échouer `tsc` plutôt que d'afficher une cellule vide au comptoir.
 */
type TraceLabelKey = `types.${NotificationTrace['type']}`;
type ChannelLabelKey = `channels.${NotificationTrace['channel']}`;
type StatusLabelKey = `statuses.${NotificationTrace['status']}`;

/**
 * Le modificateur de badge, repris des teintes existantes.
 *
 * `catalog-status-badge.tsx` pose la doctrine : réutiliser `--confirmed` et
 * `--cancelled` plutôt que d'ajouter des jetons, chaque nouvelle teinte devant
 * repasser le test de contraste (`apps/web/tests/contrast.test.mjs`). Le badge
 * **porte toujours son libellé** : la couleur seule ne porte jamais
 * l'information (WCAG 1.4.1).
 */
const STATUS_MODIFIERS: Readonly<Record<NotificationTrace['status'], string>> = {
  pending: 'pending',
  sent: 'confirmed',
  failed: 'cancelled',
};

export function NotificationStatusList({
  notifications,
  timeZone,
  loading = false,
  failure = null,
  countryCode = null,
}: NotificationStatusListProps) {
  const t = useTranslations('admin-planning');
  const display: DisplayLocale = { locale: useLocale(), countryCode };

  return (
    <section className="spa-admin-notifications">
      <h3 className="spa-admin-notifications__title">{t('notifications.title')}</h3>
      {body({ notifications, timeZone, loading, failure, display, t })}
    </section>
  );
}

/** Le traducteur du namespace, tel que `body` le reçoit. */
type PlanningTranslator = ReturnType<typeof useTranslations<'admin-planning'>>;

/**
 * Les quatre états que ce composant sait rendre — chargement, échec, vide,
 * peuplé.
 *
 * Un écran vide sans explication est un bug d'UX (web-frontend §6), et c'est
 * particulièrement vrai ici : « aucun message » et « la lecture a échoué » se
 * ressemblent beaucoup à l'écran, et ne veulent pas du tout dire la même chose
 * pour la personne qui a la cliente au téléphone.
 */
function body({
  notifications,
  timeZone,
  loading,
  failure,
  display,
  t,
}: {
  readonly notifications: readonly NotificationTrace[] | null;
  readonly timeZone: TimeZone;
  readonly loading: boolean;
  readonly failure: string | null;
  readonly display: DisplayLocale;
  readonly t: PlanningTranslator;
}) {
  if (loading) {
    return (
      <p className="spa-admin-notifications__empty" aria-live="polite">
        {t('notifications.loading')}
      </p>
    );
  }

  if (failure !== null) {
    return <p className="spa-admin-notifications__empty">{failure}</p>;
  }

  if (notifications === null || notifications.length === 0) {
    return <p className="spa-admin-notifications__empty">{t('notifications.empty')}</p>;
  }

  return (
    <ul className="spa-admin-notifications__list">
      {notifications.map((trace) => (
        <li key={trace.id} className="spa-admin-notifications__item">
          <span className="spa-admin-notifications__label">
            {t(`notifications.types.${trace.type}` satisfies `notifications.${TraceLabelKey}`)} ·{' '}
            {t(
              `notifications.channels.${trace.channel}` satisfies `notifications.${ChannelLabelKey}`,
            )}
          </span>
          <span className={`spa-admin-badge spa-admin-badge--${STATUS_MODIFIERS[trace.status]}`}>
            {t(
              `notifications.statuses.${trace.status}` satisfies `notifications.${StatusLabelKey}`,
            )}
          </span>
          <span className="spa-admin-notifications__moment">
            {moment(trace, timeZone, display, t)}
          </span>
          {trace.failureReason === undefined ? null : (
            <span className="spa-admin-notifications__reason">{trace.failureReason}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Quand le message est parti — ou, à défaut, quand il a été inscrit.
 *
 * **Dans le fuseau de l'établissement**, comme partout ailleurs dans ce
 * back-office : l'API rend des instants UTC suffixés `Z`, et les afficher tels
 * quels décalerait l'heure du salon de deux heures l'été à Paris. C'est le
 * quatrième critère de #70 tenu jusqu'au bout de la chaîne — il ne suffit pas
 * que l'e-mail porte la bonne heure si l'écran qui en rend compte porte la
 * mauvaise.
 *
 * Un envoi en attente n'a pas de `sentAt` : c'est alors sa création qu'on
 * affiche, en le disant. Mentir sur la nature de l'instant serait pire que de
 * n'en montrer aucun.
 */
function moment(
  trace: NotificationTrace,
  timeZone: TimeZone,
  display: DisplayLocale,
  t: PlanningTranslator,
): string {
  if (trace.sentAt !== undefined) {
    return t('notifications.sentAt', {
      moment: formatDateTimeInTimeZone(trace.sentAt, timeZone, display),
    });
  }

  return t('notifications.createdAt', {
    moment: formatDateTimeInTimeZone(trace.createdAt, timeZone, display),
  });
}
