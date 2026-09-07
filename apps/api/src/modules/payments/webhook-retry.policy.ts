/**
 * La politique de réessai d'un traitement de webhook — bornée, et pure (#409).
 *
 * ## Pourquoi un réessai, alors que Stripe en a déjà un
 *
 * Justement parce qu'il n'en a plus. Le contrôleur répond 200 **avant** de
 * traiter (payments-stripe §3), et Stripe ne redélivre que ce qu'il a vu
 * échouer — un non-2xx ou un délai dépassé. À partir de l'accusé, la reprise
 * n'appartient plus qu'à nous : un traitement qui échoue en base laisse
 * l'encaissement `PENDING` et le rendez-vous jamais confirmé, alors que la
 * cliente a été débitée.
 *
 * Les pannes que `StripeWebhookService.process` laisse remonter sont
 * précisément celles qui passent toutes seules : base momentanément
 * injoignable, interblocage, échec de sérialisation. Aucune n'est un désaccord
 * de contrat — ceux-là sont acquittés sans traitement bien plus haut, dans
 * `readWebhookEvent`. Toutes méritent donc d'être rejouées, et aucune ne mérite
 * de l'être indéfiniment : au bout du compte, c'est la file d'attente morte et
 * son alerte qui rendent la main à un humain.
 *
 * ## Pourquoi une gigue
 *
 * La panne qui déclenche un réessai est presque toujours **partagée** : la base
 * n'est pas injoignable pour un seul événement. Sans gigue, tous les
 * traitements en échec repartiraient à la même milliseconde, et le premier
 * geste d'une base qui se relève serait d'encaisser une rafale. La gigue dite
 * « égale » — moitié fixe, moitié tirée — étale la reprise sans jamais rendre
 * un délai plus court que la moitié du délai nominal.
 *
 * ## Pourquoi ce fichier ne contient que des fonctions
 *
 * Un délai de réessai est une décision arithmétique. La sortir de la file la
 * rend éprouvable sans minuteur, sans promesse et sans double — et laisse la
 * file ne parler que d'ordonnancement.
 */

/** Le calendrier des réessais : combien de fois, et à quel rythme. */
export interface RetrySchedule {
  /**
   * Nombre total de tentatives, **première comprise**.
   *
   * `1` désactiverait le réessai sans changer le reste du code — c'est la
   * valeur qu'emploie une suite qui veut observer la file d'attente morte tout
   * de suite.
   */
  readonly maxAttempts: number;
  /** Délai nominal après la première tentative, doublé à chaque échec suivant. */
  readonly baseDelayMs: number;
  /** Plafond du délai nominal — au-delà, le doublement cesse. */
  readonly maxDelayMs: number;
}

/**
 * Le calendrier de production.
 *
 * Quatre tentatives et un doublement depuis 500 ms bornent l'attente cumulée à
 * 3,5 s dans le pire des cas. Ce chiffre n'est pas choisi pour lui-même : c'est
 * ce que l'arrêt du conteneur doit pouvoir absorber sans dépasser le délai de
 * grâce que ECS laisse à un `SIGTERM`. Un réessai qui tiendrait la minute
 * couvrirait davantage de pannes, et transformerait chaque déploiement en
 * attente — le bon endroit pour une fenêtre de reprise longue est le balayage
 * ci-dessous, qui reprend la livraison depuis la base au lieu de la retenir
 * dans un processus qu'on est en train d'arrêter.
 */
export const DEFAULT_RETRY_SCHEDULE: RetrySchedule = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Jeton d'injection du calendrier — une suite en substitue un instantané. */
export const WEBHOOK_RETRY_SCHEDULE = Symbol('WEBHOOK_RETRY_SCHEDULE');

/**
 * Reste-t-il une tentative après celle-ci ?
 *
 * `attempt` est le numéro de la tentative qui **vient d'échouer**, à partir de
 * 1. La borne est donc franchie quand elle atteint `maxAttempts`, pas quand
 * elle le dépasse — un décalage d'un cran offrirait une tentative de plus que
 * le calendrier n'en annonce.
 */
export function hasAttemptsLeft(attempt: number, schedule: RetrySchedule): boolean {
  return attempt < schedule.maxAttempts;
}

/**
 * Le délai avant la tentative qui suit `attempt`, gigue comprise.
 *
 * Le tirage est passé en paramètre plutôt que lu depuis `Math.random` : c'est
 * ce qui rend les deux bornes de la gigue observables au lieu d'être
 * approchées par un échantillon.
 */
export function retryDelayMs(
  attempt: number,
  schedule: RetrySchedule,
  random: () => number = Math.random,
): number {
  // `attempt - 1` : la première tentative attend le délai de base, pas son
  // double.
  const nominal = Math.min(schedule.baseDelayMs * 2 ** (attempt - 1), schedule.maxDelayMs);
  const fixed = nominal / 2;

  return Math.round(fixed + random() * fixed);
}

/**
 * Le calendrier du **balayage** — la reprise de ce qu'un processus mort a
 * laissé derrière lui.
 *
 * Le réessai ci-dessus couvre la panne qui se répare toute seule pendant que le
 * processus vit. Il ne couvre pas le cas que le troisième critère de #409
 * nomme : le conteneur qui meurt entre l'accusé rendu à Stripe et la fin du
 * traitement. Cette livraison-là est inscrite en base, elle est toujours
 * `PENDING` — et plus personne ne la tient. Le balayage est ce qui la reprend.
 */
export interface SweepSchedule {
  /**
   * Période du balayage.
   *
   * Elle borne le retard de reprise après un redémarrage, et rien d'autre : le
   * chemin normal n'y passe jamais, puisque la file traite ce qu'elle vient
   * d'inscrire sans attendre le prochain tour.
   */
  readonly intervalMs: number;
  /**
   * Durée du bail qu'une instance pose sur une livraison en la prenant.
   *
   * C'est ce qui empêche deux instances ECS de traiter la même livraison en
   * même temps, et ce qui fait qu'une livraison **redevient** prenable quand
   * l'instance qui la tenait est morte. Elle doit donc dépasser confortablement
   * la durée maximale d'un traitement, réessais compris — sans quoi une
   * livraison lente serait reprise alors qu'elle est encore en cours.
   */
  readonly leaseMs: number;
  /** Nombre de livraisons reprises par tour — une borne, pour ne pas se noyer. */
  readonly batchSize: number;
}

/**
 * Le calendrier de balayage de production.
 *
 * Une minute de bail contre 3,5 s de réessais : deux ordres de grandeur
 * d'écart, ce qui laisse la place à une transaction lente sans jamais faire
 * traiter deux fois. Un quart de minute entre deux tours borne le retard de
 * reprise après un redémarrage à ce qu'un humain ne remarque pas.
 */
export const DEFAULT_SWEEP_SCHEDULE: SweepSchedule = {
  intervalMs: 15_000,
  leaseMs: 60_000,
  batchSize: 20,
};

/** Jeton d'injection du balayage — une suite le remplace par un pas plus court. */
export const WEBHOOK_SWEEP_SCHEDULE = Symbol('WEBHOOK_SWEEP_SCHEDULE');
