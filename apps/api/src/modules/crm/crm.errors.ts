import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `crm`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, comme ceux d'`identity` et de `catalog`. Les déclarer ici suit
 * le précédent des modules voisins — `apps/api` ne dépend pas encore du paquet
 * partagé — et l'import se substituera à ces constantes sans changer une valeur.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement**, et aucune ne
 * recopie une donnée personnelle. Une fiche d'un autre tenant est introuvable,
 * point : c'est `NotFoundError` du tronc commun qui répond, en 404. Un code
 * dédié — ou un 403 — confirmerait son existence (tenant-isolation §4).
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const CRM_ERROR_CODES = {
  CUSTOMER_EMAIL_TAKEN: 'CUSTOMER_EMAIL_TAKEN',
  CLIENT_EMAIL_NOT_BOOKABLE: 'CLIENT_EMAIL_NOT_BOOKABLE',
} as const;

const CONFLICT = 409;

/**
 * Une fiche de cet établissement porte déjà cette adresse.
 *
 * Traduit la violation de `@@unique([tenantId, email])`. Le conflit vient de la
 * base et non d'un contrôle préalable : deux saisies concurrentes au comptoir
 * passeraient toutes les deux le contrôle, et la perdante recevrait un 500.
 *
 * **`details` ne porte pas l'adresse**, contrairement au `slug` des conflits du
 * catalogue. Un slug de prestation est une donnée de catalogue ; une adresse
 * e-mail est une donnée personnelle (CDC §5.1), et le corps d'erreur est
 * précisément l'endroit d'où elle repart vers un journal d'accès, un outil de
 * supervision ou une capture d'écran de ticket. Celui qui vient de la saisir la
 * connaît déjà et n'a pas besoin qu'on la lui renvoie.
 *
 * Ce que ce 409 apprend, et qu'il faut assumer : il dit qu'une fiche existe déjà
 * sous cette adresse **dans cet établissement**. C'est une information que
 * l'appelant — un membre du personnel du salon, authentifié — obtiendrait de
 * toute façon en cherchant l'adresse dans son propre fichier client. Elle ne
 * traverse aucune frontière de tenant.
 */
export class CustomerEmailTakenError extends DomainError {
  public override readonly code = CRM_ERROR_CODES.CUSTOMER_EMAIL_TAKEN;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Une fiche de cet établissement porte déjà cette adresse e-mail.');
  }
}

/**
 * L'adresse est celle d'un **compte du personnel** de cet établissement — la
 * réservation en ligne ne peut pas s'y rattacher (#313).
 *
 * ## Le refus, et pourquoi il en fallait un
 *
 * `ClientDirectoryService` ne résout que des fiches de rôle `CLIENT` : c'est ce
 * qui empêche un appel **public et non authentifié** d'accrocher un rendez-vous
 * à la ligne `users` d'un `MANAGER` ou d'un `ADMIN`. Mais `@@unique([tenantId,
 * email])` interdit d'en créer une seconde sous la même adresse : il n'y a donc
 * pas de troisième voie, et laisser la collision remonter en `P2002` nu aurait
 * rendu un 500 sur une situation parfaitement prévisible.
 *
 * ## Ce que ce refus dit, et ce qu'il ne dit pas
 *
 * Il apprend qu'une adresse donnée porte un compte **non client** dans cet
 * établissement. C'est le prix assumé de la décision, et il est borné : une
 * adresse inconnue et une adresse déjà cliente rendent toutes deux 201, si bien
 * que la route ne dit **rien** du fichier client — la donnée que le module
 * protège. Ce qu'elle laisse deviner est l'annuaire du personnel, que le salon
 * publie le plus souvent lui-même.
 *
 * Il est par ailleurs le **même** refus que le comptoir reçoit déjà :
 * `POST /customers` sur une adresse portée par un compte du personnel rend
 * `CUSTOMER_EMAIL_TAKEN`, la contrainte d'unicité ne distinguant pas les rôles.
 * Le parcours public ne peut pas silencieusement réussir là où le back-office,
 * authentifié, est refusé.
 *
 * ## Sa contrepartie, assumée et documentée
 *
 * Un membre du personnel qui est aussi client de son propre salon ne peut pas
 * réserver en ligne **avec son adresse professionnelle**. Il réserve avec une
 * autre adresse, ou le comptoir le fait pour lui (#50). L'alternative — réutiliser
 * son compte — faisait écrire une ligne `appointments` pointant sur une fiche que
 * le fichier client ne montre jamais (`role = CLIENT`), donc un rendez-vous dont
 * le comptoir ne peut pas ouvrir la cliente.
 *
 * **`details` ne porte pas l'adresse**, comme `CustomerEmailTakenError` et pour
 * la même raison : c'est une donnée personnelle (CDC §5.1), et celui qui vient de
 * la saisir la connaît déjà.
 */
export class ClientEmailNotBookableError extends DomainError {
  public override readonly code = CRM_ERROR_CODES.CLIENT_EMAIL_NOT_BOOKABLE;
  public override readonly status = CONFLICT;

  public constructor() {
    super(
      'Cette adresse e-mail ne peut pas être utilisée pour une réservation en ligne ' +
        'dans cet établissement.',
    );
  }
}

/**
 * Deux résolutions concurrentes ont créé la **même** fiche : celle-ci a perdu.
 *
 * ## Pourquoi ce n'est pas une erreur de domaine
 *
 * Parce qu'elle ne sort jamais telle quelle : c'est un signal d'**ordonnancement**
 * à l'usage de l'appelant, au même titre qu'un interblocage PostgreSQL. Le
 * `@@unique([tenantId, email])` a fait son office, et la conduite correcte est de
 * recommencer — la seconde lecture trouvera la fiche que la gagnante vient
 * d'écrire.
 *
 * ## Pourquoi le réessai ne peut pas avoir lieu ici
 *
 * Une violation de contrainte **abandonne la transaction** en cours côté
 * PostgreSQL : toute instruction suivante échoue en `25P02`, et Prisma n'ouvre
 * aucun point de sauvegarde. Relire l'adresse dans le `catch` — ce que faisait
 * `AppointmentsRepository.findOrCreateClient` hors transaction — n'est donc plus
 * possible. L'erreur doit remonter jusqu'à celui qui a ouvert la transaction,
 * qui la rejoue en entier ; c'est ce que fait `AppointmentsRepository.writingAgenda`.
 *
 * Épuiser les réessais rend un 500, et c'est délibéré : ce n'est plus une course,
 * c'est une contention qui mérite d'être vue dans les journaux — même arbitrage
 * que pour l'interblocage (`appointments.conflicts.ts`).
 */
export class ClientRecordRaceError extends Error {
  public constructor() {
    super(
      'Une fiche cliente vient d’être créée sous cette adresse par une autre ' +
        'transaction : la résolution doit être rejouée.',
    );
    this.name = 'ClientRecordRaceError';
    Error.captureStackTrace?.(this, ClientRecordRaceError);
  }
}
