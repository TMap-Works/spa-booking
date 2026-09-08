import { ApiPropertyOptional } from '@nestjs/swagger';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, OFFSET_DATE_TIME_PATTERN } from '@spa/shared';
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
 * Briques de validation du module `payments` (#62), **branchées sur le contrat
 * partagé** (#510).
 *
 * ## Ce que ce fichier a cessé de redéclarer
 *
 * Il recopiait trois valeurs que `@spa/shared` porte déjà — le motif de la
 * date-heure à offset explicite, et les deux bornes de pagination. Elles sont
 * désormais **importées**, et la vérification qui a précédé l'import est la
 * seule chose qui rendait la substitution sûre : `OFFSET_DATE_TIME_PATTERN` de
 * `common/time.ts` est caractère pour caractère celui qui était écrit ici,
 * `DEFAULT_PAGE_SIZE` vaut 20 des deux côtés et `MAX_PAGE_SIZE` vaut 100. Aucune
 * borne ne bouge, et il n'y a plus qu'une écriture à faire vivre.
 *
 * L'ADR 0008 ne s'applique pas à ce fichier : il ne décrit pas une **route**,
 * donc il n'y a pas de schéma d'entrée à monter en pipe. Ce qui reste ici est ce
 * que le contrat ne porte pas — voir les deux TODO(#536) plus bas.
 *
 * ## Ce qui reste local, et pourquoi
 *
 * Les deux historiques de #62 paginent et bornent une fenêtre ; leurs DTO sont
 * encore validés par `class-validator`, faute d'un schéma de contrat qui décrive
 * la même chose (`paymentListQuerySchema` filtre sur d'autres critères et ne
 * pagine pas — voir l'en-tête de `cash-payment.dto.ts`). Les décorateurs de ce
 * fichier restent donc la frontière réelle de `GET /payments` et `GET /sales`.
 */

/**
 * `true` si la chaîne est une date-heure ISO 8601 à offset explicite **et**
 * désigne un instant réel.
 *
 * Le motif seul ne suffit pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler — une fenêtre de
 * rapprochement décalée de deux jours par une faute de frappe, donc des
 * encaissements qui manquent au total sans qu'aucune erreur ne le dise. La date
 * civile est donc rejouée composant par composant.
 *
 * TODO(#536) : reste à faire converger cette fonction avec `isOffsetDateTime`
 * de `@spa/shared`, dont le motif est déjà celui importé ci-dessus. Deux écarts
 * l'ont empêché ici, et aucun ne se tranche depuis ce module :
 *
 * 1. **la signature.** Celle du contrat prend une `string` ; celle-ci prend un
 *    `unknown`, parce qu'un validateur `class-validator` reçoit ce que le corps
 *    JSON portait — un nombre, un objet, `null`. Le garde de type est donc ici,
 *    pas là-bas ;
 * 2. **le rejeu de la date civile**, et c'est le vrai écart. `isRealCalendarDate`
 *    passe par `Date.UTC`, qui mappe les années `0`-`99` sur `1900`-`1999` :
 *    `0026-09-01T00:00:00Z` y est **refusé**, là où le `setUTCFullYear` employé
 *    ci-dessous l'accepte. Déléguer resserrerait donc la frontière de ces deux
 *    routes sans que le contrat ait décidé de le faire — et le corriger dans
 *    `packages/shared` déborde l'empreinte de ce ticket, `calendarDateSchema` et
 *    toutes les requêtes de disponibilité en dépendant.
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
 *
 * TODO(#536) : reste à monter `paginationQuerySchema` de `@spa/shared` à la
 * place de ces deux décorateurs. Deux raisons l'ont empêché ici, et la seconde
 * est bloquante :
 *
 * 1. **c'est une classe de base**, dont `ListPaymentsQueryDto` et
 *    `ListSalesQueryDto` héritent en ajoutant `from`, `to` et leurs filtres. Un
 *    pipe monté sur `paginationQuerySchema`, qui est `.strict()`, refuserait ces
 *    champs-là. La substitution demande donc un schéma **par écran**, et le
 *    contrat n'en porte aucun qui décrive ces deux fenêtres ;
 * 2. **`paginationQuerySchema` ne borne pas la magnitude de `page`.** Il n'a que
 *    `.int().min(1)`, là où `MAX_PAGE` ci-dessus existe précisément parce que
 *    `?page=1e30` sort en 500 du pilote PostgreSQL. Substituer **relâcherait**
 *    la frontière de ces routes — le sens interdit par l'ADR 0008, qui ne
 *    referme un écart qu'en resserrant.
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
