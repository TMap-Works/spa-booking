import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { isValidTimeZone } from '@spa/shared';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { IdentityRepository, type TenantTimeZoneRecord } from './identity.repository';

/**
 * Relevé, à chaque démarrage, des établissements dont `tenants.timezone` ne se
 * résout pas (#604).
 *
 * ## Ce que #603 ferme, et ce qu'il ne ferme pas
 *
 * `PATCH /api/v1/tenant` refuse depuis #603 un fuseau que la base IANA ne
 * connaît pas (`@IsIanaTimeZone`, `dto/tenant-settings.dto.ts`). La porte est
 * close ; l'**existant** ne l'est pas. Une ligne écrite avant la correction —
 * ou par un chemin qui n'est pas la route : un import, une reprise de données,
 * un correctif SQL à chaud — garde sa valeur, et rien ne la signale. Le défaut
 * ne se manifeste alors qu'au calcul de créneaux, où `TenantClockService` lève
 * un 422 `UNKNOWN_TIME_ZONE` sur une requête qui n'a plus aucun rapport avec le
 * formulaire fautif ; entre-temps, tous les rendez-vous de l'établissement
 * s'affichent dans un fuseau que le moteur ne sait pas résoudre.
 *
 * Ce contrôle rend permanent le relevé qu'on jouait à la main, pour qu'une ligne
 * fautive ne puisse plus dormir sans rien dire.
 *
 * ## Un signalement, jamais un garde-fou
 *
 * **Le démarrage ne peut pas échouer ici**, et c'est la propriété qui compte :
 * un établissement mal configuré ne doit pas empêcher les autres d'être servis.
 * Trois choix la tiennent ensemble :
 *
 * 1. `audit()` ne laisse rien remonter — la base injoignable comme la ligne
 *    fautive sortent par le journal, pas par une levée ;
 * 2. `onApplicationBootstrap` n'**attend** pas le relevé. `PrismaService` ne se
 *    connecte délibérément pas à l'initialisation, précisément pour qu'une base
 *    injoignable ne retienne pas le conteneur au démarrage ; attendre une
 *    requête ici rouvrirait ce que ce choix ferme. Le processus sert donc ses
 *    requêtes pendant que le relevé se fait, et le journal arrive quand il
 *    arrive. La promesse est en revanche **retenue**, et `onApplicationShutdown`
 *    l'attend : sans cela, un processus court — une suite d'intégration qui
 *    ferme son application, un conteneur qui reçoit SIGTERM peu après son
 *    démarrage — verrait `PrismaService.onModuleDestroy` couper la requête en
 *    vol, et le relevé signalerait « base injoignable » là où il n'y a qu'un
 *    arrêt. C'est le même soin qu'`onApplicationShutdown` prend déjà sur la
 *    file de webhooks ;
 * 3. rien de ce qui est relevé n'est **corrigé**. Réparer demanderait de
 *    choisir un fuseau de repli, ce qu'aucun cas réel n'éclaire à ce jour — le
 *    relevé de #604 rend zéro ligne fautive sur dix-neuf établissements. Cette
 *    décision-là n'appartient pas à un contrôle qui s'exécute tout seul au
 *    démarrage.
 *
 * ## Le prédicat est celui du contrat, pas un second
 *
 * `isValidTimeZone` de `@spa/shared` — celui qu'applique `timeZoneSchema`, et
 * celui que `@IsIanaTimeZone()` interroge à la frontière depuis #603. Un `try`
 * recopié ici ferait deux prédicats, et deux prédicats dérivent : la route
 * refuserait une valeur que le relevé tolère, ou l'inverse. C'est le défaut que
 * #403/#404 ont refermé ailleurs.
 *
 * Il pose la question à l'ICU lui-même plutôt qu'à `Intl.supportedValuesOf`, qui
 * ne liste que les identifiants canoniques et déclarerait fautifs `UTC` ou
 * `Etc/GMT+5` — voir l'argument complet sur `IsIanaTimeZone`.
 *
 * ## Pourquoi ici, et pas dans `/health`
 *
 * Les deux formes se défendent. `/health` est sondé par l'ALB plusieurs fois par
 * minute : y brancher une lecture de `tenants` ferait payer à chaque sonde le
 * coût d'un constat qui ne change qu'à l'écriture d'un réglage, et il faudrait
 * alors décider si un fuseau fautif rend la tâche « down » — ce qu'il ne doit
 * surtout pas faire, un établissement mal réglé n'étant pas une panne
 * d'instance. Un relevé au démarrage se paie une fois par processus, sort au
 * même endroit que le reste des traces, et ne peut rien retirer du service.
 *
 * `/health` vit de toute façon dans `apps/api/src/health/`, hors du module
 * `identity` à qui la table `tenants` appartient.
 */
@Injectable()
export class TenantTimeZoneAudit implements OnApplicationBootstrap, OnApplicationShutdown {
  /**
   * Le relevé **en vol**, retenu le temps qu'il se fasse — `null` sinon.
   *
   * Il n'est pas gardé pour être attendu au démarrage, mais pour que l'arrêt
   * sache qu'il y a quelque chose à laisser finir.
   */
  private pending: Promise<unknown> | null = null;

  public constructor(
    private readonly repository: IdentityRepository,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Lance le relevé **sans l'attendre** — voir le deuxième point du commentaire
   * de classe. Pas d'`await` : le démarrage ne se suspend pas sur une requête,
   * et `audit()` ne rejette jamais, si bien qu'aucune promesse flottante ne peut
   * abattre le processus. La référence est conservée pour l'arrêt, pas pour le
   * démarrage.
   */
  public onApplicationBootstrap(): void {
    const pending = this.audit();
    this.pending = pending.finally(() => {
      this.pending = null;
    });
  }

  /**
   * Laisse au relevé le temps de finir avant que la connexion ne se ferme.
   *
   * `PrismaService.onModuleDestroy` appelle `$disconnect()` ; sans cette
   * attente, une requête en vol serait coupée et le relevé journaliserait une
   * base injoignable qui n'est qu'un arrêt en cours. L'attente est bornée par la
   * requête elle-même — trois colonnes sur `tenants` —, et `audit()` ne rejetant
   * jamais, cet `await` ne peut pas faire échouer l'arrêt.
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.pending;
  }

  /**
   * Relève les établissements au fuseau non résolu, les journalise, et les rend.
   *
   * Publique parce qu'elle est la preuve du contrôle : une suite doit pouvoir
   * l'exercer sans monter l'application entière. Elle ne lève jamais — un appel
   * qui échoue rend la liste vide, et le motif part au journal.
   */
  public async audit(): Promise<TenantTimeZoneRecord[]> {
    let tenants: TenantTimeZoneRecord[];
    try {
      tenants = await this.repository.listTenantTimeZones();
    } catch (error: unknown) {
      // Base injoignable, migration pas encore appliquée, arrêt en cours : rien
      // de tout cela n'est un fuseau fautif, et rien de tout cela ne justifie
      // d'empêcher l'API de servir. On le dit, et on s'arrête là.
      this.logger.warn(
        'relevé des fuseaux d’établissement impossible — le contrôle est passé, pas la base',
        error instanceof Error ? error : new Error(String(error)),
        TenantTimeZoneAudit.name,
      );
      return [];
    }

    const invalid = tenants.filter((tenant) => !isValidTimeZone(tenant.timezone));

    if (invalid.length === 0) {
      // En `debug` : un opérateur qui cherche pourquoi rien n'est signalé doit
      // pouvoir vérifier que le contrôle a bien tourné. En `info`, cette ligne
      // sortirait à chaque démarrage de chaque tâche ECS pour ne rien dire.
      this.logger.debug(
        `fuseaux d’établissement vérifiés : ${tenants.length} établissement(s), aucun fuseau inconnu`,
        TenantTimeZoneAudit.name,
      );
      return [];
    }

    // Une ligne par établissement fautif, et non une ligne récapitulative : une
    // ligne = un événement indexable dans CloudWatch, donc une alarme possible
    // et un établissement nommément désigné dans le résultat de recherche.
    //
    // Le nom de l'établissement et son identifiant, et rien d'autre : ce sont
    // les deux seules données dont a besoin celui qui va corriger le réglage, et
    // aucune donnée personnelle cliente n'entre dans un journal (CDC §5.1). La
    // rédaction du logger n'est pas ce sur quoi on se repose — c'est la
    // projection du dépôt qui borne ce qu'il est possible d'écrire ici.
    for (const tenant of invalid) {
      this.logger.warn(
        'fuseau horaire d’établissement inconnu du moteur ICU — les rendez-vous de ce salon ne peuvent pas être rendus à l’heure locale',
        {
          tenantId: tenant.id,
          tenantName: tenant.name,
          timezone: tenant.timezone,
        },
        TenantTimeZoneAudit.name,
      );
    }

    return invalid;
  }
}
