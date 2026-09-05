import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/**
 * Briques de validation du module `payments` (#62).
 *
 * ## Pourquoi ce fichier existe alors que trois voisins en ont un identique
 *
 * `appointments/dto/validation.ts`, `availability/dto/validation.ts` et
 * `catalog/dto/validation.ts` portent déjà la lecture d'une date-heure à offset
 * explicite. Elle est **dupliquée** plutôt qu'importée, et ce n'est pas un
 * oubli : un module n'importe pas un fichier profond d'un autre (api-module §3),
 * et la place définitive de ces primitives est `@spa/shared` — c'est l'objet de
 * #26, qui ajoutera la dépendance à `apps/api/package.json`. Les noms sont donc
 * **ceux du paquet partagé**, pour que la substitution ne change pas une borne
 * en silence.
 *
 * Ce fichier-ci n'en reprend que ce dont l'historique des ventes et des
 * transactions a besoin : les bornes `from` et `to` de sa fenêtre. Recopier les
 * six autres primitives « au cas où » aurait fait six duplicatas à faire vivre
 * pour zéro appelant.
 */

/**
 * ISO 8601 avec offset explicite — `Z` ou `±HH:MM`, secondes et fraction
 * facultatives.
 *
 * Jumeau de `OFFSET_DATE_TIME_PATTERN` d'`appointments/dto/validation.ts`, et il
 * doit le rester : la fenêtre d'un rapprochement se pose sur les mêmes instants
 * que ceux qu'un rendez-vous accepte. L'heure est bornée à `00`-`23` — le profil
 * RFC 3339 ne connaît pas `24:00`, et un `\d{2}` complaisant laisserait
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
 * rapprochement décalée de deux jours par une faute de frappe, donc des
 * encaissements qui manquent au total sans qu'aucune erreur ne le dise. La date
 * civile est donc rejouée composant par composant.
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
 * `new Date('2026-03-29T03:30:00')` choisit la troisième, en silence. Sur une
 * fenêtre de rapprochement, ce silence-là déplace la frontière d'un jour de
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
 * Bornes de la pagination — celles de `CustomerPageDto`, et volontairement les
 * mêmes.
 *
 * TODO(#26) : ce sont `DEFAULT_PAGE_SIZE` et `MAX_PAGE_SIZE` de `@spa/shared`.
 * Deux écrans de back-office qui pagineraient différemment obligeraient le front
 * à savoir lequel il regarde.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Borne haute du numéro de page — celle au-delà de laquelle `(page - 1) *
 * pageSize` cesse d'être un entier exact.
 *
 * `@IsInt()` ne juge pas la magnitude : `Number.isInteger(1e30)` vaut `true`, si
 * bien que `?page=1e30` traverse la validation et arrive au dépôt en un `skip`
 * hors des bornes du `bigint` de PostgreSQL — donc une erreur du moteur remontée
 * en 500 là où le contrat annonce un 400 nommant le champ.
 */
export const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE);

/**
 * Les deux paramètres de pagination, dont les deux historiques de #62 héritent.
 *
 * Une classe de base plutôt que deux copies : c'est ce qui garantit que les
 * bornes — et donc les codes d'erreur — sont les mêmes sur les deux écrans.
 *
 * `@Type(() => Number)` est **nécessaire** : une query string ne transporte que
 * des chaînes, et le `ValidationPipe` global est en
 * `enableImplicitConversion: false` — `?page=2` arriverait sinon en `'2'` et
 * `@IsInt()` le refuserait.
 */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page : entier attendu' })
  @Min(1)
  @Max(MAX_PAGE)
  public page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize : entier attendu' })
  @Min(1)
  // Plafond **serveur**, non négociable par le client : sans lui,
  // `?pageSize=100000` est un déni de service à une requête.
  @Max(MAX_PAGE_SIZE)
  public pageSize?: number;
}

/** Les valeurs par défaut de la pagination, appliquées une fois. */
export function toPageBounds(dto: PageQueryDto): { page: number; pageSize: number } {
  return { page: dto.page ?? 1, pageSize: dto.pageSize ?? DEFAULT_PAGE_SIZE };
}

/**
 * La borne d'une fenêtre, telle que le domaine la lit — ou rien.
 *
 * La conversion se fait **à la frontière**, une fois : passé ce point, plus
 * aucune couche n'a à se demander dans quel référentiel elle lit un horodatage.
 * `@IsOffsetDateTime()` a déjà refusé tout ce qui n'est pas un instant réel à
 * offset explicite, si bien que `new Date(...)` est ici sans ambiguïté.
 */
export function toWindowBound(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
