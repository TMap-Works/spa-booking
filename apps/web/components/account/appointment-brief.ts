import type {
  BookedAppointment,
  Locale,
  PostalAddress,
  PublicService,
  PublicTenant,
  TimeZone,
  UtcInstant,
} from '@spa/shared';

import { addressLines } from '@/components/salon/salon-address';
import { formatTimeInTimeZone, type DisplayLocale } from '@/lib/format';
import en from '@/messages/en/account.json';
import fr from '@/messages/fr/account.json';

/**
 * Ce qu'une carte de rendez-vous de l'espace client a besoin de savoir, et la
 * logique qui l'en déduit — #1053.
 *
 * ## Pourquoi un module sans JSX
 *
 * `BM-RDV-02` demande qu'une carte dise « quoi, avec qui, quand, où, combien, et
 * son statut ». Le contrat public, lui, ne sert que des **identifiants** :
 * `bookedAppointmentSchema` porte `serviceId` et `staffId`, jamais les noms —
 * délibérément, puisque servir les résumés à un appelant public diffuserait
 * l'identité d'une cliente à partir d'un identifiant de rendez-vous. Résoudre
 * ces noms est donc un travail de présentation, et il se teste comme une
 * fonction plutôt qu'à l'œil sur un rendu (web-frontend §8).
 *
 * ## Ce qu'il ne fait pas
 *
 * Il n'appelle rien et ne connaît aucune session : le catalogue public lui est
 * passé par la page, qui l'a déjà chargé pour nommer les prestations.
 *
 * ## Les mots viennent du catalogue, pas de ce fichier (#847)
 *
 * Par **import direct des deux fichiers JSON**, et non par `useTranslations` :
 * ce module est fait de fonctions pures, appelées depuis des Server Components,
 * des Client Components et des tests sans DOM. Un crochet de React l'aurait
 * rendu inappelable dans les deux derniers. Même arbitrage, et même source, que
 * `lib/appointment-status.ts` et `lib/format.ts`.
 */

/** Les catalogues, dans les deux langues — la même source que les composants. */
const CATALOG = { fr, en } as const;

/**
 * La langue employée quand l'appelant n'en passe pas.
 *
 * `'fr'`, comme `lib/format.ts` et `lib/appointment-status.ts` : les suites
 * unitaires de cet espace sont écrites en français (`tests/support/next-intl.ts`),
 * et un défaut anglais les aurait fait basculer sans qu'aucun écran ne change.
 * Les écrans, eux, passent tous la langue résolue.
 */
const FALLBACK_LOCALE: Locale = 'fr';

/** Le remplacement des paramètres d'un message lu hors de React — voir `lib/format.ts`. */
function fill(message: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    message,
  );
}

/** Un rendez-vous augmenté des noms que la carte affiche. */
export interface AppointmentBrief {
  readonly appointment: BookedAppointment;
  /** La prestation, quand le catalogue public la porte encore. */
  readonly serviceName: string | null;
  /** Le praticien réservé — ce que Planity se voit reprocher de taire (BM-RDV-02). */
  readonly practitioner: string | null;
  /** Durée réelle du créneau, déduite des deux bornes et non du catalogue. */
  readonly durationMinutes: number;
}

/**
 * La phrase qui suit la pastille « À confirmer par le salon ».
 *
 * Écrite une fois : la carte héros et la carte compacte l'affichent l'une et
 * l'autre, et deux copies d'un même libellé de statut sont exactement ce que
 * `lib/appointment-status.ts` a dû recoller ailleurs (#917).
 */
export function pendingHoldNote(locale: Locale = FALLBACK_LOCALE): string {
  return CATALOG[locale].appointments.pendingHold;
}

/**
 * La même phrase, figée en français.
 *
 * @deprecated Transitoire (#847), même régime que les constantes de
 * `lib/appointment-status.ts`. Elle n'a plus qu'un lecteur, et il est **hors de
 * l'empreinte de ce ticket** : l'écran terminal du tunnel de réservation
 * (`(booking)/…/steps/confirmation-step.tsx`), que #846 traduit dans le
 * namespace `booking`. Ce ticket-là lui passera la langue résolue, et cette
 * constante disparaîtra avec son dernier appelant. La garder évite de faire
 * basculer en anglais un écran dont la traduction n'a pas encore été relue — et
 * surtout d'aller réécrire un fichier qui appartient à un autre ticket de la
 * même vague.
 */
export const PENDING_HOLD_NOTE: string = CATALOG[FALLBACK_LOCALE].appointments.pendingHold;

/**
 * La phrase qui suit la pastille « Déplacé ».
 *
 * Même raison d'être que la précédente, et même exigence d'unicité : « Déplacé »
 * est le seul mot de la table de statuts qui ne corresponde à aucun statut
 * (`lib/appointment-status.ts`), et il ne dit pas de lui-même où est passé le
 * rendez-vous. La carte compacte l'affichait déjà ; la liste d'historique la
 * reprend depuis #1054, d'où la remontée du littéral ici plutôt qu'une seconde
 * copie — c'est précisément ainsi que les libellés de statut avaient divergé sur
 * trois écrans (#917).
 */
export function rescheduledNote(locale: Locale = FALLBACK_LOCALE): string {
  return CATALOG[locale].appointments.rescheduledNote;
}

/**
 * Le nom qu'une carte affiche quand le catalogue public ne porte plus la
 * prestation — retirée ou désactivée depuis la réservation.
 *
 * Il vit ici et non dans chaque écran : trois surfaces l'écrivaient
 * (carte héros, carte compacte, ligne d'historique), et un mot répété trois fois
 * est un mot qui finit par différer.
 */
export function serviceFallback(locale: Locale = FALLBACK_LOCALE): string {
  return CATALOG[locale].appointments.serviceFallback;
}

/**
 * Le rendez-vous et les noms qui vont avec.
 *
 * La durée vient des bornes du **rendez-vous** et non de `durationMinutes` du
 * catalogue : le prix est figé à la réservation (`bookedAppointmentSchema`), et
 * la durée doit l'être de la même façon — une prestation raccourcie depuis ne
 * doit pas raccourcir rétroactivement un créneau déjà retenu.
 *
 * Le praticien est cherché dans le `staff` de **sa** prestation : c'est la seule
 * liste de praticiens que le contrat public expose, et elle suffit — un
 * rendez-vous est toujours pris sur une prestation donnée. Un praticien
 * désactivé depuis n'y figure plus, et la carte se tait alors plutôt que
 * d'inventer un nom.
 */
export function appointmentBrief(
  appointment: BookedAppointment,
  services: readonly PublicService[],
): AppointmentBrief {
  const service = services.find((candidate) => candidate.id === appointment.serviceId) ?? null;
  const staff = service?.staff.find((member) => member.id === appointment.staffId) ?? null;

  return {
    appointment,
    serviceName: service?.name ?? null,
    practitioner: staff?.displayName ?? null,
    durationMinutes: Math.round(
      (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000,
    ),
  };
}

/**
 * « 14:10 – 15:10 », dans le fuseau de l'établissement.
 *
 * Le tiret demi-cadratin est encadré d'espaces **insécables**, comme
 * `formatOpeningRange` de la vitrine : sans eux, un retour à la ligne peut
 * tomber entre l'heure et le tiret, et la plage se lit alors comme deux heures
 * sans rapport.
 *
 * L'heure de fin est écrite, là où la ligne d'historique ne donnait que le
 * début : une cliente qui prévoit sa journée a besoin de savoir quand elle
 * ressort, et c'est ce que l'audit `d20260918-1` relève comme absent de la carte
 * du prochain rendez-vous.
 */
export function appointmentTimeRange(
  appointment: Pick<BookedAppointment, 'startsAt' | 'endsAt'>,
  timeZone: TimeZone,
  /**
   * La langue et le pays qui décident de la mise en forme de l'heure (#847).
   *
   * Le **fuseau** reste celui de l'établissement, toujours — la langue n'y
   * touche pas. Ce qui change est l'écriture : « 14:10 » en `fr-FR`,
   * « 2:10 PM » en `en-US`. Facultatif pour les suites, qui n'ont qu'une langue.
   */
  display?: DisplayLocale,
): string {
  const start = formatTimeInTimeZone(appointment.startsAt, timeZone, display);
  const end = formatTimeInTimeZone(appointment.endsAt, timeZone, display);

  return `${start}\u00a0–\u00a0${end}`;
}

/**
 * L'adresse sur une ligne, pour une URI de carte ou un champ `LOCATION`
 * d'agenda.
 *
 * `addressLines` de la vitrine et non un découpage à part : c'est déjà le point
 * d'écriture unique de « comment une adresse se lit », pays compris — deux
 * écritures auraient fini par diverger sur le cas intéressant, un salon hors de
 * France.
 *
 * Le pays est gardé, et ce n'est pas décoratif : cette chaîne est la
 * `destination` d'un itinéraire. « 12 rue des Lilas, Paris » sans pays se
 * géocode dans le pays du téléphone qui l'ouvre, et une cliente à Antananarivo
 * partirait vers une rue française homonyme.
 */
export function addressOneLine(name: string, address: PostalAddress): string {
  return [name, ...addressLines(address)]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(', ');
}

/**
 * L'itinéraire vers le salon (BM-RDV-04).
 *
 * `dir/?api=1&destination=` et non une recherche : le lien annonce
 * « Itinéraire », et une recherche ouvrirait une fiche dont il faudrait encore
 * demander la route. Le paramètre est l'adresse **en toutes lettres** — le
 * modèle de données ne porte aucune coordonnée, et en inventer une enverrait la
 * cliente au mauvais endroit.
 *
 * Rendu `null` quand le salon n'a pas publié d'adresse : une action qu'on ne
 * peut pas exercer n'est pas une action (même règle que `salonContactAction`).
 */
export function directionsUrl(tenant: PublicTenant): string | null {
  if (tenant.address === undefined) {
    return null;
  }

  const destination = encodeURIComponent(addressOneLine(tenant.name, tenant.address));

  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

/** L'instant au format `DATE-TIME` UTC de la RFC 5545 — « 20260918T121000Z ». */
function icsInstant(instant: UtcInstant): string {
  return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Le texte d'une propriété iCalendar, échappé selon la RFC 5545 §3.3.11 :
 * la barre oblique inverse, le point-virgule, la virgule et les retours à la
 * ligne. Un nom de prestation contenant une virgule couperait sinon la valeur en
 * deux.
 */
function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Le pliage de ligne de la RFC 5545 §3.1 — 75 octets, la suite précédée d'une
 * espace.
 *
 * Le découpage se fait sur les **octets** UTF-8 et non sur les caractères :
 * couper au milieu d'un « é » produirait un fichier qu'aucun agenda ne lit.
 */
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(line);

  if (bytes.length <= 75) {
    return line;
  }

  const pieces: string[] = [];
  let offset = 0;
  let limit = 75;

  /** `true` si l'octet est une continuation UTF-8 (`10xxxxxx`) — donc une coupe interdite. */
  const continues = (index: number): boolean => ((bytes[index] ?? 0) & 0xc0) === 0x80;

  while (offset < bytes.length) {
    let size = Math.min(limit, bytes.length - offset);
    // Reculer tant que la coupe tombe au milieu d'un caractère.
    while (size > 1 && offset + size < bytes.length && continues(offset + size)) {
      size -= 1;
    }
    pieces.push(decoder.decode(bytes.subarray(offset, offset + size)));
    offset += size;
    limit = 74;
  }

  return pieces.join('\r\n ');
}

interface IcsInput {
  readonly brief: AppointmentBrief;
  readonly tenant: PublicTenant;
  /**
   * La langue du fichier d'agenda — celle de l'écran qui propose le
   * téléchargement (#847).
   *
   * Le résumé et la description sont lus par la cliente dans son propre agenda,
   * des mois après : ce sont des textes d'interface comme les autres. Le reste du
   * fichier — `PRODID`, `DTSTART`, la structure — est le protocole de la RFC 5545
   * et ne se traduit pas.
   */
  readonly locale?: Locale;
}

/**
 * Le rendez-vous en fichier iCalendar, prêt à être téléchargé (BM-RDV-03).
 *
 * Un fichier et non un lien vers un agenda du marché : le motif dit « le
 * rendez-vous rejoint l'agenda du téléphone », et `.ics` est le seul format que
 * tous les agendas — celui d'iOS, celui d'Android, Outlook — ouvrent sans compte
 * tiers ni redirection.
 *
 * `DTSTART` et `DTEND` sont en **UTC**, ce que la lettre `Z` déclare : c'est la
 * règle du dépôt (tout est stocké en UTC, converti à l'affichage), et c'est
 * aussi la seule écriture qui n'oblige pas à embarquer la définition du fuseau
 * du salon dans le fichier. L'agenda de la cliente le reprojettera dans le sien.
 */
export function appointmentIcs({ brief, tenant, locale = FALLBACK_LOCALE }: IcsInput): string {
  const { appointment, serviceName, practitioner } = brief;
  const words = CATALOG[locale].ics;
  const summary = fill(words.summary, {
    service: serviceName ?? words.serviceFallback,
    salon: tenant.name,
  });
  const description =
    practitioner === null ? null : fill(words.description, { practitioner });
  const location = tenant.address === undefined ? null : addressOneLine(tenant.name, tenant.address);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Spa Booking//Espace client//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@spa-booking`,
    // `DTSTAMP` est l'heure de début et non l'instant courant, à dessein : la
    // propriété est obligatoire, aucun agenda ne l'affiche, et la lire à
    // l'horloge rendrait le fichier différent à chaque rendu — donc intestable,
    // et différent entre le serveur et le client sur une même page.
    `DTSTAMP:${icsInstant(appointment.startsAt)}`,
    `DTSTART:${icsInstant(appointment.startsAt)}`,
    `DTEND:${icsInstant(appointment.endsAt)}`,
    `SUMMARY:${icsText(summary)}`,
    ...(description === null ? [] : [`DESCRIPTION:${icsText(description)}`]),
    ...(location === null ? [] : [`LOCATION:${icsText(location)}`]),
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  // Les fins de ligne sont CRLF — la RFC 5545 §3.1 ne laisse pas le choix, et
  // plusieurs agendas refusent un fichier en LF seul.
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** Le nom du fichier téléchargé — la référence citable, jamais un UUID. */
export function appointmentIcsFilename(
  appointment: Pick<BookedAppointment, 'reference'>,
  locale: Locale = FALLBACK_LOCALE,
): string {
  return fill(CATALOG[locale].ics.filename, { reference: appointment.reference });
}

/**
 * Le même fichier, en `href` posable tel quel sur un `<a download>`.
 *
 * Une URL de données et non un `URL.createObjectURL` : l'URL d'objet n'existe
 * que dans le navigateur, si bien que le lien n'aurait pu apparaître qu'après
 * l'hydratation — un bouton qui se matérialise une seconde après le reste. Ici
 * le lien sort du rendu serveur, complet, et fonctionne même si le script ne
 * charge jamais.
 *
 * Un événement de rendez-vous pèse quelques centaines d'octets : on est très
 * loin des limites de longueur d'URL des navigateurs.
 */
export function appointmentIcsHref(input: IcsInput): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(appointmentIcs(input))}`;
}
