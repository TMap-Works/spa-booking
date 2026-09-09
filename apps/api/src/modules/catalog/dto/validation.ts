import { DURATION_MINUTES_MAX } from '@spa/shared';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { z, type ZodTypeAny } from 'zod';

/**
 * Ce qui **survit** à la substitution du contrat partagé dans `catalog` (#510),
 * et rien de plus.
 *
 * Les corps de requête du module ne passent plus par `class-validator` : ils
 * sont validés par les schémas de `@spa/shared`, montés sur le paramètre du
 * handler par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * Ce fichier ne porte donc plus que deux familles, et il faut savoir laquelle
 * est laquelle avant d'y ajouter quoi que ce soit :
 *
 * 1. **les briques des DTO de chaîne de requête** — `OptionalPresent` et
 *    `BooleanQuery`. Ces trois DTO-là restent sous `class-validator` faute de
 *    schéma de requête dans le contrat ; voir la note d’écart qui les
 *    accompagne dans `service.dto.ts` ;
 * 2. **les bornes publiées dans `/api/docs`**, et plus aucune borne validée ici :
 *    depuis #554 le plafond des durées lui-même vient du contrat, et les
 *    constantes ci-dessous n'en sont que le relais pour les `minimum` et
 *    `maximum` de la documentation. Toutes les autres — longueur d'un libellé,
 *    d'un slug, d'une description, plafond d'un montant — sont importées de
 *    `@spa/shared` par les fichiers qui les documentent.
 *
 * ## Le piège d'homonymie, constaté valeur par valeur avant de substituer
 *
 * Le marqueur que ce fichier portait le nommait, et deux cas s'y sont
 * effectivement présentés. Substituer sur la foi du nom aurait déplacé une
 * borne sans qu'aucun test ne le dise :
 *
 * | Ici | Dans `@spa/shared` | Verdict |
 * |---|---|---|
 * | `DISPLAY_NAME_MAX_LENGTH` = 160 | `DISPLAY_NAME_MAX_LENGTH` = 160 | substitué |
 * | — | `NAME_MAX_LENGTH` = **80** | *jamais* : c'est la borne d'un prénom, pas d'un libellé de catalogue |
 * | `SLUG_MAX_LENGTH` = 63 | `SLUG_MAX_LENGTH` = 63 | substitué, via `catalog.slug` |
 * | `DESCRIPTION_MAX_LENGTH` = 2000 | `LONG_TEXT_MAX_LENGTH` = 2000 | substitué — même valeur, autre nom |
 * | `MAX_AMOUNT_MINOR` = 2 147 483 647 | `AMOUNT_MINOR_MAX` = 2 147 483 647 | substitué |
 * | `MIN_AMOUNT_MINOR` = **0** | `AMOUNT_MINOR_MIN` = **−2 147 483 648** | *jamais* : les deux noms sont l'anagramme l'un de l'autre et ne valent pas la même chose. Le plancher d'un prix est celui de `nonNegativeMoneySchema`, pas celui de la colonne. La constante locale est conservée sous le nom `NON_NEGATIVE_AMOUNT_MINOR_FLOOR`, qui ne se confond avec rien |
 */

/**
 * Bornes des durées, en minutes — **publiées ici, validées par le contrat**.
 *
 * Les planchers (`1` pour un soin, `0` pour un tampon) sont ceux
 * qu'appliquent déjà `durationMinutesSchema` et `bufferMinutesSchema` de
 * `@spa/shared` : ils ne sont plus validés ici, ils sont **publiés** ici, dans
 * les `minimum` que lit `/api/docs`.
 *
 * Le plafond, lui, a longtemps été validé ici — et c'était un écart assumé. Le
 * contrat ne bornait les durées par le haut nulle part, là où les DTO le
 * faisaient à `MAX_DURATION_MINUTES`, et relâcher l'API pour l'aligner aurait
 * changé la nature de l'échec sur une saisie absurde : `duration_minutes` est
 * un `integer` PostgreSQL, et une valeur au-delà de 2³¹ sortirait en
 * `numeric value out of range` — un 500 là où l'appelant recevait un 400
 * nommant le champ. C'est le sens que l'ADR 0008 refuse explicitement pour la
 * version d'UUID : on resserre le contrat, on ne relâche pas l'API.
 *
 * #554 a fait ce resserrement : `DURATION_MINUTES_MAX` vit désormais dans
 * `@spa/shared`, appliqué par `durationMinutesSchema` et `bufferMinutesSchema`
 * eux-mêmes. La constante ci-dessous n'est plus qu'un **alias de publication**,
 * pour que `/api/docs` annonce la borne que le contrat applique — et non une
 * seconde valeur susceptible d'en diverger.
 *
 * Le plafond de vingt-quatre heures ne protège d'aucun scénario métier : il
 * borne l'absurde avant qu'il n'atteigne le calcul de créneaux et la colonne.
 */
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = DURATION_MINUTES_MAX;
export const MIN_BUFFER_MINUTES = 0;

/**
 * Plancher d'un prix — `0`, un soin offert.
 *
 * **Ce n'est pas `AMOUNT_MINOR_MIN`** de `@spa/shared`, qui vaut
 * −2 147 483 648 : celui-là est la borne basse de la colonne `integer`, celle
 * que `moneySchema` applique aux montants signés (un remboursement, un écart de
 * caisse). Le prix d'une prestation, lui, passe par `nonNegativeMoneySchema`,
 * dont le plancher est zéro. Publier l'autre dans `/api/docs` annoncerait un
 * prix négatif que la route refuse en 400 — le sens dangereux de l'écart, celui
 * que l'ADR 0008 ferme.
 *
 * La valeur n'est pas validée ici : `nonNegativeMoneySchema` s'en charge. Elle
 * est publiée, comme les planchers de durée.
 */
export const NON_NEGATIVE_AMOUNT_MINOR_FLOOR = 0;

/**
 * Code devise ISO 4217, tel que `currencyCodeSchema` l'impose après passage en
 * majuscules.
 *
 * Déclaré ici parce que le contrat ne l'exporte pas — il le porte en ligne dans
 * `currencyCodeSchema`. Il ne valide plus rien : il alimente le `pattern` que
 * publie `/api/docs`, pour que la documentation dise la règle que le schéma
 * applique.
 */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Un corps **absent** vaut un corps vide — la propriété que
 * `ValidationPipe.toEmptyIfNil` tenait avant la substitution (#510).
 *
 * Elle ne se voit que sur les corps dont **aucun** champ n'est obligatoire, et
 * les deux `PATCH` de ce module en sont : `PATCH /services/{id}` et
 * `PATCH /service-categories/{id}` répondaient 200 à une requête sans corps —
 * un no-op, mais un no-op qui réussissait.
 *
 * Ce qui a changé : Express 5 et body-parser 2 laissent `req.body` à `undefined`
 * quand la requête ne porte aucun en-tête `Content-Type`, et le `ValidationPipe`
 * global ne le normalise **plus** — il ne normalisait que les paramètres dont la
 * métadonnée est une classe à valider, et le paramètre du handler est désormais
 * typé par un alias, dont la métadonnée émise est `Object`.
 *
 * Enveloppe le schéma plutôt que de modifier le pipe : le correctif reste dans
 * le module qui en a besoin, et les schémas dont un champ **est** obligatoire —
 * la création d'une prestation, celle d'une rubrique — ne changent pas de
 * comportement. `ZodValidationPipe` déballe les `ZodEffects` avant de vérifier
 * `.strict()`, si bien que la garde de champ inconnu reste posée.
 *
 * Jumeau de celui d'`appointments/dto/validation.ts`, dupliqué pour la raison
 * qui vaut déjà pour `OptionalPresent` et `BooleanQuery` : un module n'importe
 * pas un fichier profond d'un autre (api-module §3).
 */
export function optionalBody<TSchema extends ZodTypeAny>(
  schema: TSchema,
): z.ZodEffects<TSchema, z.output<TSchema>, unknown> {
  return z.preprocess((value) => value ?? {}, schema);
}

/**
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` de class-validator confond les deux : il ignore les
 * validateurs aussi bien sur `undefined` que sur `null`, si bien qu'un `null`
 * explicite traverserait la validation et descendrait jusqu'à une colonne
 * `NOT NULL`. Ce décorateur-ci ne laisse passer que l'absence — un `null`
 * déclenche les validateurs, donc un 400 qui nomme le champ.
 *
 * Ne sert plus qu'aux DTO de chaîne de requête : les corps, eux, tiennent la
 * distinction du contrat, où `.optional()` et `.nullable()` sont deux choses.
 */
export const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * Lit un booléen de chaîne de requête.
 *
 * `enableImplicitConversion` est délibérément désactivé pour toute
 * l'application — sans quoi `"12abc"` passerait pour `12` sur un champ
 * `number`. Une valeur non reconnue est rendue **telle quelle** plutôt que
 * transformée en `false` : c'est `@IsBoolean()` qui la refuse ensuite, en 400
 * nommant le champ, là où un `false` silencieux aurait servi une liste que
 * personne n'a demandée.
 *
 * C'est cette conversion-là qui interdit de substituer les DTO de requête en
 * l'état : une chaîne de requête arrive en `string`, et aucun schéma du contrat
 * ne coerce. Voir la note d’écart de `service.dto.ts`.
 */
export const BooleanQuery = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (value === 'true') {
      return true;
    }
    return value === 'false' ? false : value;
  });
