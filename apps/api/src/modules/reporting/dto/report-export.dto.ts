import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID, registerDecorator, type ValidationOptions } from 'class-validator';
import {
  LOCALES,
  REPORT_EXPORT_FALLBACK_LOCALE,
  reportExportLocaleSchema,
  resolveReportExportLocale,
  type Locale,
  type ReportExport,
} from '@spa/shared';

import { ReportWindowQueryDto } from './report-window.dto';

/**
 * L'export du reporting tel que les deux routes le rendent — #563.
 *
 * ## Le DTO reprend le contrat partagé, il ne le redéfinit pas
 *
 * `reportExportSchema` de `@spa/shared` est la source de vérité ; cette classe
 * n'existe que pour décorer les mêmes champs à l'usage de Swagger, que Zod ne
 * sait pas alimenter. Le lien entre les deux est le type de retour de
 * {@link toReportExportDto} : ajouter un champ ici sans l'ajouter au contrat ne
 * compile pas, ce qui est exactement le garde-fou voulu.
 *
 * ## Rien de ce qui est rendu ne désigne un établissement
 *
 * Ni la clé S3, ni le bucket, ni le `tenant_id`. `id` est l'identifiant de
 * l'export **dans le préfixe de l'appelant** : la clé se reconstruit côté
 * serveur à partir du jeton, si bien que le même `id` présenté par un salon
 * voisin ne désigne rien chez lui.
 */
export class ReportExportDto {
  @ApiProperty({
    format: 'uuid',
    description:
      "Identifiant de l’export dans l’espace de l’établissement appelant. Sert à re-signer le fichier une fois l’URL périmée, sans le reproduire.",
  })
  public id!: string;

  @ApiProperty({
    format: 'uri',
    description:
      'URL présignée du fichier CSV. **Éphémère et porteuse** : quiconque la détient lit le fichier jusqu’à `expiresAt`, sans jeton. Ne pas la mettre en cache.',
  })
  public url!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Instant UTC où l’URL cesse de valoir — au plus 15 minutes après son émission.',
  })
  public expiresAt!: string;

  @ApiProperty({
    example: 'maison-lotus-reporting-2026-09-01_2026-09-30.csv',
    description: 'Nom du fichier au téléchargement, préfixé par le slug de l’établissement.',
  })
  public filename!: string;
}

/** L'export du domaine, tel que la route le rend. */
export function toReportExportDto(model: ReportExport): ReportExportDto {
  return {
    id: model.id,
    url: model.url,
    expiresAt: model.expiresAt,
    filename: model.filename,
  };
}

/**
 * Le paramètre de chemin de la route de re-signature.
 *
 * `@IsUUID()` n'est pas une politesse de validation : le fragment est concaténé
 * dans une clé S3, et une clé accepte aussi bien `/` que `..`. Contraindre la
 * forme ici fait qu'aucun chemin ne peut sortir du préfixe de l'établissement —
 * la seconde barrière derrière celle du préfixe lui-même
 * (`export/report-export.key.ts`).
 *
 * Un identifiant mal formé rend donc **400**, avant toute lecture. Ce n'est pas
 * un 404 déguisé : la requête est irrecevable, pas la ressource absente.
 */
export class ReportExportParamsDto {
  @ApiProperty({ format: 'uuid', description: 'Identifiant rendu par la création de l’export.' })
  @IsUUID('4', { message: 'exportId : identifiant d’export invalide' })
  public exportId!: string;
}

/**
 * Refuse toute langue que le contrat partagé ne connaît pas — 400, champ nommé.
 *
 * La validation est **déléguée à `reportExportLocaleSchema`** et non réécrite en
 * décorateurs : c'est le troisième critère de #851, *« cette langue est […]
 * validée par le contrat partagé »*. Un `@IsIn(LOCALES)` aurait tenu le même
 * rôle aujourd'hui et divergé demain — il faut alors se souvenir de le corriger
 * le jour où une troisième langue s'ajoute, et rien ne le rappellerait.
 *
 * Le schéma partagé normalise aussi la casse et les espaces (`submittedLocaleSchema`) :
 * un `?locale=FR` est donc accepté et vaut `fr`. Ce qui est refusé est ce qui ne
 * désigne aucune langue du contrat — `?locale=de`, `?locale=fr-CA`.
 */
function IsReportExportLocale(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isReportExportLocale',
      target: target.constructor,
      propertyName: propertyName as string,
      ...(options === undefined ? {} : { options }),
      validator: {
        validate: (value: unknown) => reportExportLocaleSchema.safeParse(value).success,
        defaultMessage: () =>
          `${String(propertyName)} : langue attendue parmi ${LOCALES.join(', ')}`,
      },
    });
  };
}

/**
 * La demande d'export : la fenêtre des trois rapports, et la langue du fichier.
 *
 * Un DTO à part plutôt qu'un champ ajouté à `ReportWindowQueryDto` : les trois
 * routes de lecture partagent cette classe de base et n'ont **rien** à faire
 * d'une langue — elles rendent des chiffres, que l'écran met en forme lui-même.
 * Seul l'export écrit des mots, parce qu'il écrit un fichier.
 *
 * `locale` est **facultative**, et son absence vaut français : c'est ce que le
 * fichier contenait avant #851, donc ce qu'un appelant antérieur au ticket doit
 * continuer de recevoir. Voir `REPORT_EXPORT_FALLBACK_LOCALE` du contrat
 * partagé, qui porte ce choix pour les deux côtés du fil.
 *
 * `whitelist` et `forbidNonWhitelisted` étant globaux, tout autre paramètre de
 * la chaîne de requête reste refusé — en particulier un `tenantId` glissé là,
 * qui est le scénario de fuite le plus direct (tenant-isolation §2).
 */
export class ReportExportQueryDto extends ReportWindowQueryDto {
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'fr',
    description: `Langue du fichier — en-tête, libellés et séparateurs. Par défaut \`${REPORT_EXPORT_FALLBACK_LOCALE}\`, la langue dans laquelle l’export était écrit avant qu’il ne devienne traduisible. Sans effet sur les chiffres, les devises et le fuseau.`,
  })
  @IsOptional()
  @IsReportExportLocale()
  public locale?: string;
}

/**
 * La langue d'une demande, dans le vocabulaire du domaine.
 *
 * Même rôle que `toReportWindow` pour la fenêtre : la conversion se fait **à la
 * frontière**, une fois, et le service ne reçoit plus qu'une valeur du contrat.
 */
export function toReportExportLocale(dto: ReportExportQueryDto): Locale {
  return resolveReportExportLocale(dto.locale);
}
