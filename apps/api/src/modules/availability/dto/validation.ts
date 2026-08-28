import { Transform } from 'class-transformer';
import {
  Matches,
  registerDecorator,
  ValidateIf,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { localTimeToMinutes } from '../availability.schedule';
import { CALENDAR_DATE_PATTERN, LOCAL_TIME_PATTERN } from '../availability.time';

/**
 * Briques de validation des dates qui traversent l'API (#41).
 *
 * ## La règle
 *
 * **Toute date-heure entrante porte un offset explicite** — `Z` ou `±HH:MM`. Une
 * date-heure nue (`2026-03-29T03:30:00`) est refusée en 400.
 *
 * Ce n'est pas du purisme de format. Une date-heure nue n'a de sens que rapportée
 * à un fuseau, et le serveur ne peut que **deviner** lequel : celui du tenant ?
 * celui du navigateur ? celui de la machine, qui n'est le fuseau de personne ?
 * Trois réponses défendables, donc aucune — et `new Date('2026-03-29T03:30:00')`
 * choisit la troisième, en silence. La refuser à la frontière est la seule façon
 * de n'avoir jamais à choisir.
 *
 * ## L'asymétrie entrée / sortie, et pourquoi elle est voulue
 *
 * | Sens | Format | Raison |
 * |---|---|---|
 * | Entrée | ISO 8601 avec offset (`Z` **ou** `±HH:MM`), normalisé en UTC | ne pas faire porter la conversion au client |
 * | Sortie | instant UTC suffixé `Z` | un seul référentiel : deux horodatages se comparent par simple ordre lexicographique |
 *
 * `Z` **est** un offset explicite : la sortie satisfait la règle autant que
 * l'entrée. Ce qui est proscrit des deux côtés, c'est l'instant nu.
 *
 * L'heure locale de l'établissement, elle, ne voyage jamais dans un corps de
 * réponse : elle se recalcule à l'affichage à partir de l'instant UTC et de
 * `tenants.timezone` — c'est le rôle de `TenantClockService`.
 *
 * TODO(#26) : `OFFSET_DATE_TIME_PATTERN` est le motif de `@spa/shared`
 * (`packages/shared/src/common/time.ts`) et devra en être importé le jour où
 * `apps/api` dépendra du paquet — même TODO que dans `catalog/dto/validation.ts`.
 * Le nom est donc **celui du paquet partagé**, pour que la substitution ne change
 * pas une borne en silence. `LOCAL_TIME_PATTERN`, lui, vient déjà d'une source
 * unique : le moteur de conversion du module, qui est ce qui lira l'heure.
 */

/**
 * ISO 8601 avec offset explicite, secondes et fraction facultatives.
 *
 * La latitude sur les secondes et la fraction est celle du profil RFC 3339 :
 * `2026-03-29T01:30Z`, `…:30Z` et `…:30.123456789Z` sont trois horodatages
 * parfaitement formés, produits par des piles différentes. Les refuser
 * n'apporterait aucune sûreté et casserait des clients légitimes.
 *
 * L'heure est en revanche **bornée** à `00`-`23`, comme celle de
 * `LOCAL_TIME_PATTERN` : le profil RFC 3339 ne connaît pas `24:00`, et un
 * `\d{2}` complaisant laisserait `2026-03-29T24:00:00Z` franchir la frontière
 * pour être normalisé, sans un mot, au 30 mars — un rendez-vous déplacé d'un
 * jour par une saisie que rien n'a refusée.
 */
export const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Heure murale `HH:MM`, 00:00 à 23:59 — un horaire de personnel (#32).
 *
 * Réexportée depuis le moteur de conversion plutôt que redéclarée : le DTO et
 * `zonedDateTimeToUtc` doivent accepter exactement la même forme. Les
 * redéclarer laisserait le DTO admettre en 400 ce que le moteur refuserait
 * ensuite en `RangeError` — donc en 500. Même précédent que
 * `catalog/dto/validation.ts`, qui tient `SLUG_PATTERN` de `catalog.slug`.
 */
export { LOCAL_TIME_PATTERN };

/**
 * `true` si la chaîne est une date-heure ISO 8601 à offset explicite **et**
 * désigne un instant réel.
 *
 * Le motif seul ne suffit pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler — un rendez-vous
 * déplacé de deux jours par une faute de frappe. La date civile est donc
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
 * Écrit en décorateur dédié plutôt qu'en `@Matches(OFFSET_DATE_TIME_PATTERN)` :
 * le motif laisse passer le 31 février, et le message d'un `@Matches` générique
 * (« doit correspondre à l'expression régulière ») n'apprend rien à qui a
 * simplement oublié le `Z`.
 */
export function IsOffsetDateTime(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isOffsetDateTime',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: options ?? {},
      validator: {
        validate: (value: unknown): boolean => isOffsetDateTime(value),
        defaultMessage: (args?: ValidationArguments): string =>
          `${args?.property ?? 'date'} : ISO 8601 avec offset explicite attendu ` +
          '(« 2026-03-29T01:30:00Z » ou « 2026-03-29T03:30:00+02:00 »)',
      },
    });
  };
}

/**
 * Normalise en instant UTC (`…Z`) une date-heure à offset explicite.
 *
 * La conversion se fait **à la frontière**, avant que la valeur n'atteigne le
 * service : passé ce point, plus aucune couche n'a à se demander dans quel
 * référentiel elle lit un horodatage. C'est ce qui rend `startsAt < endsAt` une
 * comparaison sûre partout ailleurs.
 *
 * Rend la valeur **telle quelle** si elle n'est pas une date-heure valable :
 * c'est `@IsOffsetDateTime()` qui la refuse ensuite, en 400 nommant le champ.
 * Transformer avant d'avoir validé produirait un `Invalid Date` que le
 * validateur ne saurait plus décrire.
 */
export function ToUtcInstant(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    isOffsetDateTime(value) ? new Date(value as string).toISOString() : value,
  );
}

/**
 * `true` si la chaîne est une date civile `AAAA-MM-JJ` qui **existe** (#35).
 *
 * Le motif seul ne suffit pas, pour la même raison qu'en date-heure :
 * `2026-02-31` le satisfait. Une date inexistante traverserait la frontière et
 * irait produire, journée après journée, une plage décalée d'un ou deux jours —
 * un calendrier qui affiche les créneaux du mauvais jour, sans qu'aucune erreur
 * ne le dise.
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
 * Date civile de l'établissement — la borne d'une interrogation de créneaux.
 *
 * Une date civile, et non un instant : « la semaine du 3 mars » n'a de sens que
 * dans le calendrier du salon, et c'est ce calendrier-là qu'un écran affiche.
 * C'est l'asymétrie qu'annonce déjà `availabilityQuerySchema` du contrat
 * partagé — la requête raisonne en dates, la réponse en instants UTC.
 */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isCalendarDate',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: options ?? {},
      validator: {
        validate: (value: unknown): boolean => isCalendarDate(value),
        defaultMessage: (args?: ValidationArguments): string =>
          `${args?.property ?? 'date'} : date civile attendue au format AAAA-MM-JJ ` +
          '(« 2026-03-03 »)',
      },
    });
  };
}

/** Heure murale `HH:MM` — le format de saisie d'un horaire de personnel. */
export function IsLocalTime(options?: ValidationOptions): PropertyDecorator {
  return Matches(LOCAL_TIME_PATTERN, {
    message: '$property : heure locale attendue au format HH:MM (00:00 à 23:59)',
    ...options,
  });
}

/**
 * Borne **haute** d'une plage de travail : `HH:MM`, ou `24:00` pour minuit (#32).
 *
 * `LOCAL_TIME_PATTERN` s'arrête à `23:59`, et c'est juste pour une heure murale :
 * `24:00` n'existe pas sur une horloge. Mais la borne haute d'une plage est
 * **exclue** — elle ne désigne pas une heure vécue, elle désigne la fin de
 * l'intervalle. Un salon qui ferme à minuit n'aurait sinon aucune façon exacte
 * de le dire : `23:59` perdrait une minute et, à un pas de créneau de quinze
 * minutes, le dernier créneau de la soirée avec elle.
 *
 * Le littéral n'est admis que pour la fin. Un début à `24:00` désignerait une
 * plage vide, que le contrôle « fin > début » refuse de toute façon.
 *
 * Le motif est composé à partir de `LOCAL_TIME_PATTERN` plutôt que réécrit : deux
 * copies de la même borne horaire dériveraient l'une de l'autre, et le DTO
 * finirait par accepter en 400 ce que le moteur refuse en `RangeError`, donc en
 * 500.
 */
export const SCHEDULE_END_TIME_PATTERN = new RegExp(
  `^(?:${LOCAL_TIME_PATTERN.source.replace(/^\^|\$$/g, '')}|24:00)$`,
);

export function IsScheduleEndTime(options?: ValidationOptions): PropertyDecorator {
  return Matches(SCHEDULE_END_TIME_PATTERN, {
    message: '$property : heure locale attendue au format HH:MM, ou « 24:00 » pour minuit',
    ...options,
  });
}

/**
 * Minutes depuis minuit local, ou `null` — la lecture **totale** d'une heure
 * murale.
 *
 * `localTimeToMinutes` lève un `RangeError` sur une chaîne mal formée, et c'est
 * juste : y arriver serait un défaut de programmation. Un validateur, lui, est
 * précisément appelé sur ce qui n'a pas encore été validé — un `@IsLocalTime`
 * frère a pu déjà échouer sur la même charge utile. Lever ici ferait sortir une
 * exception brute du pipe de validation : le 400 attendu deviendrait un 500,
 * exactement ce que ce contrôle est là pour empêcher.
 *
 * Même arbitrage, et même raison, que `wallMinutesOrNull` dans
 * `packages/shared/src/schemas/availability.ts`.
 */
function wallMinutesOrNull(value: unknown): number | null {
  if (typeof value !== 'string' || !SCHEDULE_END_TIME_PATTERN.test(value)) {
    return null;
  }

  return localTimeToMinutes(value);
}

/**
 * La borne haute d'une plage est strictement postérieure à sa borne basse (#32).
 *
 * Sans ce contrôle, `09:00 → 08:00` traverse le DTO — chaque borne est bien
 * écrite —, ne déclenche aucun recouvrement — il n'y a qu'une plage —, et va
 * heurter `staff_schedules_minutes_check` en base. La violation de contrainte
 * remonte en `INTERNAL_ERROR` : **500 sur une saisie fautive**, là où le contrat
 * annonce 400. La base reste la garantie ; ce contrôle est le message.
 *
 * Il vit dans le DTO et non dans le service, à la différence du recouvrement :
 * une plage inversée est une faute de **forme** — elle se voit sur la plage
 * seule, sans rien connaître des autres — et c'est la règle que porte déjà
 * `staffScheduleEntrySchema` du contrat partagé, en 400 sur le champ `endsAt`.
 *
 * Une borne illisible ne fait **pas** échouer ce validateur : le décorateur de
 * format du champ concerné la refuse déjà, et refuser deux fois la même chose
 * ferait rendre à l'utilisateur deux messages pour une seule faute.
 */
export function IsAfterLocalTime(
  startProperty: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isAfterLocalTime',
      target: target.constructor,
      propertyName: propertyName.toString(),
      constraints: [startProperty],
      options: options ?? {},
      validator: {
        validate: (value: unknown, args?: ValidationArguments): boolean => {
          const [start] = (args?.constraints ?? []) as [string];
          const container = (args?.object ?? {}) as Record<string, unknown>;

          const startMinutes = wallMinutesOrNull(container[start]);
          const endMinutes = wallMinutesOrNull(value);

          if (startMinutes === null || endMinutes === null) {
            return true;
          }

          return endMinutes > startMinutes;
        },
        defaultMessage: (args?: ValidationArguments): string =>
          `${args?.property ?? 'endsAt'} : la fin d’une plage doit être ` +
          `strictement postérieure à son début (${String(args?.constraints?.[0] ?? 'startsAt')})`,
      },
    });
  };
}

/**
 * `VARCHAR(500)` — motif d'une plage bloquée ou d'un congé (#33).
 *
 * La même largeur que les autres motifs du schéma (`cancellation_reason`,
 * `failure_reason`) : c'est une phrase, pas une note de dossier.
 *
 * TODO(#26) : c'est `REASON_MAX_LENGTH` de `@spa/shared`
 * (`packages/shared/src/constants/limits.ts`), à importer le jour où `apps/api`
 * dépendra du paquet — même TODO que dans `catalog/dto/validation.ts`, et même
 * précaution de nommage : un homonyme local qui ne vaudrait pas la même chose
 * ferait de la substitution un changement de borne silencieux.
 */
export const REASON_MAX_LENGTH = 500;

/**
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` de class-validator confond les deux : il ignore les
 * validateurs aussi bien sur `undefined` que sur `null`, si bien qu'un `null`
 * explicite traverserait la validation et descendrait jusqu'à une colonne
 * `NOT NULL`. Ce décorateur-ci ne laisse passer que l'absence — un `null`
 * déclenche les validateurs, donc un 400 qui nomme le champ.
 *
 * Les champs réellement effaçables gardent `@IsOptional()` : c'est là que `null`
 * a un sens, et il vaut « efface ce texte ». Jumeau de celui de
 * `catalog/dto/validation.ts`, dupliqué plutôt qu'importé d'un module voisin —
 * un module n'importe pas un fichier profond d'un autre (api-module §3), et sa
 * place définitive est `@spa/shared` (#26).
 */
export const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * Élague un libellé avant que les bornes ne le jugent.
 *
 * Sans lui, `"   "` passerait pour un motif — trois espaces font trois
 * caractères — et le planning afficherait une absence motivée par du vide.
 * Rend la valeur telle quelle si ce n'est pas une chaîne : un `null`
 * d'effacement doit continuer à valoir « efface », et un type inattendu doit
 * être refusé par son validateur, pas transformé ici.
 */
export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
