import { REPORTING_ERROR_CODES } from '@spa/shared';

import { DOMAIN_HTTP_STATUS, DomainError } from '../../common/errors';

/**
 * Erreurs du module `reporting` — le seul fichier d'erreurs du module.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en
 * `{ code, message, details }`. Le front réagit sur `code`, jamais sur
 * `message`.
 *
 * Trois propriétés valent pour toutes, et elles tiennent au fait qu'un rapport
 * ne désigne aucune ressource :
 *
 * - **aucune ne parle d'un autre établissement.** Il n'y a rien à confondre :
 *   ce module ne prend aucun identifiant en chemin, et le seul établissement
 *   qu'il sache lire est celui du jeton. Le 404 de `NotFoundError` n'y sert
 *   qu'un cas, l'établissement disparu sous la requête ;
 * - **aucune ne porte de donnée personnelle.** `details` ne contient que des
 *   nombres de jours et des noms de champ ;
 * - **aucune n'est un 404 déguisé.** Une fenêtre refusée est un 422 — les
 *   bornes sont individuellement bien formées, c'est leur relation ou leur
 *   étendue qui ne convient pas (api-module §5).
 *
 * Les **codes** viennent désormais de `@spa/shared`, où le rapatriement de #536
 * leur a créé une famille propre au module, et sont réexportés d'ici. Le contrat
 * n'en portait aucun : les deux y ont été ajoutés à l'identique, sans qu'aucune
 * valeur servie ne change.
 */
export { REPORTING_ERROR_CODES };

const { UNPROCESSABLE_ENTITY } = DOMAIN_HTTP_STATUS;

/**
 * 503 — `DOMAIN_HTTP_STATUS` ne connaît pas les dépendances externes.
 *
 * Repris tel quel de `notifications/notifications.errors.ts`, et pour la même
 * raison : la table d'api-module §5 couvre les refus **métier**, et une capacité
 * absente de l'environnement n'en est pas un.
 */
const SERVICE_UNAVAILABLE = 503;

/**
 * L'étendue maximale d'un rapport, en jours — un an bissextile, borne haute
 * exclue comprise.
 *
 * C'est la traduction directe du cinquième critère de #74 : « temps de réponse
 * acceptable **sur un an de données** ». Le plafond n'est pas là pour brider un
 * usage — un tableau de bord de salon regarde une journée, une semaine, un mois,
 * au plus un exercice — mais pour qu'aucune requête n'échappe au dimensionnement
 * sur lequel les index de la migration ont été choisis. Sans lui, un `?from=`
 * à l'an 1970 balaierait la table entière et rendrait le plafond illusoire.
 *
 * 366 et non 365 : demander « l'année 2028 » du 1er janvier au 1er janvier
 * suivant fait 366 jours sur une année bissextile, et refuser cette requête-là
 * serait refuser exactement ce que le critère demande d'accepter.
 */
export const MAX_REPORT_WINDOW_DAYS = 366;

/**
 * La fenêtre demandée ne contient aucun instant.
 *
 * `from` est inclus et `to` **exclu** : `from >= to` décrit donc un intervalle
 * vide. Rendre un rapport à zéro aurait été défendable, mais trompeur —
 * « aucune recette ce jour-là » et « la fenêtre est à l'envers » appellent deux
 * conduites différentes, et un gérant qui croit la première alors que c'est la
 * seconde conclut à une journée blanche.
 *
 * **422 et non 400** : les deux bornes sont individuellement bien formées, le
 * `ValidationPipe` les a déjà acceptées. C'est leur *relation* qui est refusée,
 * et api-module §5 range cela dans la règle métier — même traitement que
 * `HistoryWindowInvalidError` chez `payments`.
 */
export class ReportWindowInvalidError extends DomainError {
  public override readonly code = REPORTING_ERROR_CODES.REPORT_WINDOW_INVALID;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor() {
    super('La fin de la fenêtre doit suivre son début.');
  }
}

/**
 * La fenêtre demandée dépasse {@link MAX_REPORT_WINDOW_DAYS}.
 *
 * Un plafond **serveur**, non négociable par l'appelant — comme le `pageSize`
 * maximal des historiques. Sans lui, `?from=1970-01-01T00:00:00Z` est un déni de
 * service à une requête, sur les trois routes à la fois.
 *
 * `details` porte la borne et l'étendue demandée, pour que l'écran puisse
 * proposer la correction plutôt que d'afficher une erreur opaque. Deux nombres,
 * aucune donnée d'établissement.
 */
export class ReportWindowTooWideError extends DomainError {
  public override readonly code = REPORTING_ERROR_CODES.REPORT_WINDOW_TOO_WIDE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(requestedDays: number) {
    super(`Une fenêtre de rapport couvre au plus ${MAX_REPORT_WINDOW_DAYS} jours.`, {
      maxDays: MAX_REPORT_WINDOW_DAYS,
      requestedDays,
    });
  }
}

/**
 * Aucun entrepôt d'export n'est branché sur ce déploiement — #563.
 *
 * **503 et non 500** : ce n'est pas un défaut de notre code, c'est une capacité
 * absente de l'environnement. Elle revient dès que le module Terraform
 * `reporting-export` est composé et que `REPORT_EXPORT_BUCKET` atteint la
 * définition de tâche ; d'ici là, l'export échoue **visiblement** plutôt que de
 * rendre une URL qui ne mène nulle part.
 *
 * Ce refus ne ferme pas le reporting : les trois routes de lecture continuent de
 * servir et l'écran affiche ses chiffres. C'est le fichier qui manque, pas les
 * indicateurs — le même arbitrage que celui de l'expéditeur de notifications non
 * configuré, qui laisse les rendez-vous se prendre.
 *
 * `details` est vide à dessein : nommer la variable d'environnement manquante
 * apprendrait la forme de notre configuration à qui appelle la route.
 */
export class ReportExportUnavailableError extends DomainError {
  public override readonly code = REPORTING_ERROR_CODES.REPORT_EXPORT_UNAVAILABLE;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super('L’export du reporting n’est pas disponible sur cet environnement.');
  }
}
