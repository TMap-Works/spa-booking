/**
 * L'horloge de la file durable — la **seule** source d'instant du bail (#523).
 *
 * ## Pourquoi une horloge injectable, et pas `new Date()`
 *
 * Le bail est une comparaison entre deux instants : celui qu'une instance a
 * posé sur la ligne en la prenant (`claimed_at`, `next_attempt_at`), et celui
 * que le balayage se donne (`ClaimRequest.now`). La propriété qui compte n'est
 * pas « le temps passe », c'est **« les deux côtés du prédicat viennent de la
 * même horloge »**.
 *
 * Ce n'est pas une précaution abstraite : #555 est très exactement cette
 * propriété violée. `next_attempt_at` avait pour défaut le `now()` du **serveur
 * PostgreSQL** tandis que le balayage comparait au `new Date()` du
 * **processus** ; l'écart mesuré entre les deux — de 2 à 11 ms — décidait du
 * verdict de trois cas d'intégration. #568 a ramené l'inscription sur l'horloge
 * du processus, ce qui a supprimé l'écart mais laissé l'instant **subi** : la
 * suite ne pouvait toujours qu'espérer que la machine irait assez vite entre
 * l'inscription et la reprise.
 *
 * Une horloge injectée retire la question. En exploitation elle rend
 * `new Date()`, comme avant. Dans une suite, elle est **pilotée** : le bail
 * périme parce qu'on a fait avancer l'horloge d'un TTL, jamais parce qu'on a
 * attendu — d'où l'absence de tout `sleep` dans les cas de reprise, et
 * l'indépendance à la charge de la machine.
 *
 * ## Ce qu'elle couvre, et ce qu'elle ne couvre pas
 *
 * Elle date **l'ordonnancement** de la file, et rien d'autre : la pose et le
 * report du bail (`spool`, `reviveDeadDelivery`, `rescheduleDelivery`), et
 * l'instant du balayage (`sweepOnce`, `postpone`). Les horodatages **métier** —
 * `captured_at` d'un encaissement, par exemple — n'en relèvent pas : ils
 * datent un fait comptable, pas une fenêtre de reprise, et les rattacher à une
 * horloge que les tests déplacent en ferait mentir la trace de réconciliation
 * (payments-stripe §6).
 */

/** L'instant courant, tel que la file le voit. */
export type WebhookClock = () => Date;

/**
 * L'horloge d'exploitation : celle du processus.
 *
 * Celle du **processus**, et jamais celle du moteur PostgreSQL : c'est la
 * divergence entre les deux qui a produit #555, et une seule horloge de part et
 * d'autre du prédicat de bail est ce qui la rend impossible à réintroduire.
 */
export const SYSTEM_CLOCK: WebhookClock = () => new Date();

/**
 * Jeton d'injection de l'horloge — une suite en substitue une qu'elle pilote.
 *
 * Un `Symbol` pour la même raison que `WEBHOOK_RETRY_SCHEDULE` : la valeur est
 * une fonction, pas une classe, et `emitDecoratorMetadata` n'aurait rien à
 * donner à Nest pour la retrouver.
 */
export const WEBHOOK_CLOCK = Symbol('WEBHOOK_CLOCK');
