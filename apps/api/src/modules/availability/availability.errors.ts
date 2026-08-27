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
  OVERLAPPING_SCHEDULE_RANGES: 'OVERLAPPING_SCHEDULE_RANGES',
  TIME_OFF_RANGE_INVALID: 'TIME_OFF_RANGE_INVALID',
  AVAILABILITY_RANGE_TOO_WIDE: 'AVAILABILITY_RANGE_TOO_WIDE',
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

/**
 * Deux plages du même jour se recouvrent dans une semaine de travail (#32).
 *
 * Ce n'est pas une erreur de forme — chaque plage est bien écrite —, d'où le 422
 * et non le 400 : c'est leur mise en présence qui ne veut rien dire. Le calcul
 * de créneaux proposerait deux fois le même créneau, et le praticien
 * apparaîtrait deux fois libre à la même heure.
 *
 * La base porte la même règle en `EXCLUDE USING gist` : ce contrôle applicatif
 * ne la remplace pas, il **nomme** ce que la contrainte refuserait sinon en
 * violation brute, donc en 500. L'adjacence (`12:00` puis `12:00`) n'en est pas
 * un : la borne haute est exclue.
 *
 * `details` rend les deux plages fautives, jamais la semaine entière :
 * l'utilisateur doit savoir lesquelles corriger sans relire sa saisie.
 */
export class OverlappingScheduleRangesError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.OVERLAPPING_SCHEDULE_RANGES;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(weekday: number, left: string, right: string) {
    super('Deux plages du même jour se recouvrent.', { weekday, ranges: [left, right] });
  }
}

/**
 * Fenêtre maximale d'une interrogation de disponibilité, en jours (#34).
 *
 * Le calcul se fait **à la demande** et n'est jamais matérialisé (CDC §2.3) :
 * une plage non bornée est donc un déni de service à une seule requête — un
 * `from` en 1970 et un `to` en 2170 feraient parcourir soixante-treize mille
 * journées civiles, chacune convertie par l'ICU. Trente et un jours couvrent le
 * « mois suivant » du calendrier public, qui est le seul écran qui interroge.
 *
 * TODO(#26) : c'est `MAX_AVAILABILITY_RANGE_DAYS` de `@spa/shared`
 * (`packages/shared/src/constants/limits.ts`), à importer le jour où `apps/api`
 * dépendra du paquet. Le nom est celui du paquet partagé pour que la
 * substitution ne change pas une borne en silence — même TODO que
 * `MAX_TIME_OFF_RANGE_DAYS` ci-dessous.
 */
export const MAX_AVAILABILITY_RANGE_DAYS = 31;

/**
 * Plage de dates trop large, ou inversée, pour une interrogation de créneaux.
 *
 * **422 et non 400** : chaque date est bien écrite, c'est leur écart qui n'est
 * pas servable. La distinction compte pour le front, qui n'affiche pas un défaut
 * de format comme une limite de service — et le code est celui qu'annonce déjà
 * `availabilityQuerySchema` du contrat partagé.
 *
 * Jugée dans le service et pas seulement dans le DTO, pour la même raison que
 * les bornes d'une absence : la règle porte sur le **couple** de dates, et tout
 * appelant du moteur doit s'y heurter — y compris celui qui n'est pas venu par
 * HTTP. `details` ne rend que ce que l'appelant a envoyé, plus la borne.
 */
export class AvailabilityRangeTooWideError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.AVAILABILITY_RANGE_TOO_WIDE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(from: string, to: string) {
    super(
      `La plage interrogée doit être ordonnée et ne pas excéder ${String(MAX_AVAILABILITY_RANGE_DAYS)} jours.`,
      { from, to, maxRangeDays: MAX_AVAILABILITY_RANGE_DAYS },
    );
  }
}

/**
 * Bornes d'une absence : la règle, en un seul endroit.
 *
 * Une plage bloquée ou un congé se pose et se modifie ; les deux chemins doivent
 * juger les mêmes bornes de la même façon. Écrire la règle deux fois — une fois
 * pour la création, une fois pour le patch — la laisserait diverger au premier
 * ajustement, et la modification accepterait alors ce que la création refuse.
 */
export const TIME_OFF_RULES = {
  ENDS_BEFORE_STARTS: 'ends_before_starts',
  RANGE_TOO_WIDE: 'range_too_wide',
} as const;

export type TimeOffRule = (typeof TIME_OFF_RULES)[keyof typeof TIME_OFF_RULES];

/**
 * Fenêtre maximale d'une absence, en jours — et la même borne pour la fenêtre du
 * planning qui les liste.
 *
 * Elle ne protège d'aucun abus : c'est une **borne de faute de frappe**. Une
 * absence saisie au 20 **2**6 au lieu de 2026 blanchirait l'agenda du praticien
 * pour deux siècles, et rien ne le signalerait — le moteur de créneaux cesserait
 * simplement de rendre des disponibilités, sans erreur ni trace.
 *
 * TODO(#26) : c'est `MAX_TIME_OFF_RANGE_DAYS` de `@spa/shared`
 * (`packages/shared/src/constants/limits.ts`), à importer le jour où `apps/api`
 * dépendra du paquet. Le nom est celui du paquet partagé pour que la
 * substitution ne change pas une borne en silence.
 */
export const MAX_TIME_OFF_RANGE_DAYS = 366;

/**
 * Bornes d'absence refusées — fin avant début, ou fenêtre déraisonnable.
 *
 * **422 et non 400** : la requête est bien formée, ce sont ses valeurs prises
 * ensemble qui ne tiennent pas. La distinction compte pour le front, qui
 * n'affiche pas un défaut de format comme une règle métier — et le cas ne se
 * réduit pas à un décorateur de DTO, puisqu'une modification partielle ne
 * fournit qu'une des deux bornes et doit être jugée contre celle déjà en base.
 *
 * `details.rule` distingue les deux refus sans multiplier les codes : le front
 * affiche le même message sur le même champ, et deux codes lui auraient fait
 * écrire deux branches pour une seule correction à faire par l'utilisateur.
 *
 * Ni l'un ni l'autre n'apprend quoi que ce soit sur un établissement voisin :
 * `details` ne porte que les bornes que l'appelant vient d'envoyer.
 */
export class InvalidTimeOffRangeError extends DomainError {
  public override readonly code = AVAILABILITY_ERROR_CODES.TIME_OFF_RANGE_INVALID;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(rule: TimeOffRule, startsAt: Date, endsAt: Date) {
    super(
      rule === TIME_OFF_RULES.ENDS_BEFORE_STARTS
        ? 'La fin de l’absence doit suivre son début.'
        : `Une absence ne peut excéder ${String(MAX_TIME_OFF_RANGE_DAYS)} jours.`,
      {
        rule,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        maxRangeDays: MAX_TIME_OFF_RANGE_DAYS,
      },
    );
  }
}
