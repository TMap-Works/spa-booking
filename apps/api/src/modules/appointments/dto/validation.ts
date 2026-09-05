import { Transform } from 'class-transformer';
import { registerDecorator, ValidateIf, type ValidationOptions } from 'class-validator';

/**
 * Briques de validation du module `appointments` (#37).
 *
 * ## Pourquoi ce fichier existe alors que ses voisins en ont un identique
 *
 * `catalog/dto/validation.ts` et `availability/dto/validation.ts` portent déjà
 * `OptionalPresent`, `Trim` et la lecture d'une date-heure à offset explicite.
 * Ils sont **dupliqués** plutôt qu'importés, et ce n'est pas un oubli : un module
 * n'importe pas un fichier profond d'un autre (api-module §3), et la place
 * définitive de ces primitives est `@spa/shared` — c'est l'objet de #26, qui
 * ajoutera la dépendance à `apps/api/package.json`. Les noms sont donc **ceux du
 * paquet partagé**, pour que la substitution ne change pas une borne en silence.
 *
 * #297 a fait la moitié contrat du même geste : `createAppointmentRequestSchema`
 * et `rescheduleAppointmentRequestSchema` portent désormais
 * `offsetDateTimeSchema` sur leur `startsAt`, si bien que le contrat et ce
 * fichier décrivent exactement la même frontière — en deux endroits, en
 * attendant #26. `appointments/__tests__/date-time.validation.spec.ts` et
 * `packages/shared/src/__tests__/schemas.spec.ts` exercent les mêmes chaînes de
 * part et d'autre : c'est ce qui rendra visible le jour où l'une des deux
 * bougerait seule.
 */

/**
 * Longueurs, alignées sur le schéma Prisma **et** sur `@spa/shared`.
 *
 * TODO(#26) : ce sont `EMAIL_MAX_LENGTH`, `NAME_MAX_LENGTH`, `PHONE_MAX_LENGTH`
 * et `LONG_TEXT_MAX_LENGTH` de `packages/shared/src/constants/limits.ts`. Une
 * borne plus large que la colonne ferait sortir un 500 du pilote PostgreSQL là
 * où le contrat annonce un 400 qui nomme le champ.
 */
export const EMAIL_MAX_LENGTH = 320;
/** `users.first_name` / `users.last_name` — `VARCHAR(80)`. */
export const NAME_MAX_LENGTH = 80;
/** `users.phone` — `VARCHAR(32)`. */
export const PHONE_MAX_LENGTH = 32;
/** `appointments.client_note` — `VARCHAR(2000)`. */
export const LONG_TEXT_MAX_LENGTH = 2000;

/**
 * `appointments.cancellation_reason` — `VARCHAR(500)` (#40).
 *
 * Plus court que `LONG_TEXT_MAX_LENGTH` parce que la colonne l'est : un motif
 * d'annulation est une phrase, pas un dossier. Une borne plus large que la
 * colonne ferait sortir un 500 du pilote PostgreSQL là où le contrat annonce un
 * 400 qui nomme le champ.
 */
export const CANCELLATION_REASON_MAX_LENGTH = 500;

/**
 * Numéro de téléphone — format libre borné, celui de `phoneSchema`.
 *
 * Volontairement permissif : la validation stricte dépend du plan de numérotation
 * du pays. Refuser un numéro pourtant valide **empêche une réservation** ; en
 * accepter un douteux ne coûte qu'un SMS non délivré, que la chaîne de
 * notifications sait déjà journaliser.
 */
export const PHONE_PATTERN = /^[+0-9][0-9\s().-]*$/;

/**
 * ISO 8601 avec offset explicite — `Z` ou `±HH:MM`, secondes et fraction
 * facultatives.
 *
 * Jumeau de `OFFSET_DATE_TIME_PATTERN` d'`availability/dto/validation.ts`, et il
 * doit le rester : les créneaux proposés par le moteur de disponibilité sont
 * exactement les instants que ce module accepte en réservation. L'heure est
 * bornée à `00`-`23` — le profil RFC 3339 ne connaît pas `24:00`, et un `\d{2}`
 * complaisant laisserait `2026-03-29T24:00:00Z` franchir la frontière pour être
 * normalisé, sans un mot, au 30 mars.
 */
export const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * `true` si la chaîne est une date-heure ISO 8601 à offset explicite **et**
 * désigne un instant réel.
 *
 * Le motif seul ne suffit pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler — un rendez-vous
 * déplacé de deux jours par une faute de frappe. La date civile est donc rejouée
 * composant par composant.
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
 * Refuse toute date-heure sans offset explicite, en 400 nommant le champ.
 *
 * Une date-heure nue (`2026-03-29T03:30:00`) n'a de sens que rapportée à un
 * fuseau, et le serveur ne peut que **deviner** lequel : celui du salon ? celui
 * du navigateur ? celui de la machine, qui n'est le fuseau de personne ?
 * `new Date('2026-03-29T03:30:00')` choisit la troisième, en silence. La refuser
 * à la frontière est la seule façon de n'avoir jamais à choisir — et un
 * rendez-vous mal fuseau-horairé est un bug de sévérité haute (CLAUDE.md).
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
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` de class-validator confond les deux : il ignore les validateurs
 * aussi bien sur `undefined` que sur `null`, si bien qu'un `null` explicite
 * traverserait la validation et descendrait jusqu'à une colonne `NOT NULL`. Ce
 * décorateur-ci ne laisse passer que l'absence.
 */
export const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * Élague une chaîne avant que les bornes ne la jugent.
 *
 * Sans lui, `"   "` passerait pour un prénom — trois espaces font trois
 * caractères. Rend la valeur telle quelle si ce n'est pas une chaîne : un type
 * inattendu doit être refusé par son validateur, pas transformé ici.
 */
export const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Canonise une adresse e-mail : élaguée, en minuscules.
 *
 * C'est ce qui rend l'unicité `(tenant_id, email)` fiable. La contrainte de base
 * porte sur les **octets** : sans normalisation en amont,
 * `Alice@Example.test` et `alice@example.test` cohabiteraient dans le même salon,
 * et la réservation d'invité créerait une seconde fiche cliente au lieu de
 * retrouver la première.
 */
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
