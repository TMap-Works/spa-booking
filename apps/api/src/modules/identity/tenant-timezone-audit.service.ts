import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { isValidTimeZone } from '@spa/shared';

import { StructuredLogger } from '../../common/logging/structured-logger';
import {
  TenantTimezoneAuditRepository,
  type TenantTimeZoneRow,
} from './tenant-timezone-audit.repository';

/**
 * Le rattrapage des fuseaux invalides déjà persistés (#604).
 *
 * ## Ce que #603 laissait derrière lui
 *
 * `PATCH /api/v1/tenant` refuse désormais en 400 un fuseau que la base IANA ne
 * connaît pas (#597, PR #603). Cette garde est posée **à la frontière** : elle
 * empêche d'écrire une nouvelle valeur invalide, elle ne dit rien de celles que
 * la route, alors permissive, a déjà écrites. Une ligne `tenants` qui en porte
 * une la garde telle quelle, et rien ne la signale : le défaut ne se manifeste
 * qu'au calcul de créneaux, où `TenantClockService` lève un 422
 * `UNKNOWN_TIME_ZONE` sur une requête qui n'a plus aucun rapport avec le
 * formulaire fautif.
 *
 * ## Ce que ce service fait, et où il s'exécute
 *
 * Un balayage inter-tenant à l'amorçage du module : il relève les fuseaux
 * qu'ICU ne résout pas, les bascule sur `FALLBACK_TIME_ZONE`, et **journalise
 * chaque bascule** avec ce qu'il faut pour la corriger.
 *
 * L'amorçage plutôt qu'une commande à lancer à la main : une requête de relevé
 * jouée une fois répond pour la base de ce jour-là, et le ticket demande
 * explicitement que cela « vaille pour la base de production le jour où il y en
 * a une ». Un crochet d'amorçage se rejoue à chaque déploiement, sans que
 * personne ait à y penser, et son coût est d'une requête sur une table qui porte
 * une ligne par établissement.
 *
 * ## Pourquoi pas une contrainte `CHECK`
 *
 * Parce que l'ensemble valide est celui d'ICU et qu'il bouge avec tzdata :
 * fusions, créations et renommages arrivent par une mise à jour de Node, jamais
 * par une migration. PostgreSQL n'a aucun moyen de tenir cette liste — la sienne
 * (`pg_timezone_names`) est une **autre** base tzdata, celle du serveur, et
 * valider contre elle refuserait ou accepterait des identifiants que le moteur
 * d'affichage, lui, ne traite pas pareil. La garde est à la frontière ; c'est sa
 * place.
 *
 * ## Le service ne retarde ni ne fait tomber le démarrage
 *
 * Deux précautions, et elles répondent à la même exigence — celle que
 * `prisma.service.spec.ts` énonce en une phrase : « le conteneur doit démarrer
 * même si PostgreSQL ne répond pas ». `PrismaService` n'ouvre délibérément
 * aucune connexion à l'initialisation pour cela ; un balayage qui en ouvrirait
 * une **et l'attendrait** rendrait ce choix caduc.
 *
 * 1. **`onApplicationBootstrap` ne rend pas de promesse.** Nest n'attend donc
 *    rien : l'API se met à écouter, et le balayage se déroule derrière. Une base
 *    injoignable ne retarde pas la mise en service de la tâche ECS, et c'est la
 *    sonde `/health` qui la retire du service — pas une boucle de redémarrage
 *    qui se lirait comme une panne de déploiement.
 * 2. **Tout est capturé.** Une base injoignable, un droit manquant, un incident :
 *    la cause part en `error` et rien ne remonte. Un audit de données n'est pas
 *    une condition de bon fonctionnement de l'application — la faire refuser de
 *    démarrer sur son échec ajouterait un mode de panne là où ce ticket vient
 *    précisément en retirer un.
 *
 * `onModuleDestroy` attend en revanche le balayage en cours : c'est ce qui
 * garantit qu'aucune requête ne survit à la fermeture de l'application, en test
 * d'intégration comme à l'arrêt d'une tâche.
 */

/**
 * Le fuseau sur lequel une valeur irrécupérable bascule.
 *
 * `UTC` et non un fuseau plausible comme `Europe/Paris`, et le choix est le cœur
 * de ce ticket : **le repli doit se voir**. Un repli plausible passerait pour
 * correct sur l'agenda d'un salon français et ne serait jamais corrigé ; un
 * agenda rendu en UTC est visiblement décalé de l'offset local — une heure ou
 * deux à Paris, trois à Antananarivo —, ce qui est exactement le signal dont
 * l'établissement a besoin. `UTC` est par ailleurs le pivot dans lequel tous les
 * instants sont stockés (CLAUDE.md), et il est résolu par toutes les versions
 * d'ICU : le repli ne peut pas être lui-même invalide.
 */
export const FALLBACK_TIME_ZONE = 'UTC';

/** Contexte de journalisation — la clé sur laquelle filtrer dans CloudWatch. */
const LOG_CONTEXT = 'TenantTimezoneAudit';

/** Ce qu'une bascule a produit, tel que le rapport et le journal le disent. */
export interface TenantTimeZoneRepair {
  readonly tenantId: string;
  readonly slug: string;
  /** La valeur relevée, celle qu'ICU ne résout pas. Conservée ici et dans le journal : la colonne, elle, ne l'a plus. */
  readonly rejected: string;
  readonly fallback: string;
  /** `false` quand une autre instance a réparé la ligne entre le relevé et l'écriture. */
  readonly repaired: boolean;
}

/** Le relevé complet d'un passage — ce que le point 1 du ticket demandait de constater. */
export interface TenantTimeZoneAuditReport {
  readonly scanned: number;
  readonly invalid: number;
  readonly repaired: number;
  readonly repairs: readonly TenantTimeZoneRepair[];
}

@Injectable()
export class TenantTimezoneAuditService implements OnApplicationBootstrap, OnModuleDestroy {
  /**
   * Le balayage lancé au démarrage, pour pouvoir l'attendre à la fermeture.
   *
   * Initialisée résolue plutôt que laissée `undefined` : `onModuleDestroy` peut
   * être appelé sur une application qui n'a jamais fini de démarrer, et une
   * garde `?? Promise.resolve()` à chaque usage se serait oubliée au premier
   * usage supplémentaire.
   */
  private sweeping: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: TenantTimezoneAuditRepository,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Rend `void` et **non** une promesse : c'est ce qui rend le balayage non
   * bloquant. Voir l'en-tête du fichier — la signature est le mécanisme, pas un
   * détail de style.
   */
  public onApplicationBootstrap(): void {
    this.sweeping = this.sweep();
  }

  /** Aucune requête ne survit à la fermeture de l'application. */
  public async onModuleDestroy(): Promise<void> {
    await this.sweeping;
  }

  /** Le balayage tel qu'il s'exécute en tâche de fond : il n'échoue jamais. */
  private async sweep(): Promise<void> {
    try {
      await this.audit();
    } catch (error) {
      // Journalisé, jamais propagé : voir l'en-tête du fichier.
      this.logger.error(
        'Relevé des fuseaux horaires impossible — les fuseaux invalides déjà persistés n’ont pas été rattrapés à ce démarrage.',
        error,
        LOG_CONTEXT,
      );
    }
  }

  /**
   * Relève, bascule, journalise — et rend le compte rendu.
   *
   * Publique et non privée : c'est elle qui est exercée par les tests, et c'est
   * par elle qu'un futur point d'entrée d'exploitation — commande ou route
   * d'administration — rejouerait le rattrapage sans redémarrer l'API. Elle
   * **propage** ses erreurs, à la différence de `sweep` : un appelant qui la
   * choisit veut savoir.
   *
   * Séquentielle et non `Promise.all` : le nombre de lignes fautives est nul
   * dans le cas normal et se compte sur les doigts d'une main dans le cas
   * dégradé. Paralléliser n'achèterait rien et rendrait l'ordre des lignes de
   * journal non déterministe.
   */
  public async audit(): Promise<TenantTimeZoneAuditReport> {
    const rows = await this.repository.listTimeZones();
    const invalid = rows.filter((row) => !isValidTimeZone(row.timezone));

    if (invalid.length === 0) {
      this.logger.debug(
        `Fuseaux horaires : ${String(rows.length)} établissement(s) relevé(s), aucun fuseau invalide.`,
        LOG_CONTEXT,
      );

      return { scanned: rows.length, invalid: 0, repaired: 0, repairs: [] };
    }

    const repairs: TenantTimeZoneRepair[] = [];

    for (const row of invalid) {
      repairs.push(await this.repair(row));
    }

    const repaired = repairs.filter((repair) => repair.repaired).length;

    // Une ligne de synthèse en plus des lignes de détail : c'est celle sur
    // laquelle une alarme CloudWatch se pose, les autres portent le détail.
    this.logger.warn(
      `Fuseaux horaires : ${String(invalid.length)} établissement(s) sur ${String(rows.length)} ` +
        `portaient un fuseau qu’ICU ne résout pas ; ${String(repaired)} basculé(s) sur ${FALLBACK_TIME_ZONE}.`,
      { scanned: rows.length, invalid: invalid.length, repaired },
      LOG_CONTEXT,
    );

    return { scanned: rows.length, invalid: invalid.length, repaired, repairs };
  }

  /**
   * Bascule une ligne, et dit ce qu'elle portait.
   *
   * La valeur refusée est journalisée **verbatim** : c'est la seule trace qui
   * subsiste de ce que le gérant avait saisi, et c'est ce qui permet de
   * reconnaître une faute de frappe (« Europe/Pais ») d'un identifiant d'un
   * autre système. Elle ne contient aucune donnée personnelle — un identifiant
   * de fuseau désigne une ville, pas une cliente (tenant-isolation §5).
   *
   * Le `tenantId` et le `slug` en font autant pour l'établissement : le premier
   * est ce que le journal structuré porte déjà pour le diagnostic, le second est
   * ce qu'un humain reconnaît sans ouvrir la base.
   */
  private async repair(row: TenantTimeZoneRow): Promise<TenantTimeZoneRepair> {
    const repaired = await this.repository.replaceTimeZone(
      row.id,
      row.timezone,
      FALLBACK_TIME_ZONE,
    );

    if (repaired) {
      this.logger.warn(
        `Fuseau horaire invalide rattrapé : « ${row.timezone} » n’est pas résolu par ICU, ` +
          `l’établissement « ${row.slug} » bascule sur ${FALLBACK_TIME_ZONE}. ` +
          'Son agenda et ses notifications seront rendus en UTC tant qu’un fuseau valide ' +
          'n’aura pas été enregistré depuis les réglages de l’établissement.',
        {
          tenantId: row.id,
          slug: row.slug,
          rejectedTimezone: row.timezone,
          fallbackTimezone: FALLBACK_TIME_ZONE,
        },
        LOG_CONTEXT,
      );
    } else {
      // Course bénigne : une autre instance a réparé la ligne, ou
      // l'établissement a été supprimé entre le relevé et l'écriture.
      this.logger.debug(
        `Fuseau horaire « ${row.timezone} » de « ${row.slug} » déjà rattrapé par ailleurs — rien à écrire.`,
        { tenantId: row.id, slug: row.slug, rejectedTimezone: row.timezone },
        LOG_CONTEXT,
      );
    }

    return {
      tenantId: row.id,
      slug: row.slug,
      rejected: row.timezone,
      fallback: FALLBACK_TIME_ZONE,
      repaired,
    };
  }
}
