import {
  LONG_TEXT_MAX_LENGTH,
  REASON_MAX_LENGTH,
  isOffsetDateTime as isSharedOffsetDateTime,
} from '@spa/shared';
import { Transform } from 'class-transformer';
import { registerDecorator, ValidateIf, type ValidationOptions } from 'class-validator';

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
 * Ce qui reste écrit ici est ce que le contrat **ne porte pas** : les
 * décorateurs `class-validator` eux-mêmes. Ils n'ont plus vocation à durer non
 * plus — l'[ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)
 * décide que le schéma Zod valide et que la classe documente, et
 * `book-appointment.dto.ts` est la première route substituée. Les DTO de
 * back-office de ce module suivront avec le reste de la reprise.
 *
 * ## Pourquoi ce fichier existe alors que ses voisins en ont un identique
 *
 * `catalog/dto/validation.ts` et `availability/dto/validation.ts` portent aussi
 * `OptionalPresent`, `Trim` et la lecture d'une date-heure à offset explicite.
 * Ils sont **dupliqués** plutôt qu'importés, et ce n'est pas un oubli : un module
 * n'importe pas un fichier profond d'un autre (api-module §3). Leur place
 * définitive est du côté des schémas du contrat, à mesure que les DTO qui les
 * emploient sont substitués.
 *
 * `appointments/__tests__/date-time.validation.spec.ts` et
 * `packages/shared/src/__tests__/schemas.spec.ts` exercent les mêmes chaînes de
 * part et d'autre. Elles ne gardent plus deux motifs contre un troisième : elles
 * gardent le **trajet**, du corps HTTP jusqu'à l'instant remis au service.
 */

/**
 * `appointments.client_note` — `VARCHAR(2000)`, la borne du contrat partagé.
 *
 * Seule longueur encore relayée par ce fichier : les autres (`EMAIL_MAX_LENGTH`,
 * `NAME_MAX_LENGTH`, `PHONE_MAX_LENGTH`) ne servaient qu'à `book-appointment.dto.ts`,
 * qui les prend désormais directement de `@spa/shared`. Un relais que personne
 * n'emprunte n'est pas un point de substitution, c'est un nom de plus à tenir
 * d'accord — les DTO qui suivront importeront du contrat, comme celui-là.
 */
export { LONG_TEXT_MAX_LENGTH };

/**
 * `appointments.cancellation_reason` — `VARCHAR(500)` (#40).
 *
 * C'est `REASON_MAX_LENGTH` du contrat, sous le nom que ce module lui donne :
 * plus court que `LONG_TEXT_MAX_LENGTH` parce que la colonne l'est — un motif
 * d'annulation est une phrase, pas un dossier. Une borne plus large que la
 * colonne ferait sortir un 500 du pilote PostgreSQL là où le contrat annonce un
 * 400 qui nomme le champ.
 */
export const CANCELLATION_REASON_MAX_LENGTH = REASON_MAX_LENGTH;

/**
 * `true` si la valeur est une date-heure ISO 8601 à offset explicite **et**
 * désigne un instant réel.
 *
 * L'implémentation est celle du contrat ; ce qui est ajouté ici est la garde de
 * type, `class-validator` remettant à ses validateurs une valeur `unknown`.
 * Le motif seul ne suffirait pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler — un rendez-vous
 * déplacé de deux jours par une faute de frappe.
 */
export function isOffsetDateTime(value: unknown): boolean {
  return typeof value === 'string' && isSharedOffsetDateTime(value);
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
 *
 * **Sans application depuis #404**, et c'est un état de transition et non un
 * oubli : son unique porteur était `GuestContactDto`, dont la validation est
 * passée à `emailSchema` du contrat — qui canonise de la même façon, dans le
 * schéma plutôt que dans un décorateur. Il est conservé tant que les DTO de
 * back-office de ce module ne sont pas substitués à leur tour (#510), et
 * `crm/client-directory.service.ts` le cite encore comme la raison pour laquelle
 * il n'a pas à normaliser une seconde fois — ce qui reste vrai, la
 * normalisation ayant seulement changé d'écriture.
 */
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
