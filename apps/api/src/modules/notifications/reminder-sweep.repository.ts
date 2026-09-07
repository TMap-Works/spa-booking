import { Inject, Injectable } from '@nestjs/common';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import { OCCUPYING_STATUSES } from '../appointments/appointment-status';
import { LIVE_NOTIFICATION_STATUSES, isDialableNumber, type DueReminder } from './notifications.types';

/**
 * Les lectures du balayage horaire du rappel J-1 (#71).
 *
 * Un fichier à part de `notifications.repository.ts`, et pour une seule raison :
 * c'est **ici** et nulle part ailleurs dans le module que le client non scopé
 * est injecté. `prisma-clients.ts` exige de chaque dérogation qu'elle se voie —
 * « le nommer `prismaUnscoped` au site d'injection, un commentaire qui dit
 * pourquoi, et un filtre par tenant écrit à la main dès que le traitement en
 * vise un ». La regrouper dans un fichier dont le nom annonce le traitement rend
 * la relecture de `grep -rn PRISMA_UNSCOPED apps/api/src` immédiate.
 *
 * ## Deux clients, et la frontière passe entre eux
 *
 * | Client | Ce qu'il lit | Pourquoi |
 * |---|---|---|
 * | `prismaUnscoped` | `tenants.id`, et **rien d'autre** | il n'existe aucun tenant courant : le balayage est déclenché par EventBridge Scheduler, hors de toute requête HTTP, et il concerne tous les établissements à la fois |
 * | `prisma` (scopé) | les rendez-vous dus, un établissement à la fois | chaque lecture se fait dans une portée ouverte par l'appelant ; l'extension pose le `tenant_id`, exactement comme dans une requête |
 *
 * La dérogation est donc réduite à **une liste d'identifiants** : la donnée
 * métier — les rendez-vous, les clientes — ne sort jamais du client scopé, et
 * une fuite inter-tenant ne peut pas se produire par oubli d'un `where`.
 *
 * ## Pourquoi un balayage établissement par établissement
 *
 * Une seule requête inter-tenant sur `starts_at` aurait été plus courte à
 * écrire. Elle aurait aussi été un **parcours complet de la table** : tous les
 * index d'`appointments` sont préfixés de `tenant_id` (tenant-isolation §1), et
 * aucun ne sert une plage de dates sans lui. Ajouter un index global aurait
 * demandé une migration Prisma — hors du périmètre de ce ticket — pour aller
 * moins vite qu'une boucle sur `(tenant_id, status, starts_at)`, qui est
 * exactement l'index dont ce filtre a besoin.
 *
 * Le coût est de N requêtes par heure, N étant le nombre d'établissements. À
 * l'échelle du MVP c'est sans commune mesure avec un balayage séquentiel ; le
 * jour où N deviendra grand, c'est un index global — donc une migration — qui
 * répondra, pas une requête non scopée écrite à la main.
 */
@Injectable()
export class ReminderSweepRepository {
  public constructor(
    // Balayage inter-tenant : les rappels J-1 de tous les établissements sont
    // planifiés par le même déclencheur, hors de toute requête HTTP — l'usage
    // que `prisma-clients.ts` nomme explicitement. La dérogation s'arrête à
    // cette liste d'identifiants : tout le reste passe par le client scopé.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
  ) {}

  /**
   * Les établissements à balayer, dans un ordre stable.
   *
   * Non borné, délibérément : plafonner cette liste ferait silencieusement
   * disparaître les rappels des établissements situés au-delà du plafond, et
   * rien ne le dirait — ni une alarme, ni un journal, ni une cliente. Le plafond
   * du balayage porte sur les **messages produits**, où il est constatable
   * (`truncated`), pas sur les salons servis.
   */
  public async listTenantIds(): Promise<readonly string[]> {
    const rows = await this.prismaUnscoped.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => row.id);
  }

  /**
   * Les rendez-vous de l'établissement courant qui appellent un rappel.
   *
   * **À appeler dans une portée de tenant déjà ouverte** : tout passe par le
   * client scopé, et l'extension refuse la moindre opération sans contexte.
   *
   * Deux filtres, et chacun porte une part d'un critère d'acceptation :
   *
   * 1. `starts_at ∈ [from, to)` — la fenêtre `now+24h → now+25h`, en UTC. C'est
   *    elle qui exclut d'elle-même un rendez-vous pris à moins de 24 h : l'écart
   *    entre maintenant et son début ne fait que décroître, il est déjà sous la
   *    borne basse, et aucune fenêtre à venir ne le rattrapera ;
   * 2. le statut **occupe** encore le créneau — `PENDING` ou `CONFIRMED`. Un
   *    rendez-vous annulé, honoré ou marqué no-show n'a pas de rappel à
   *    recevoir. La liste vient d'`appointment-status.ts`, celle-là même que la
   *    contrainte d'exclusion emploie : deux définitions de « rendez-vous vivant »
   *    auraient fini par diverger.
   *
   * Un troisième critère — « aucun rappel vivant ne le couvre déjà » — ne
   * s'exprime **pas** ici comme un filtre du `where`, et c'est délibéré : la
   * couverture se compte par **canal**, pas par rendez-vous. Un `none` sur le
   * seul type écarterait un rendez-vous dont l'e-mail est parti mais dont le SMS
   * n'a jamais été publié — le cas d'un lot SQS partiellement refusé, que la
   * Lambda rejoue —, et ce canal-là ne serait republié par personne, la fenêtre
   * suivante ne couvrant plus ce rendez-vous. Les canaux déjà couverts
   * ressortent donc dans `liveChannels`, et c'est le service qui les retire.
   * L'unicité, elle, reste tranchée par `notifications_live_once` à l'envoi
   * (#68).
   *
   * `tenant_id` n'est pas dans la projection : le domaine n'en a pas l'usage —
   * l'appelant le connaît, c'est lui qui a ouvert la portée — et ce qui ne sort
   * pas ne peut pas fuiter (tenant-isolation §4).
   */
  public async findDueAppointments(
    window: { readonly from: Date; readonly to: Date },
    limit: number,
  ): Promise<readonly Omit<DueReminder, 'tenantId'>[]> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        startsAt: { gte: window.from, lt: window.to },
        status: { in: [...OCCUPYING_STATUSES] },
      },
      select: {
        id: true,
        clientId: true,
        startsAt: true,
        // Les coordonnées ne sortent pas de cette méthode : elles sont réduites
        // ici même à deux booléens, comme le fait `findRecipientContact`. Les
        // lire dans la même requête que le rendez-vous évite une requête par
        // rendez-vous, ce qui compte sur un balayage qui en traite un lot.
        //
        // `emailSuppressedAt` est lu pour la même raison, et rejoint les deux
        // autres dans le même booléen : une adresse supprimée n'est pas un canal
        // (#73). Sans lui, le balayage publierait chaque heure des rappels pour
        // une boîte morte, que l'expédition écarterait un à un — du travail pour
        // rien, et une file qui grossit de messages sans objet.
        client: { select: { email: true, phone: true, emailSuppressedAt: true } },
        // Les canaux déjà couverts par un rappel vivant, et rien d'autre de la
        // ligne de journal : ni statut, ni horodatage, ni accusé.
        notifications: {
          where: {
            type: 'REMINDER_24H',
            status: { in: [...LIVE_NOTIFICATION_STATUSES] },
          },
          select: { channel: true },
        },
      },
      // `starts_at` d'abord : quand le plafond tronque, ce sont les rendez-vous
      // les plus proches qui partent — ceux dont le rappel a le moins de marge.
      // `id` départage, faute de quoi deux rendez-vous à la même minute
      // s'ordonneraient au gré du planificateur et la troncature ne serait pas
      // reproductible.
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    return rows.map((row) => ({
      appointmentId: row.id,
      clientId: row.clientId,
      startsAt: row.startsAt,
      hasEmail: row.client.email.length > 0 && row.client.emailSuppressedAt === null,
      hasSms: isDialableNumber(row.client.phone),
      liveChannels: row.notifications.map((notification) => notification.channel),
    }));
  }
}
