import { Notification } from '@/components/ui/notification';
import { ApiClientError } from '@/lib/api-client';

/**
 * Encart d'erreur des pages du parcours client public (#601).
 *
 * ## La règle tranchée : le message porte son invitation, l'écran n'ajoute rien
 *
 * « Merci de réessayer dans un instant. » pouvait vivre à deux endroits — dans
 * le message d'erreur, ou concaténée par l'écran qui l'affiche. Les deux se
 * défendent ; ce qui ne se défend pas, c'est de mélanger les deux, et c'est ce
 * qui produisait le défaut : `api-client.ts` écrit un message qui **porte déjà**
 * l'invitation, et les deux pages `(booking)` lui en ajoutaient une seconde.
 *
 * Le dépôt applique donc **une seule** des deux conventions, celle-ci : *un
 * message d'erreur est une phrase complète, prête à afficher ; aucune surface de
 * rendu n'y concatène quoi que ce soit.* Trois raisons :
 *
 * - c'est déjà la convention du reste de `apps/web` — `admin/action-result.ts`,
 *   `(account)/…/compte/actions.ts`, `reservation/actions.ts`,
 *   `admin/reporting/actions.ts` et `lib/admin/checkout-summary.ts` écrivent
 *   tous des messages complets, que leurs écrans affichent tels quels. Les deux
 *   pages `(booking)` en étaient les seules exceptions ;
 * - une phrase complète **là où elle est écrite** s'affiche partout sans que
 *   chaque écran ait à se souvenir d'un suffixe. La convention inverse fait de
 *   chaque nouvel écran une occasion de l'oublier — ou de la doubler sur un
 *   message qui la portait déjà ;
 * - l'objection sérieuse à ce choix — « réessayer » n'a pas de sens dans un
 *   journal ou une remontée d'erreur — ne mord pas ici : `ApiClientError` porte
 *   `code`, `status` et `details.cause` précisément pour que la journalisation
 *   s'appuie sur eux et non sur la phrase destinée au visiteur (skill
 *   web-frontend §2 : « les composants réagissent sur `code`, jamais sur
 *   `message` »).
 *
 * Le corollaire vaut pour le repli : une erreur qui n'est pas une
 * `ApiClientError` n'a pas de message affichable, et celui qu'on lui substitue
 * porte donc **lui aussi** son invitation — sans quoi la règle rendrait un
 * écran sans issue proposée.
 */

/**
 * Repli quand l'erreur n'est pas une `ApiClientError` — une panne du rendu, un
 * `TypeError`, tout ce dont on ne sait rien. Phrase complète, invitation
 * comprise, comme n'importe quel message d'erreur du dépôt.
 */
const UNEXPECTED_ERROR_MESSAGE =
  'Une erreur inattendue est survenue. Merci de réessayer dans un instant.';

/**
 * Phrase à montrer au visiteur pour une erreur quelconque du parcours client.
 *
 * Exportée pour être éprouvée seule, et pour qu'un écran à venir trouve la règle
 * plutôt que de la réinventer.
 */
export function visitorErrorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE;
}

interface BookingErrorNoticeProps {
  /** Ce qui n'a pas pu être chargé, du point de vue du visiteur. */
  readonly title: string;
  /** L'erreur remontée par le chargement — `ApiClientError` ou non. */
  readonly error: unknown;
}

/**
 * L'encart rouge des pages `(booking)`, rendu au même endroit pour toutes.
 *
 * Server Component : il n'a ni état ni écouteur, et les pages qui l'emploient
 * sont elles-mêmes rendues côté serveur (skill web-frontend §1).
 */
export function BookingErrorNotice({ title, error }: BookingErrorNoticeProps) {
  return (
    <Notification tone="danger" title={title}>
      <p>{visitorErrorMessage(error)}</p>
    </Notification>
  );
}
