import { ERROR_CODES, errorMessage, type Locale } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

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
 *
 * ## La langue (#846)
 *
 * La règle de #601 vaut toujours — *une phrase complète, l'écran n'y concatène
 * rien* —, mais ce n'est plus la **frontière d'API** qui l'écrit : les phrases
 * de `lib/api-client.ts` et celles que l'API sert sont en français, et cet
 * encart s'affiche aussi en anglais. Ce qui est traduit ici est donc le **code**
 * de l'erreur, jamais son message, ce qui est exactement la convention du dépôt
 * (skill web-frontend §2 : « les composants réagissent sur `code`, jamais sur
 * `message` »).
 *
 * Trois branches, dans cet ordre :
 *
 * - l'API **injoignable** (`SERVICE_UNAVAILABLE`) est la seule panne que le
 *   parcours nomme lui-même, parce qu'il la nomme mieux : « le service **de
 *   réservation** est momentanément injoignable » dit à la visiteuse d'une
 *   vitrine de salon de quoi il s'agit, là où la phrase générique du contrat
 *   parle d'« un service » qu'elle n'a pas demandé ;
 * - tout autre **refus nommé par l'API** passe par `errorMessage` de
 *   `@spa/shared` — la table bilingue que #845 a posée **auprès des codes**,
 *   dont l'annotation `Record<ErrorCode, string>` garantit qu'aucun code n'y
 *   manque dans l'une des deux langues. La recopier dans le catalogue du front
 *   aurait rouvert la divergence que cette table existe pour refermer ;
 * - ce qui n'est pas une `ApiClientError` du tout — une panne de rendu, un
 *   `TypeError` — n'a pas de code, et l'encart le dit dans ses propres mots.
 *
 * Le `title`, lui, reste une **propriété** : il nomme ce qui n'a pas pu être
 * chargé, donc l'écran, et c'est chaque page qui le traduit dans sa racine.
 */

/**
 * Ce que la règle ci-dessous a besoin de savoir de la langue du visiteur.
 *
 * Deux phrases et une langue, et non un traducteur : `visitorErrorMessage` est
 * une fonction pure, appelable depuis un test sans DOM comme depuis un écran, et
 * aucun crochet de `next-intl` n'y est disponible (`apps/web/README.md`, « Les
 * tests »). L'encart les lit, elle les applique.
 */
export interface VisitorErrorCopy {
  /** L'API injoignable, nommée par le parcours — voir l'en-tête. */
  readonly serviceUnavailable: string;
  /** Ce dont on ne sait rien : ni code, ni message affichable. */
  readonly unexpected: string;
  /** La langue dans laquelle `@spa/shared` nomme les refus du contrat. */
  readonly locale: Locale;
}

/**
 * Phrase à montrer au visiteur pour une erreur quelconque du parcours client.
 *
 * Exportée pour être éprouvée seule, et pour qu'un écran à venir trouve la règle
 * plutôt que de la réinventer.
 *
 * `copy` est **exigée** (#1300). Elle a été facultative le temps de #846 : le
 * repli rendait alors la phrase française que la frontière d'API avait écrite,
 * pour les appelants qui n'avaient pas encore de catalogue sous la main. Il n'en
 * reste aucun — l'encart ci-dessous est le seul appelant du dépôt, et il la
 * passe toujours. Garder la branche revenait à garder deux phrases françaises en
 * dur dans un fichier que l'épique #843 a précisément fini de traduire, sans
 * qu'aucun chemin d'exécution ne puisse plus les atteindre.
 */
export function visitorErrorMessage(error: unknown, copy: VisitorErrorCopy): string {
  if (!(error instanceof ApiClientError)) {
    return copy.unexpected;
  }

  // `ERROR_CODES.SERVICE_UNAVAILABLE` et non le littéral : le garde de
  // `packages/shared/src/__tests__/api-error-codes.spec.ts` balaie `apps/web` et
  // refuse toute seconde écriture d'un code du contrat.
  return error.code === ERROR_CODES.SERVICE_UNAVAILABLE
    ? copy.serviceUnavailable
    : errorMessage(error.code, copy.locale);
}

interface BookingErrorNoticeProps {
  /**
   * Ce qui n'a pas pu être chargé, du point de vue du visiteur — **déjà
   * traduit** par l'écran qui l'emploie : c'est lui qui sait s'il servait une
   * vitrine, un tunnel ou une politique de données.
   */
  readonly title: string;
  /** L'erreur remontée par le chargement — `ApiClientError` ou non. */
  readonly error: unknown;
}

/**
 * L'encart rouge des pages `(booking)`, rendu au même endroit pour toutes.
 *
 * Server Component : il n'a ni état ni écouteur, et les pages qui l'emploient
 * sont elles-mêmes rendues côté serveur (skill web-frontend §1). Il n'est pas
 * asynchrone pour autant, d'où `useTranslations` et non `getTranslations` —
 * même forme que `components/salon/salon-shell.tsx`.
 */
export function BookingErrorNotice({ title, error }: BookingErrorNoticeProps) {
  const t = useTranslations('booking');
  const locale = useLocale();

  return (
    <Notification tone="danger" title={title}>
      <p>
        {visitorErrorMessage(error, {
          serviceUnavailable: t('errors.serviceUnavailable'),
          unexpected: t('errors.unexpected'),
          locale,
        })}
      </p>
    </Notification>
  );
}
