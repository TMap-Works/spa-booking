import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import type { ReportExport } from '@spa/shared';

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
