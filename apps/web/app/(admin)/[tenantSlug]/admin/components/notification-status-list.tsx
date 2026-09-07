import type { Notification as NotificationTrace, TimeZone } from '@spa/shared';

import { formatDateTimeInTimeZone } from '@/lib/format';

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
}

/**
 * Les trois messages du MVP, en clair. CDC §1.4 — il n'y en a pas d'autres, et
 * l'objet indexé se refuse à en inventer un.
 */
const TYPE_LABELS: Readonly<Record<NotificationTrace['type'], string>> = {
  booking_confirmation: 'Confirmation',
  reminder_24h: 'Rappel J-1',
  cancellation: 'Avis d’annulation',
};

const CHANNEL_LABELS: Readonly<Record<NotificationTrace['channel'], string>> = {
  email: 'E-mail',
  sms: 'SMS',
};

const STATUS_LABELS: Readonly<Record<NotificationTrace['status'], string>> = {
  pending: 'En attente',
  sent: 'Envoyé',
  failed: 'Échec',
};

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
}: NotificationStatusListProps) {
  return (
    <section className="spa-admin-notifications">
      <h3 className="spa-admin-notifications__title">Messages envoyés</h3>
      {body({ notifications, timeZone, loading, failure })}
    </section>
  );
}

/**
 * Les quatre états que ce composant sait rendre — chargement, échec, vide,
 * peuplé.
 *
 * Un écran vide sans explication est un bug d'UX (web-frontend §6), et c'est
 * particulièrement vrai ici : « aucun message » et « la lecture a échoué » se
 * ressemblent beaucoup à l'écran, et ne veulent pas du tout dire la même chose
 * pour la personne qui a la cliente au téléphone.
 */
function body({ notifications, timeZone, loading, failure }: Required<NotificationStatusListProps>) {
  if (loading) {
    return (
      <p className="spa-admin-notifications__empty" aria-live="polite">
        Lecture du journal d’envois…
      </p>
    );
  }

  if (failure !== null) {
    return <p className="spa-admin-notifications__empty">{failure}</p>;
  }

  if (notifications === null || notifications.length === 0) {
    return (
      <p className="spa-admin-notifications__empty">
        Aucun message n’a encore été émis pour ce rendez-vous.
      </p>
    );
  }

  return (
    <ul className="spa-admin-notifications__list">
      {notifications.map((trace) => (
        <li key={trace.id} className="spa-admin-notifications__item">
          <span className="spa-admin-notifications__label">
            {TYPE_LABELS[trace.type]} · {CHANNEL_LABELS[trace.channel]}
          </span>
          <span className={`spa-admin-badge spa-admin-badge--${STATUS_MODIFIERS[trace.status]}`}>
            {STATUS_LABELS[trace.status]}
          </span>
          <span className="spa-admin-notifications__moment">{moment(trace, timeZone)}</span>
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
function moment(trace: NotificationTrace, timeZone: TimeZone): string {
  if (trace.sentAt !== undefined) {
    return `Envoyé le ${formatDateTimeInTimeZone(trace.sentAt, timeZone)}`;
  }

  return `Inscrit le ${formatDateTimeInTimeZone(trace.createdAt, timeZone)}`;
}
