import { CRM_ERROR_CODES } from '@spa/shared';

import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `crm`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * Les **codes** viennent de `@spa/shared` et sont réexportés d'ici (#536) :
 * c'est le module qui **lève** un refus qui le porte, quelle que soit la route
 * par laquelle il sort.
 *
 * La famille en a compté un troisième, `CLIENT_EMAIL_NOT_BOOKABLE` : le refus
 * qu'opposait `resolveClientWithin` à l'adresse d'un compte du personnel. Cette
 * porte a disparu avec #1222 — réserver exige un compte, aucune route ne résout
 * plus de fiche depuis une adresse —, et le code est parti du contrat avec elle.
 *
 * **Ce que cet import de valeur exige, et qui le garde.** Il émet un
 * `require('@spa/shared')` dans `apps/api/dist`, que `node` résout par le `main`
 * du workspace — `packages/shared/dist/index.js`. Trois choses le rendent
 * possible, et aucune n'est décorative : `@spa/shared` est déclaré dans les
 * `dependencies` d'`apps/api/package.json` ; l'étape `build` du Dockerfile
 * compile le paquet et son étape `runtime` en copie le `dist` ; et la garde
 * « L'image API démarre » de `.github/workflows/ci.yml` **lance** l'image à
 * chaque PR, là où le job `docker` se contentait de la construire. C'est cette
 * dernière qui empêche le `MODULE_NOT_FOUND` de ne se découvrir qu'au
 * déploiement (#463). Les huit modules importent désormais leurs codes de cette
 * façon : la garde vaut pour tous.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement**, et aucune ne
 * recopie une donnée personnelle. Une fiche d'un autre tenant est introuvable,
 * point : c'est `NotFoundError` du tronc commun qui répond, en 404. Un code
 * dédié — ou un 403 — confirmerait son existence (tenant-isolation §4).
 */
export { CRM_ERROR_CODES };

const CONFLICT = 409;
const UNPROCESSABLE_ENTITY = 422;

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
 * La fiche a encore des rendez-vous qui occupent l'agenda : elle ne peut pas
 * être anonymisée maintenant (#81).
 *
 * ## Ce que ce refus protège
 *
 * Anonymiser, c'est rendre la personne non identifiable. Une cliente attendue
 * jeudi dont la fiche ne porte plus qu'un pseudonyme est un rendez-vous que le
 * salon ne peut plus ni préparer, ni confirmer, ni décommander — et la personne
 * qui se présente n'a plus rien pour prouver qu'elle est attendue.
 *
 * Le RGPD prévoit exactement ce cas : l'effacement ne s'impose pas tant que le
 * traitement reste **nécessaire à l'exécution du contrat** (art. 17.1.b lu avec
 * l'art. 6.1.b). Un rendez-vous à venir *est* ce contrat en cours.
 *
 * ## Pourquoi ce n'est pas un refus définitif
 *
 * La voie est ouverte et tient en un geste : honorer le rendez-vous, ou
 * l'annuler. C'est ce qui distingue ce 422 d'un 403 — la demande est recevable,
 * c'est l'état du monde qui la retient — et c'est pourquoi `details` porte le
 * **nombre** de rendez-vous concernés : l'écran qui l'affiche sait alors quoi
 * dire, sans avoir à redemander.
 *
 * `details` ne porte que ce nombre : ni date, ni prestation, ni praticien. Un
 * corps d'erreur repart vers un journal d'accès ou une capture d'écran, et rien
 * de ce qui décrit un rendez-vous n'a à y voyager (CDC §5.1).
 */
export class CustomerHasUpcomingAppointmentsError extends DomainError {
  public override readonly code = CRM_ERROR_CODES.CUSTOMER_HAS_UPCOMING_APPOINTMENTS;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(upcomingAppointments: number) {
    super(
      'Cette fiche a encore des rendez-vous à venir : les honorer ou les annuler ' +
        'avant de l’anonymiser.',
      { upcomingAppointments },
    );
  }
}
