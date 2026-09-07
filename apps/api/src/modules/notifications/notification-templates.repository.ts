import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type {
  NotificationChannel,
  NotificationTemplateSource,
  NotificationType,
  StoredNotificationTemplate,
} from './notifications.types';

/**
 * Accès Prisma aux **personnalisations de modèles** — #69.
 *
 * Le second fichier du module qui connaisse le schéma, à côté de
 * `notifications.repository.ts` (api-module §2). Séparé de lui délibérément :
 * l'un est une prise de droit sous concurrence, l'autre un enregistrement de
 * configuration. Les mêler aurait fait un fichier dont la moitié se relit comme
 * une section critique et l'autre comme un formulaire.
 *
 * ## Tout passe par le client scopé, sans exception
 *
 * Cette table est celle qui décide de ce que les clientes de chaque salon
 * reçoivent : une lecture qui échapperait au filtre de tenant servirait le modèle
 * d'un concurrent, et une écriture qui y échapperait réécrirait ses messages.
 * Il n'y a donc ici **aucun** usage de `prismaUnscoped`, et il n'y en aura pas :
 * les modèles de la plateforme n'étant pas en base, aucun traitement de ce
 * fichier n'est légitimement inter-tenant.
 *
 * ## Pourquoi `updateMany` puis `create`, et non `upsert`
 *
 * `upsert` de Prisma exige un `where` **unique**, donc ici la clé composite
 * `(tenant_id, type, channel)` — dont le premier membre est précisément ce que le
 * repository n'a pas le droit de connaître : c'est l'extension de scoping qui le
 * pose depuis le contexte (tenant-isolation §3). Le composer à la main aurait
 * demandé de lire le tenant courant dans ce fichier, c'est-à-dire de rouvrir la
 * porte que l'extension existe pour fermer.
 *
 * La séquence retenue s'en passe : `updateMany` filtre sur `(type, channel)` et
 * l'extension y ajoute le tenant ; si rien n'a bougé, `create` insère et
 * l'extension y pose le tenant. Le conflit d'unicité — deux enregistrements
 * concurrents du même modèle — est rattrapé par une seconde mise à jour, et non
 * par une erreur : deux personnes du même salon qui enregistrent en même temps
 * doivent obtenir le dernier texte écrit, pas un 500.
 */

/** Code Prisma d'une violation d'unicité — `23505` côté PostgreSQL. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `notifications.repository.ts`
 * et `payments.repository.ts` : le type généré exige `tenantId` — la colonne est
 * `NOT NULL` — alors que le repository ne doit justement pas le fournir.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * La projection lue par ce dépôt.
 *
 * Ni `id`, ni `tenant_id`, ni `created_at` : le domaine désigne un modèle par
 * `(type, channel)`, jamais par son identifiant de ligne, et ce qui ne sort pas
 * ne peut pas fuiter (tenant-isolation §4). `updated_at` sort, lui, parce que le
 * back-office a besoin de dire « personnalisé le … ».
 */
const TEMPLATE_SELECT = {
  type: true,
  channel: true,
  subject: true,
  bodyHtml: true,
  bodyText: true,
  updatedAt: true,
} as const;

interface TemplateRow {
  type: string;
  channel: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  updatedAt: Date;
}

function toStoredTemplate(row: TemplateRow): StoredNotificationTemplate {
  return {
    // Les deux énumérations du schéma sont reprises telles quelles : le témoin de
    // `notifications.types.ts` garantit que les libellés coïncident.
    type: row.type as NotificationType,
    channel: row.channel as NotificationChannel,
    source: { subject: row.subject, html: row.bodyHtml, text: row.bodyText },
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

@Injectable()
export class NotificationTemplatesRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Toutes les personnalisations de l'établissement.
   *
   * Six lignes au plus — trois messages, deux canaux —, d'où l'absence de
   * plafond : la borne est celle de l'énumération, pas celle d'un `take`.
   */
  public async findAll(): Promise<readonly StoredNotificationTemplate[]> {
    const rows = await this.prisma.notificationTemplate.findMany({
      select: TEMPLATE_SELECT,
      orderBy: [{ type: 'asc' }, { channel: 'asc' }],
    });

    return rows.map(toStoredTemplate);
  }

  /**
   * La personnalisation de ce message, si le salon en a écrit une.
   *
   * `null` veut dire « rien de personnalisé » — pas « rien à envoyer » : c'est
   * l'appelant qui retombe alors sur le modèle de la plateforme.
   */
  public async find(
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<StoredNotificationTemplate | null> {
    const row = await this.prisma.notificationTemplate.findFirst({
      where: { type, channel },
      select: TEMPLATE_SELECT,
    });

    return row === null ? null : toStoredTemplate(row);
  }

  /** Enregistre — ou remplace — la personnalisation de ce message. */
  public async save(
    type: NotificationType,
    channel: NotificationChannel,
    source: NotificationTemplateSource,
  ): Promise<StoredNotificationTemplate> {
    const data = { subject: source.subject, bodyHtml: source.html, bodyText: source.text };

    const { count } = await this.prisma.notificationTemplate.updateMany({
      where: { type, channel },
      data,
    });

    if (count === 0) {
      await this.insertOrOverwrite(type, channel, data);
    }

    // Relu plutôt que déduit : `updated_at` est posé par Prisma à l'écriture, et
    // le composer ici ferait afficher au back-office une date qui n'est pas celle
    // de la ligne.
    const saved = await this.find(type, channel);

    if (saved === null) {
      // Inatteignable en pratique : une suppression concurrente entre l'écriture
      // et la relecture. Lever nomme la course plutôt que de rendre un modèle
      // inventé.
      throw new Error(`Le modèle ${type}/${channel} a disparu entre son écriture et sa relecture.`);
    }

    return saved;
  }

  /**
   * Efface la personnalisation — l'établissement revient au modèle par défaut.
   *
   * Rend `true` si une ligne a été effacée. `false` n'est pas une erreur : le
   * salon employait déjà le défaut, et c'est exactement l'état demandé. C'est ce
   * qui rend le retour au défaut idempotent.
   */
  public async remove(type: NotificationType, channel: NotificationChannel): Promise<boolean> {
    const { count } = await this.prisma.notificationTemplate.deleteMany({
      where: { type, channel },
    });

    return count > 0;
  }

  /**
   * Insère la ligne, ou réécrit celle qu'une écriture concurrente a posée.
   *
   * Le rattrapage de la violation d'unicité n'est pas défensif au sens large : il
   * ferme une course réelle et courante — deux onglets du back-office, ou un
   * double clic — et la conduite attendue est « le dernier texte écrit gagne »,
   * pas « une des deux personnes reçoit un 500 ».
   */
  private async insertOrOverwrite(
    type: NotificationType,
    channel: NotificationChannel,
    data: { subject: string; bodyHtml: string; bodyText: string },
  ): Promise<void> {
    try {
      await this.prisma.notificationTemplate.create({
        data: withScopedTenant<Prisma.NotificationTemplateUncheckedCreateInput>({
          type,
          channel,
          ...data,
        }),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      await this.prisma.notificationTemplate.updateMany({ where: { type, channel }, data });
    }
  }
}
