import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `availability`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, à côté de `BOOKING_ERROR_CODES`. Les déclarer ici suit le
 * précédent des modules voisins — `apps/api` ne dépend pas encore du paquet
 * partagé — et l'import se substituera à ces constantes sans changer une valeur.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement.** Elles ne portent
 * que ce que l'appelant vient d'envoyer — une heure, un fuseau —, jamais
 * l'existence d'une ressource d'un tenant voisin, qui reste un 404
 * (tenant-isolation §4).
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const AVAILABILITY_ERROR_CODES = {
  NON_EXISTENT_LOCAL_TIME: 'NON_EXISTENT_LOCAL_TIME',
  AMBIGUOUS_LOCAL_TIME: 'AMBIGUOUS_LOCAL_TIME',
  UNKNOWN_TIME_ZONE: 'UNKNOWN_TIME_ZONE',
} as const;

const UNPROCESSABLE_ENTITY = 422;

/**
 * Heure locale sautée par l'avance de l'horloge — elle n'existe pas ce jour-là.
 *
 * `2026-03-29 02:30` à Paris n'est pas une heure improbable : c'est une heure
 * qui **n'a pas eu lieu**. La refuser en 422 plutôt que de la décaler en silence
 * est ce qui distingue un agenda juste d'un agenda plausible — un rendez-vous
 * déplacé d'une heure sans que personne ne le sache est précisément le bug de
 * sévérité haute que CLAUDE.md interdit.
 *
 * `details` rend l'heure demandée, l'heure de repli et la durée du saut : c'est
 * ce qu'il faut au front pour proposer « 03:30 ? » plutôt qu'un message d'échec
 * sec. Aucune de ces valeurs n'apprend quoi que ce soit sur un autre tenant.
 */
export class NonExistentLocalTimeError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.NON_EXISTENT_LOCAL_TIME;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(localDateTime: string, timeZone: string, shiftedTo: string, gapMinutes: number) {
    super(
      'Cette heure locale n’existe pas : l’horloge avance cette nuit-là.',
      { localDateTime, timeZone, shiftedTo, gapMinutes },
    );
  }
}

/**
 * Heure locale vécue deux fois par le recul de l'horloge.
 *
 * `2026-10-25 02:30` à Paris désigne deux instants distants d'une heure. Un
 * rendez-vous posé sur l'un ou l'autre n'a pas la même valeur : le client et le
 * praticien peuvent se manquer d'exactement soixante minutes.
 *
 * Le module **résout** l'ambiguïté par défaut sur la première occurrence
 * (`ZonedResolution.instant`) ; cette erreur n'est levée que par les chemins qui
 * refusent explicitement de trancher à la place de l'utilisateur. `details`
 * porte les deux offsets pour que le front puisse poser la question.
 */
export class AmbiguousLocalTimeError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.AMBIGUOUS_LOCAL_TIME;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(
    localDateTime: string,
    timeZone: string,
    firstOccurrence: string,
    secondOccurrence: string,
  ) {
    super('Cette heure locale a lieu deux fois : l’horloge recule cette nuit-là.', {
      localDateTime,
      timeZone,
      firstOccurrence,
      secondOccurrence,
    });
  }
}

/**
 * Fuseau IANA inconnu du moteur ICU.
 *
 * `tenants.timezone` est `NOT NULL` et sans valeur par défaut, mais rien en base
 * ne vérifie qu'il désigne un fuseau **réel** : une faute de frappe à la
 * création d'un établissement passe la contrainte. Elle se manifesterait sinon
 * en `RangeError` non rattrapée depuis `Intl`, donc en 500 muet sur la première
 * requête de disponibilité.
 */
export class UnknownTimeZoneError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.UNKNOWN_TIME_ZONE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(timeZone: string) {
    super('Fuseau horaire inconnu.', { timeZone });
  }
}
