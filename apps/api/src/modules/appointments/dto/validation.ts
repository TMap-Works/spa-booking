import { registerDecorator, ValidateIf, type ValidationOptions } from 'class-validator';
import { z, type ZodTypeAny } from 'zod';

/**
 * Briques de validation du module `appointments` (#37).
 *
 * ## Ce que ce fichier ne redéclare plus (#404)
 *
 * Les bornes et le motif de date-heure **viennent du contrat partagé**, ils n'y
 * sont plus alignés à la main. C'était l'objet du marqueur `#26` que portait ce
 * fichier, et le troisième critère de #404 : une borne écrite à deux endroits
 * finit par diverger, et l'écart entre la borne du DTO et celle du contrat est
 * exactement ce que #401 a trouvé sur `emailSchema`.
 *
 * ## Ce qu'il reste, après #510
 *
 * Presque rien, et c'est le résultat attendu : les six corps du module sont
 * passés aux schémas du contrat, montés par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * Ce fichier ne garde donc que ce qu'aucun schéma ne peut porter :
 *
 * - la lecture d'une **date civile**, qui garde la chaîne de requête de l'agenda
 *   — le seul DTO du module encore validé par `class-validator`, et son
 *   note d’écart dit pourquoi ;
 * - `OptionalPresent`, la brique de ce même DTO ;
 * - `optionalBody`, qui rattrape ce que le pipe global ne normalise plus.
 *
 * Les bornes, les décorateurs de date-heure, l'élagage et la canonisation
 * d'adresse ont disparu avec leurs derniers porteurs — les notes qui suivent
 * disent lesquels, pour qu'on ne les réécrive pas.
 *
 * ## Pourquoi ce fichier existe alors que ses voisins en ont un identique
 *
 * `catalog/dto/validation.ts` et `availability/dto/validation.ts` portent aussi
 * `OptionalPresent` et — pour le second — la lecture d'une date-heure à offset
 * explicite. Ils sont **dupliqués** plutôt qu'importés, et ce n'est pas un
 * oubli : un module n'importe pas un fichier profond d'un autre (api-module §3).
 * Leur place définitive est du côté des schémas du contrat, à mesure que les DTO
 * qui les emploient sont substitués.
 *
 * `appointments/__tests__/date-time.validation.spec.ts` et
 * `packages/shared/src/__tests__/schemas.spec.ts` exercent les mêmes chaînes de
 * part et d'autre. Elles ne gardent plus deux motifs contre un troisième : elles
 * gardent le **trajet**, du corps HTTP jusqu'à l'instant remis au service.
 */

/*
 * Ce fichier ne relaie plus **aucune borne** depuis #510.
 *
 * `LONG_TEXT_MAX_LENGTH` et `CANCELLATION_REASON_MAX_LENGTH` — qui était
 * `REASON_MAX_LENGTH` sous un autre nom — ont perdu leurs derniers lecteurs avec
 * la substitution des corps de back-office : `create-appointment.dto.ts` et
 * `cancel-appointment.dto.ts` importent désormais du contrat directement. Un
 * relais que personne n'emprunte n'est pas un point de substitution, c'est un
 * nom de plus à tenir d'accord — et un nom local qui ne vaudrait plus la même
 * chose que celui du paquet ferait de la prochaine substitution un changement de
 * borne silencieux.
 */

/**
 * Un corps **absent** vaut un corps vide — la propriété que
 * `ValidationPipe.toEmptyIfNil` tenait avant la substitution (#510).
 *
 * Elle ne se voit que sur les corps dont **aucun** champ n'est obligatoire, et
 * l'annulation en est un : `POST /appointments/{id}/cancel` répondait 200 à une
 * requête sans corps, des deux côtés du comptoir.
 *
 * Ce qui a changé, et pourquoi il faut le rattraper ici : Express 5 et
 * body-parser 2 laissent `req.body` à `undefined` quand la requête ne porte
 * aucun en-tête `Content-Type`, et le `ValidationPipe` global ne le normalise
 * **plus** — il ne normalisait que les paramètres dont la métadonnée est une
 * classe à valider, et le paramètre du handler est désormais typé par un alias,
 * dont la métadonnée émise est `Object`. Sans cette conversion, l'annulation
 * sortirait en 400 « Required » sur un corps qu'elle n'exige pas.
 *
 * Enveloppe le schéma plutôt que de modifier le pipe : le correctif reste dans
 * le module qui en a besoin, et les schémas dont un champ **est** obligatoire ne
 * changent pas de comportement — leur refus reste un 400 qui nomme le champ.
 * `ZodValidationPipe` déballe les `ZodEffects` avant de vérifier `.strict()`, si
 * bien que la garde de champ inconnu reste posée sur le schéma enveloppé.
 *
 * Jumeau de celui de `catalog/dto/validation.ts`, dupliqué pour la raison qui
 * vaut déjà pour `Trim` et `OptionalPresent` : un module n'importe pas un
 * fichier profond d'un autre (api-module §3).
 */
export function optionalBody<TSchema extends ZodTypeAny>(
  schema: TSchema,
): z.ZodEffects<TSchema, z.output<TSchema>, unknown> {
  return z.preprocess((value) => value ?? {}, schema);
}

/*
 * La lecture d'une date-heure à offset explicite ne vit plus ici (#510).
 *
 * `isOffsetDateTime` et son décorateur `@IsOffsetDateTime()` gardaient la
 * frontière de la création au comptoir et des deux reports ; ces trois corps
 * sont passés à `offsetDateTimeSchema` du contrat, qui applique le **même
 * prédicat** — le décorateur l'importait déjà de `@spa/shared` — et normalise en
 * plus l'instant en UTC. Les garder ici aurait laissé une seconde porte d'entrée
 * à une règle qui n'en a plus qu'une.
 *
 * `availability/dto/validation.ts` et `payments/dto/validation.ts` portent
 * encore la leur : leurs DTO ne sont pas substitués, et leurs notes d’écart
 * disent pourquoi.
 */

/**
 * Date civile `AAAA-MM-JJ` — la forme de `calendarDateSchema` du contrat (#444).
 *
 * Jumeau de `CALENDAR_DATE_PATTERN` d'`availability/availability.time.ts`, et il
 * doit le rester : les bornes de l'agenda du back-office et celles d'une
 * interrogation de créneaux décrivent le même calendrier — celui du salon.
 */
export const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `true` si la chaîne est une date civile `AAAA-MM-JJ` qui **existe**.
 *
 * Le motif seul ne suffit pas, pour la même raison qu'en date-heure :
 * `2026-02-31` le satisfait. Une date inexistante traverserait la frontière et
 * ferait afficher au comptoir l'agenda du 3 mars sous l'étiquette du 31 février,
 * sans qu'aucune erreur ne le dise.
 */
export function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const matched = CALENDAR_DATE_PATTERN.exec(value);

  if (matched === null) {
    return false;
  }

  const [year, month, day] = [Number(matched[1]), Number(matched[2]), Number(matched[3])];

  const replayed = new Date(0);
  replayed.setUTCFullYear(year, month - 1, day);

  return (
    replayed.getUTCFullYear() === year &&
    replayed.getUTCMonth() === month - 1 &&
    replayed.getUTCDate() === day
  );
}

/**
 * Date civile de l'établissement — la borne d'une plage d'agenda (#444).
 *
 * Une date civile, et non un instant : « la semaine du 3 mars » n'a de sens que
 * dans le calendrier du salon, et c'est ce calendrier-là qu'un écran affiche.
 * C'est l'asymétrie qu'annonce `appointmentListQuerySchema` du contrat partagé —
 * la requête raisonne en dates, la réponse en instants UTC.
 */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: propertyName as string,
      ...(options === undefined ? {} : { options }),
      validator: {
        validate: (value: unknown) => isCalendarDate(value),
        defaultMessage: () =>
          `${String(propertyName)} : date civile attendue au format AAAA-MM-JJ (« 2026-03-03 »)`,
      },
    });
  };
}

/**
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` de class-validator confond les deux : il ignore les validateurs
 * aussi bien sur `undefined` que sur `null`, si bien qu'un `null` explicite
 * traverserait la validation et descendrait jusqu'à une colonne `NOT NULL`. Ce
 * décorateur-ci ne laisse passer que l'absence.
 */
export const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/*
 * `Trim` et `NormalizeEmail` vivaient ici jusqu'à #510, et n'y sont plus : leurs
 * derniers porteurs — les corps de back-office de ce module — sont passés aux
 * schémas du contrat, qui élaguent et canonisent eux-mêmes (`nameSchema`,
 * `emailSchema`, `reasonSchema`). Un décorateur que personne ne décore n'est pas
 * un point de substitution, c'est une seconde écriture de plus à tenir d'accord.
 *
 * `crm/client-directory.service.ts` cite encore `NormalizeEmail` comme la raison
 * pour laquelle il n'a pas à normaliser une seconde fois : cela reste vrai, la
 * normalisation ayant seulement changé d'écriture — elle est dans `emailSchema`.
 */
