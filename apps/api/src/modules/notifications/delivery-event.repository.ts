import { Inject, Injectable } from '@nestjs/common';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import type { EmailSuppressionReason } from './notifications.types';

/**
 * Les écritures de l'ingestion des événements de remise SES (#73).
 *
 * Un fichier à part de `notifications.repository.ts`, pour la raison **exacte**
 * qui a fait naître `reminder-sweep.repository.ts` : c'est ici, et nulle part
 * ailleurs dans le module, que le client non scopé est injecté.
 * `prisma-clients.ts` exige de chaque dérogation qu'elle se voie, et regrouper
 * la dérogation dans un fichier dont le nom annonce le traitement rend la
 * relecture de `grep -rn PRISMA_UNSCOPED apps/api/src` immédiate.
 *
 * ## Pourquoi l'ingestion est inter-tenant, alors que la donnée ne l'est pas
 *
 * L'événement SES ne porte **que des adresses**. Pas d'établissement, pas de
 * compte, pas de rendez-vous : SES ne connaît rien de notre découpage, il
 * connaît une boîte aux lettres qui a refusé un message. Or la même personne
 * peut être cliente de trois salons, et sa fiche existe alors trois fois — une
 * ligne `users` par établissement, c'est ce que garantit
 * `@@unique([tenantId, email])`.
 *
 * Supprimer l'adresse chez un seul d'entre eux laisserait les deux autres
 * continuer d'écrire à une boîte morte, et la réputation d'envoi qu'ils
 * dégraderaient est celle du **domaine**, donc la leur à tous. Le balayage
 * traverse donc les établissements, comme le fait celui du rappel J-1, et pour
 * une raison du même ordre : le déclencheur est extérieur à toute requête HTTP.
 *
 * ## Deux clients, et la frontière passe entre eux
 *
 * | Client | Ce qu'il lit ou écrit | Pourquoi |
 * |---|---|---|
 * | `prismaUnscoped` | `tenants.id`, et **rien d'autre** | il n'existe aucun tenant courant : l'événement vient d'une file SQS, hors de toute requête, et il concerne tous les établissements à la fois |
 * | `prisma` (scopé) | `users`, un établissement à la fois | chaque lecture et chaque écriture se fait dans une portée ouverte par l'appelant ; l'extension pose le `tenant_id`, exactement comme dans une requête |
 *
 * La dérogation est donc réduite à **une liste d'identifiants**. Aucune donnée
 * personnelle ne sort du client scopé, et une fuite inter-tenant ne peut pas se
 * produire par oubli d'un `where` : il n'y a pas de `where` à écrire.
 *
 * ## Ce qu'il ne journalise pas
 *
 * Les adresses. Elles traversent ce fichier — c'est bien par elles qu'on cherche
 * — mais elles ne ressortent d'aucune méthode et n'entrent dans aucun message.
 * notifications §7 l'interdit, et une adresse dans un journal de Lambda y reste
 * aussi longtemps que la rétention du groupe.
 */
@Injectable()
export class DeliveryEventRepository {
  public constructor(
    // Ingestion inter-tenant : un rebond SES désigne une adresse, jamais un
    // établissement, et la même adresse peut être cliente de plusieurs salons —
    // l'usage que `prisma-clients.ts` nomme explicitement. La dérogation
    // s'arrête à cette liste d'identifiants : tout le reste passe par le client
    // scopé.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
  ) {}

  /**
   * Les établissements à visiter, dans un ordre stable.
   *
   * Non bornée, délibérément, pour la raison qui vaut déjà dans
   * `ReminderSweepRepository.listTenantIds` : plafonner cette liste ferait
   * silencieusement échapper à la suppression les établissements situés
   * au-delà du plafond, et rien ne le dirait. Une adresse morte y resterait
   * sollicitée sans qu'aucune alarme ne le voie.
   */
  public async listTenantIds(): Promise<readonly string[]> {
    const rows = await this.prismaUnscoped.tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => row.id);
  }

  /**
   * Marque comme supprimées les adresses de cet établissement, et rend le nombre
   * de lignes touchées.
   *
   * **À appeler dans une portée de tenant déjà ouverte** : tout passe par le
   * client scopé, et l'extension refuse la moindre opération sans contexte.
   *
   * ## Une seule écriture, et pourquoi `updateMany` plutôt qu'un `update` par
   * adresse
   *
   * Un `IN (…)` sur `(tenant_id, email)` sert l'unique posé par la migration
   * initiale : c'est une lecture indexée, quel que soit le nombre d'adresses de
   * l'événement — SES en groupe jusqu'à plusieurs par rebond. Une boucle
   * d'`update` aurait fait autant d'allers-retours que d'adresses, multipliés
   * par le nombre d'établissements.
   *
   * ## `emailSuppressedAt: null` dans le filtre : l'idempotence, et rien d'autre
   *
   * SQS garantit **au-moins-une-fois**, et le même rebond sera rejoué. Sans ce
   * filtre, le rejeu réécrirait la date de suppression et effacerait l'instant
   * où la boîte est réellement morte — une information qu'un comptoir lit pour
   * décider s'il faut redemander l'adresse à sa cliente. Avec lui, le rejeu rend
   * `0`, ce que l'appelant journalise pour ce que c'est : la file faisant ce
   * qu'elle promet.
   *
   * Le corollaire est assumé : une adresse déjà supprimée pour `HARD_BOUNCE` qui
   * porte ensuite plainte **garde** son premier motif. Les deux disent la même
   * chose au comptoir — n'écrivez plus ici — et le premier est celui qui date de
   * l'instant où l'adresse a cessé d'être joignable.
   *
   * ## Les deux colonnes sont écrites ensemble
   *
   * C'est l'invariant que la migration documente et qu'aucun `CHECK` ne porte :
   * une adresse supprimée sans motif ne dirait pas au comptoir ce qu'il faut
   * expliquer à la cliente, et un motif sans date ne dirait pas depuis quand.
   * Cette méthode est l'**unique** chemin d'écriture de ces deux colonnes, ce qui
   * est précisément ce qui rend l'invariant tenable sans contrainte.
   */
  public async suppressEmails(
    addresses: readonly string[],
    reason: EmailSuppressionReason,
    suppressedAt: Date,
  ): Promise<number> {
    if (addresses.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.user.updateMany({
      where: { email: { in: [...addresses] }, emailSuppressedAt: null },
      data: { emailSuppressedAt: suppressedAt, emailSuppressionReason: reason },
    });

    return count;
  }
}
