import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';

/**
 * Briques de validation partagées par les DTO du module `catalog`.
 *
 * Les bornes reprennent **exactement** les largeurs de `schema.prisma`. Ce n'est
 * pas de la duplication décorative : une borne plus large que la colonne produit
 * un 500 sur un `VARCHAR` trop court là où l'appelant attendait un message de
 * champ. Les deux se corrigent ensemble.
 *
 * TODO(#26) : ces valeurs sont celles de `@spa/shared`
 * (`packages/shared/src/constants/limits.ts`) et devront en être importées le
 * jour où `apps/api` dépendra du paquet — voir le même TODO dans
 * `catalog.types.ts`. Les noms sont donc **ceux du paquet partagé**, et pas
 * seulement les valeurs : un homonyme local qui ne vaudrait pas la même chose
 * que celui de `@spa/shared` ferait de la substitution un changement de borne
 * silencieux. C'est le cas de `NAME_MAX_LENGTH` là-bas — 80, pour un prénom ou
 * un nom — quand la borne d'un libellé de catalogue est
 * `DISPLAY_NAME_MAX_LENGTH`.
 */

/** `VARCHAR(160)` — nom de prestation, nom de catégorie. */
export const DISPLAY_NAME_MAX_LENGTH = 160;

/**
 * Slug : la longueur d'un label DNS (63), pas la largeur de la colonne (80).
 *
 * Le sens du décalage compte — une borne **plus étroite** que la colonne refuse
 * proprement en 422, une borne plus large produit un 500.
 *
 * La borne et le motif viennent de `catalog.slug.ts`, qui **dérive** les slugs :
 * les redéclarer ici laisserait le DTO refuser en 400 une forme que le serveur
 * produit pourtant lui-même à partir du nom, le jour où l'un des deux bougerait
 * seul.
 */
export { SLUG_MAX_LENGTH, SLUG_PATTERN } from '../catalog.slug';

/** `VARCHAR(2000)` — description de prestation ou de catégorie. */
export const DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Bornes des durées, en minutes.
 *
 * Le plancher d'une durée de soin est `1` : un rendez-vous de durée nulle
 * produit un intervalle vide, qui ne chevauche rien et passerait sous la
 * contrainte d'exclusion anti-double-réservation sans jamais la déclencher
 * (`CHECK ("duration_minutes" > 0)` en base le refuse aussi). Le plancher d'un
 * tampon est `0` : un soin sans temps de préparation est le cas courant.
 *
 * Le plafond de vingt-quatre heures ne protège d'aucun scénario métier — il
 * borne simplement l'absurde avant qu'il n'atteigne le calcul de créneaux.
 */
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 1440;
export const MIN_BUFFER_MINUTES = 0;

/**
 * Bornes d'un `integer` PostgreSQL, la largeur de `price_amount_minor`.
 *
 * Les valider ici change la nature de l'échec : un dépassement devient un 400
 * nommant le champ, au lieu d'un `numeric value out of range` remonté en 500
 * depuis le pilote. Le plancher est `0` — un soin offert vaut zéro, il n'a
 * jamais un prix négatif — en écho au `CHECK ("price_amount_minor" >= 0)`.
 */
export const MIN_AMOUNT_MINOR = 0;
export const MAX_AMOUNT_MINOR = 2_147_483_647;

/** Code devise ISO 4217, normalisé en majuscules par `NormalizeCurrency`. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` de class-validator confond les deux : il ignore les
 * validateurs aussi bien sur `undefined` que sur `null`, si bien qu'un `null`
 * explicite traverserait la validation et descendrait jusqu'à une colonne
 * `NOT NULL`. Ce décorateur-ci ne laisse passer que l'absence — un `null`
 * déclenche les validateurs, donc un 400 qui nomme le champ.
 *
 * Les champs réellement effaçables, eux, gardent `@IsOptional()` : c'est là que
 * `null` a un sens, et il vaut « efface ce texte ».
 */
export const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * Élague un libellé avant que les bornes ne le jugent.
 *
 * Sans lui, `@MinLength(1)` laisse passer `"   "` — trois espaces font trois
 * caractères — et le catalogue se retrouve avec une prestation sans nom
 * lisible, introuvable dans la liste du back-office. C'est aussi ce que fait
 * `displayNameSchema` / `longTextSchema` dans `@spa/shared` (`.trim()` avant
 * `.min(1)`) : l'API ne doit pas accepter ce que le contrat refuse.
 *
 * Rend la valeur telle quelle si ce n'est pas une chaîne — un `null` d'effacement
 * doit continuer à valoir « efface », et un type inattendu doit être refusé par
 * son validateur, pas transformé ici.
 */
export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Met le code devise en majuscules : `eur` et `EUR` désignent la même devise. */
export const NormalizeCurrency = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

/** Abaisse et élague un slug fourni, avant que le motif ne le juge. */
export const NormalizeSlug = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

/**
 * Lit un booléen de chaîne de requête.
 *
 * `enableImplicitConversion` est délibérément désactivé pour toute
 * l'application — sans quoi `"12abc"` passerait pour `12` sur un champ
 * `number`. Une valeur non reconnue est rendue **telle quelle** plutôt que
 * transformée en `false` : c'est `@IsBoolean()` qui la refuse ensuite, en 400
 * nommant le champ, là où un `false` silencieux aurait servi une liste que
 * personne n'a demandée.
 */
export const BooleanQuery = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (value === 'true') {
      return true;
    }
    return value === 'false' ? false : value;
  });
