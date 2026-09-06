import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, registerDecorator, type ValidationOptions } from 'class-validator';

import type { ReportWindow } from '../reporting.types';

/**
 * La fenêtre d'un rapport, telle qu'elle arrive sur la chaîne de requête.
 *
 * ## Pourquoi ce fichier reprend une validation qu'écrivent déjà quatre voisins
 *
 * `appointments/dto/validation.ts`, `availability/dto/validation.ts`,
 * `catalog/dto/validation.ts` et `payments/dto/validation.ts` portent la même
 * lecture d'une date-heure à offset explicite. Elle est **reprise** plutôt
 * qu'importée, et ce n'est pas un oubli : un module n'importe pas un fichier
 * profond d'un autre (api-module §3), et la place définitive de ces primitives
 * est `@spa/shared` — c'est l'objet de #26. Les noms sont ceux du paquet
 * partagé, pour que la substitution ne change pas une borne en silence.
 *
 * Ce fichier n'en reprend que ce dont les trois rapports ont besoin : leurs deux
 * bornes. Recopier les autres primitives « au cas où » aurait fait des
 * duplicatas à faire vivre pour zéro appelant.
 */

/**
 * ISO 8601 avec offset explicite — `Z` ou `±HH:MM`, secondes et fraction
 * facultatives.
 *
 * Jumeau d'`OFFSET_DATE_TIME_PATTERN` des modules voisins, et il doit le
 * rester : la fenêtre d'un rapport se pose sur les mêmes instants que ceux
 * qu'un rendez-vous accepte. L'heure est bornée à `00`-`23` — le profil RFC 3339
 * ne connaît pas `24:00`, et un `\d{2}` complaisant laisserait
 * `2026-03-29T24:00:00Z` franchir la frontière pour être normalisé, sans un mot,
 * au 30 mars.
 */
export const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * `true` si la chaîne est une date-heure ISO 8601 à offset explicite **et**
 * désigne un instant réel.
 *
 * Le motif seul ne suffit pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler — une fenêtre de
 * rapport décalée de deux jours par une faute de frappe, donc un chiffre
 * d'affaires faux sans qu'aucune erreur ne le dise. La date civile est donc
 * rejouée composant par composant.
 */
export function isOffsetDateTime(value: unknown): boolean {
  if (typeof value !== 'string' || !OFFSET_DATE_TIME_PATTERN.test(value)) {
    return false;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  const replayed = new Date(0);
  replayed.setUTCFullYear(year, month - 1, day);

  return (
    replayed.getUTCFullYear() === year &&
    replayed.getUTCMonth() === month - 1 &&
    replayed.getUTCDate() === day
  );
}

/**
 * Refuse toute date-heure sans offset explicite, en 400 nommant le champ.
 *
 * Une date-heure nue (`2026-03-29T03:30:00`) n'a de sens que rapportée à un
 * fuseau, et le serveur ne peut que **deviner** lequel : celui du salon ? celui
 * du navigateur ? celui de la machine, qui n'est le fuseau de personne ?
 * `new Date('2026-03-29T03:30:00')` choisit la troisième, en silence. Sur la
 * fenêtre d'un rapport, ce silence-là déplace la frontière d'une journée de
 * caisse.
 */
export function IsOffsetDateTime(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isOffsetDateTime',
      target: target.constructor,
      propertyName: propertyName as string,
      ...(options === undefined ? {} : { options }),
      validator: {
        validate: (value: unknown) => isOffsetDateTime(value),
        defaultMessage: () =>
          `${String(propertyName)} : date-heure ISO 8601 avec offset explicite (Z ou ±HH:MM)`,
      },
    });
  };
}

/**
 * Les deux bornes que les trois rapports partagent — `from` **inclus**, `to`
 * **exclu**.
 *
 * Une classe de base plutôt que trois copies : c'est ce qui garantit que les
 * trois écrans du même tableau de bord ont la même idée d'une période, et donc
 * qu'ils répondent tous trois de la même fenêtre.
 *
 * **Les deux sont obligatoires**, à la différence de l'historique de
 * rapprochement de #62 dont les bornes sont facultatives. Un rapport sans borne
 * balaierait toute l'histoire de l'établissement à chaque ouverture d'écran, ce
 * que le cinquième critère de #74 interdit en pratique — et un tableau de bord
 * regarde toujours une période, l'y obliger ne retire donc aucun usage.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans la chaîne de requête, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). L'établissement vient du jeton vérifié, et de lui seul.
 *
 * Ce que ce DTO ne valide **pas** : l'ordre des bornes et l'étendue de la
 * fenêtre. Ce sont des relations entre deux champs par ailleurs bien formés, et
 * api-module §5 les range dans la règle métier — 422, levé par
 * `assertReportWindow`, jamais 400.
 */
export class ReportWindowQueryDto {
  @ApiProperty({
    example: '2026-09-01T00:00:00Z',
    description: 'Début de la fenêtre, **inclus**. ISO 8601 à offset explicite.',
  })
  @IsString()
  @IsNotEmpty({ message: 'from : borne de début requise' })
  @IsOffsetDateTime()
  public from!: string;

  @ApiProperty({
    example: '2026-10-01T00:00:00Z',
    description: 'Fin de la fenêtre, **exclue** — deux périodes se posent bout à bout.',
  })
  @IsString()
  @IsNotEmpty({ message: 'to : borne de fin requise' })
  @IsOffsetDateTime()
  public to!: string;
}

/**
 * La fenêtre, dans le vocabulaire du domaine.
 *
 * La conversion se fait **à la frontière**, une fois : passé ce point, plus
 * aucune couche n'a à se demander dans quel référentiel elle lit un horodatage.
 * `@IsOffsetDateTime()` a déjà refusé tout ce qui n'est pas un instant réel à
 * offset explicite, si bien que `new Date(...)` est ici sans ambiguïté.
 */
export function toReportWindow(dto: ReportWindowQueryDto): ReportWindow {
  return { from: new Date(dto.from), to: new Date(dto.to) };
}

/** La fenêtre telle que l'API la rend — les deux instants, en UTC. */
export class ReportWindowDto {
  @ApiProperty({ format: 'date-time', description: 'Début inclus, normalisé en UTC.' })
  public from!: string;

  @ApiProperty({ format: 'date-time', description: 'Fin exclue, normalisée en UTC.' })
  public to!: string;
}

/** Réécrit la fenêtre du domaine en ISO — l'inverse de `toReportWindow`. */
export function toReportWindowDto(window: ReportWindow): ReportWindowDto {
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}
