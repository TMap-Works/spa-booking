import type { OpeningHoursEntry } from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '@/lib/format';

/**
 * Présentation des horaires d'ouverture de la vitrine (#343).
 *
 * Logique pure, sans JSX : ce module décide de l'ordre, du regroupement et des
 * libellés, et il se teste comme une fonction — là où la même logique enfouie
 * dans le composant ne se vérifierait qu'à l'œil, sur un rendu.
 *
 * Il ne trie pas : l'API rend déjà les plages par jour ISO croissant puis par
 * heure d'ouverture, et deux tris successifs finissent par diverger sur les cas
 * d'égalité. Il regroupe, ce qui est autre chose — une journée à coupure
 * méridienne porte deux plages et doit s'afficher sur une seule ligne.
 *
 * ## La langue (#846)
 *
 * Deux natures de mots se croisent ici, et elles ne viennent pas du même
 * endroit :
 *
 * - **les noms de jours** viennent d'`Intl`, jamais d'une table écrite à la
 *   main. Une table de sept noms par langue serait une seconde source de vérité
 *   sur un calendrier que la plateforme connaît déjà, et elle se périmerait à la
 *   première langue ajoutée. L'étiquette BCP 47 passée à `Intl`, elle, vient de
 *   `formattingLocale` (`lib/format.ts`) : c'est le seul endroit du front qui
 *   décide de la région à partir du pays de l'établissement, et le nom d'un jour
 *   n'a pas à en décider autrement que les dates qu'il coiffe ;
 * - **les phrases** — « Fermé », « Ouvert — ferme à 19:00 » — viennent du
 *   catalogue, comme tout ce qu'un humain lit.
 *
 * Ce module est **pur et sans React** : il ne peut appeler aucun crochet.
 *
 * ## Il n'importe plus aucun catalogue (#1142)
 *
 * Il a lu les deux catalogues par import direct le temps de #846, et cela
 * coûtait cher : ce module est atteignable depuis des Client Components — la
 * grille horaire des réglages, la carte du salon de l'espace client —, webpack
 * suivait donc l'import et agrégeait `booking.json` **entier, dans les deux
 * langues**, dans leurs bundles, pour six chaînes réellement lues. Quelque 11 kB
 * de First Load JS par écran, en pure duplication : ces mêmes chaînes atteignent
 * déjà le navigateur par `NextIntlClientProvider`.
 *
 * Chaque fonction qui écrit un mot reçoit donc, **en derniers paramètres et tous
 * deux obligatoires**, le contexte d'affichage et le **traducteur du namespace
 * `booking`** de son appelant. Le module dit *quoi* dire — il choisit la clé et
 * la branche —, l'appelant dit dans quelle langue. C'est la forme que l'épique
 * #843 prescrit à un module pur, et exactement celle de `lib/booking/consent.tsx`
 * depuis #1264.
 *
 * Un traducteur et non sept chaînes résolues : quatre des sept phrases portent
 * des paramètres (`{time}`, `{day}`, `{weekday}`), et c'est ce module qui décide
 * laquelle est écrite. Les lui faire toutes préparer par l'appelant reviendrait à
 * lui faire porter la branche.
 *
 * Les défauts français — `FALLBACK_DISPLAY` et le `fill` maison — sont tombés du
 * même geste, ce que l'en-tête d'hier annonçait pour la fin de l'épique #843 :
 * `tsc` nomme désormais tout appelant qui ne résout pas la langue, au lieu de le
 * laisser rendre du français sur un écran anglais.
 *
 * ## Les heures aussi suivent le pays du salon (#1345)
 *
 * Une troisième nature s'était glissée entre les deux précédentes : les **heures
 * murales** du contrat — `'09:00'` —, que ce module recopiait telles quelles. Ce
 * n'était pas un écart tant que tout s'écrivait en 24 heures ; depuis #1325 les
 * *instants* des mêmes écrans suivent le pays du salon, et la carte « Horaires »
 * d'un salon de Manhattan lue en anglais annonçait « 09:00 – 19:00 » au-dessus de
 * créneaux proposés à « 9:00 AM ».
 *
 * Elles passent donc par {@link formatWallTime}, seul point d'écriture d'une heure
 * murale du front, qui lit son étiquette de `formattingLocale` — la règle unique
 * de `@spa/shared` (#1349) — et n'en réécrit rien.
 */

/**
 * Les sept phrases que ce module écrit, sous les clés du namespace `booking`.
 *
 * Énumérées plutôt que déduites d'un gabarit, pour la raison que
 * `lib/booking/consent.tsx` donne à sa propre liste : le traducteur de
 * `next-intl` est typé sur les clés **exactes** du catalogue, et une union plus
 * large que la sienne ne l'accepterait pas en paramètre. La liste fait donc aussi
 * office d'inventaire — la clé qui manquerait dans l'un des deux catalogues
 * échoue à la compilation, et non à l'affichage.
 */
export type HoursMessageKey =
  | 'salon.hours.unknownDay'
  | 'salon.hours.closed'
  | 'salon.hours.midnight'
  | 'salon.hours.openUntil'
  | 'salon.hours.closedOpensAt'
  | 'salon.hours.closedOpensTomorrow'
  | 'salon.hours.closedOpensOnDay';

/**
 * Le traducteur du namespace `booking`, réduit à ce que ce module demande.
 *
 * Il accepte aussi bien celui de `useTranslations('booking')` que celui d'un
 * `await getTranslations('booking')` : un traducteur qui connaît **plus** de clés
 * se passe pour un traducteur qui en demande moins.
 */
export type HoursTranslator = (
  key: HoursMessageKey,
  values?: Readonly<Record<string, string>>,
) => string;

/** Les sept jours, en numérotation ISO — l'ordre de la carte « Horaires ». */
const ISO_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Une semaine de référence dont le premier jour est un lundi.
 *
 * Le 1er janvier 2024 est un lundi : `Date.UTC(2024, 0, weekday)` tombe donc sur
 * le jour ISO `weekday`, de 1 (lundi) à 7 (dimanche), sans qu'aucune table de
 * noms n'ait à être écrite. Lu en UTC, le résultat ne dépend d'aucun fuseau.
 */
function isoWeekdayDate(weekday: number): Date {
  return new Date(Date.UTC(2024, 0, weekday));
}

/**
 * Le nom du jour tel qu'`Intl` l'écrit dans la langue demandée — « lundi »,
 * « Monday ».
 *
 * La **casse est celle de la langue**, et c'est délibéré : le français écrit les
 * jours en minuscules au fil d'une phrase (« ouvre samedi à 10:00 »), l'anglais
 * en capitales (« opens Saturday at 10:00 »). C'est {@link weekdayLabel} qui
 * capitalise pour un emploi autonome, en tête d'une ligne d'horaires.
 *
 * `null` hors des bornes ISO, ou si `Intl` refuse l'étiquette : l'appelant
 * décide alors de son repli plutôt que de recevoir une chaîne inventée.
 */
function weekdayName(weekday: number, display: DisplayLocale): string | null {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > ISO_WEEK.length) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(isoWeekdayDate(weekday));
  } catch {
    return null;
  }
}

/**
 * Le jour tel qu'on l'écrit **seul**, avec un repli qui se voit.
 *
 * Point d'écriture **unique** du repli « jour sans nom » dans `apps/web` (#652).
 * Il n'apparaît jamais en usage normal — la numérotation ISO ne sort pas de
 * 1–7 —, et c'est bien ce qui le rendait dangereux en double : une branche
 * qu'aucun écran n'exerce laisse deux copies diverger sans que rien ne le
 * signale. Or l'une des deux alimentait le nom accessible des 28 champs de la
 * grille horaire des réglages, c'est-à-dire ce qu'un lecteur d'écran annonce.
 *
 * Le nom vient d'`Intl` (#846) ; seul le repli est un message du catalogue,
 * « Jour {weekday} », parce qu'aucun calendrier ne sait nommer un huitième jour.
 *
 * La capitale initiale est posée ici, dans la langue d'affichage : `Intl` rend
 * « lundi » en français, et la carte « Horaires » aligne sept lignes qui
 * commencent par un nom de jour — pas par le milieu d'une phrase.
 *
 * À ne pas confondre avec le `weekdayLabel` de `lib/admin/staff-schedule.ts`,
 * qui reste distinct : celui-là est typé sur `IsoWeekday` et traite
 * délibérément la case 0 comme un jour manquant. Les rapprocher changerait son
 * comportement.
 */
export function weekdayLabel(
  weekday: number,
  display: DisplayLocale,
  t: HoursTranslator,
): string {
  const name = weekdayName(weekday, display);

  if (name === null) {
    // `String(weekday)` et non le nombre : un paramètre numérique serait mis en
    // forme par la locale du message, et « Jour 1 000 » n'est pas un jour.
    return t('salon.hours.unknownDay', { weekday: String(weekday) });
  }

  const tag = formattingLocale(display.locale, display.countryCode);

  return `${name.charAt(0).toLocaleUpperCase(tag)}${name.slice(1)}`;
}

/**
 * Le même jour **au fil d'une phrase** — « ouvert le lundi », « Open on Monday »
 * (#1329).
 *
 * La casse est celle de la langue, et c'est tout ce qui le distingue de
 * {@link weekdayLabel} : `Intl` rend « lundi » en français et « Monday » en
 * anglais, et cette différence **est** la règle typographique de chaque langue.
 *
 * Elle existe parce qu'un `toLowerCase()` appliqué au libellé autonome avait
 * rendu « Open on monday » dans les noms accessibles des vingt-huit champs de la
 * grille horaire des réglages : une règle française appliquée aux deux langues.
 * Le repli reste celui de {@link weekdayLabel} — « Jour 8 » garde sa capitale,
 * faute d'être un mot de la langue.
 */
export function weekdayLabelInSentence(
  weekday: number,
  display: DisplayLocale,
  t: HoursTranslator,
): string {
  return weekdayName(weekday, display) ?? weekdayLabel(weekday, display, t);
}

/**
 * Les mêmes jours pour `schema.org/DayOfWeek`.
 *
 * En URL absolue plutôt qu'en nom nu : c'est la forme que la documentation de
 * schema.org emploie, et la seule qui reste non ambiguë hors du contexte d'un
 * `@context`. Ce sont des **identifiants**, pas des mots : ils ne se traduisent
 * pas, quelle que soit la langue de la page (#846).
 */
export const SCHEMA_ORG_WEEKDAYS: Readonly<Record<number, string>> = {
  1: 'https://schema.org/Monday',
  2: 'https://schema.org/Tuesday',
  3: 'https://schema.org/Wednesday',
  4: 'https://schema.org/Thursday',
  5: 'https://schema.org/Friday',
  6: 'https://schema.org/Saturday',
  7: 'https://schema.org/Sunday',
};

/**
 * Une journée d'ouverture publiée, telle que la carte du salon la rend.
 *
 * **Aucun libellé** (#1142) : le seul appelant — la carte du salon de l'espace
 * client — ne cherche ici que les plages du jour courant, et n'a jamais rendu de
 * nom de jour. Le lui faire porter l'obligeait à réclamer le traducteur du
 * namespace `booking` pour un mot qu'il jette, alors qu'il lit le namespace
 * `account`. Le nom d'un jour s'obtient par {@link weekdayLabel}, qui reste le
 * point d'écriture unique.
 */
export interface OpeningDay {
  readonly weekday: number;
  /** Les plages du jour, dans l'ordre où l'API les a rendues. */
  readonly ranges: readonly OpeningHoursEntry[];
}

/**
 * Regroupe les plages par journée, en conservant l'ordre reçu.
 *
 * Un jour absent du tableau est un jour **fermé** : il ne produit pas de ligne.
 * Afficher « Lundi : fermé » demanderait de savoir que le salon a bien voulu
 * dire « fermé » et non « pas encore saisi », et l'API ne distingue pas les
 * deux — elle omet les horaires plutôt que de rendre une semaine vide.
 *
 * Aucun mot ici, et donc ni langue ni traducteur à passer : ce que rend cette
 * fonction est une journée et ses plages, que l'appelant nomme s'il le veut.
 */
export function groupOpeningHoursByDay(
  entries: readonly OpeningHoursEntry[],
): readonly OpeningDay[] {
  const days: OpeningDay[] = [];
  const byWeekday = new Map<number, OpeningHoursEntry[]>();

  for (const entry of entries) {
    const existing = byWeekday.get(entry.weekday);

    if (existing === undefined) {
      const ranges: OpeningHoursEntry[] = [entry];
      byWeekday.set(entry.weekday, ranges);
      days.push({ weekday: entry.weekday, ranges });
      continue;
    }

    existing.push(entry);
  }

  return days;
}

// ---------------------------------------------------------------------------
// L'heure murale, écrite dans la convention du pays du salon — #1345
// ---------------------------------------------------------------------------

/** Minutes d'une journée civile — la valeur de `24:00`, borne haute légitime. */
const MINUTES_IN_CIVIL_DAY = 24 * 60;

/**
 * Minutes depuis minuit d'une heure murale « HH:MM ».
 *
 * Écrit ici plutôt qu'emprunté à `lib/admin/appointment-desk.ts`, qui en tient
 * déjà un : ce module-ci est chargé par la **vitrine publique**, dont le budget
 * de LCP est de 2,5 s en 4G (skill web-frontend §7), et importer un module du
 * back-office ferait entrer tout son graphe de dépendances dans ce chemin-là.
 * Quelques lignes de lecture valent mieux qu'un couplage de couches.
 *
 * `24:00` est traité à part, comme dans le contrat : c'est la borne haute d'un
 * salon ouvert jusqu'à minuit (`scheduleEndTimeSchema`), et non une heure de
 * début. Une valeur illisible rend `null` et sera ignorée — la validation du
 * contrat l'a déjà refusée à l'écriture, et la vitrine ne doit pas blanchir sur
 * une donnée héritée.
 */
function wallMinutes(time: string): number | null {
  if (time === '24:00') {
    return MINUTES_IN_CIVIL_DAY;
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);

  if (match === null) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Les formateurs d'heure murale, **retenus par étiquette**.
 *
 * La carte « Horaires » en demande jusqu'à vingt-huit par rendu — sept jours,
 * deux plages, deux bornes — toutes sur la même étiquette, et c'est une page dont
 * le budget de LCP est de 2,5 s en 4G. Même parti, et même raison, que le cache de
 * `lib/admin/calendar-grid.ts` et que `separatorsOf` de `@spa/shared` : ce qui ne
 * dépend que de l'étiquette ne se reconstruit pas.
 */
const WALL_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * L'écriture de l'heure de ce contexte d'affichage.
 *
 * `timeStyle: 'short'`, c'est-à-dire **les mêmes options** que
 * `formatTimeInTimeZone` de `lib/format.ts`, et c'est tout l'objet de #1345 : les
 * créneaux de la vitrine et les rendez-vous de « Mon planning » passent par elle,
 * et une plage écrite avec d'autres options aurait pu diverger d'eux à la largeur
 * d'un zéro près — « 09:00 AM » sous un créneau à « 9:00 AM ».
 */
function wallTimeFormatter(display: DisplayLocale): Intl.DateTimeFormat {
  const intlTag = formattingLocale(display.locale, display.countryCode);
  const retained = WALL_TIME_FORMATTERS.get(intlTag);

  if (retained !== undefined) {
    return retained;
  }

  const made = new Intl.DateTimeFormat(intlTag, { timeZone: 'UTC', timeStyle: 'short' });
  WALL_TIME_FORMATTERS.set(intlTag, made);

  return made;
}

/**
 * Des minutes depuis minuit écrites comme le **pays du salon** les écrit —
 * « 09:00 » chez un salon parisien, « 9:00 AM » chez un salon de Manhattan lu en
 * anglais (#1345).
 *
 * La date est arbitraire et le référentiel est UTC : ce qu'on met en forme est un
 * **nombre de minutes** — une heure murale que la gérance a saisie —, et non un
 * instant à reprojeter. Aucun fuseau n'intervient donc ici, et la sortie ne dépend
 * d'aucune machine.
 *
 * `midnight` est le **mot** de la langue pour la borne `24:00` du contrat, et non
 * une heure : `Intl` rendrait « 00:00 », l'heure zéro du lendemain, au milieu
 * d'une plage, et une carte qui annonce « 18:00 – 00:00 » se lit comme une erreur
 * de saisie. C'est l'inverse de l'arbitrage de `lib/admin/calendar-grid.ts`, et
 * pour une raison de fond : là-bas la borne gauche **date** l'intervalle d'un
 * rendez-vous qui court sur la nuit, ici les deux bornes sont deux heures d'un
 * même jour de la semaine.
 */
function wallTimeLabel(minutes: number, display: DisplayLocale, midnight: string): string {
  if (minutes === MINUTES_IN_CIVIL_DAY) {
    return midnight;
  }

  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  try {
    // Les espaces d'`Intl` sont rendus **insécables**, et c'est la même raison que
    // celle de {@link formatOpeningRange} : en douze heures la sortie en porte un
    // — « 9:00 AM » —, et un retour à la ligne qui y tomberait laisserait « 9:00 »
    // seul en fin de ligne, c'est-à-dire une heure du matin là où il est 21 h. Le
    // cas n'existait pas tant que tout s'écrivait en 24 heures ; il apparaît avec
    // #1345, sur la colonne étroite de la carte « Horaires » à 360 px.
    //
    // Seul U+0020 est remplacé : selon la version d'ICU, la même sortie porte déjà
    // U+202F, qui est insécable de naissance. Rien ne change à l'œil — l'écriture
    // reste celle de `formatTimeInTimeZone`, au caractère blanc près.
    return wallTimeFormatter(display)
      .format(new Date(Date.UTC(2024, 0, 1, hour, minute)))
      .replace(/\u0020/gu, '\u00a0');
  } catch {
    // Même précaution que `weekdayName` : une étiquette qu'`Intl` refuse rend la
    // forme du contrat plutôt que de faire tomber la vitrine entière.
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
}

/**
 * Point d'écriture **unique** d'une heure murale du contrat dans `apps/web` —
 * « 09:00 », « 9:00 AM », « minuit » pour `24:00` (#1345).
 *
 * Exportée parce que « Mon planning » écrit les mêmes heures que la vitrine :
 * `lib/admin/my-planning.ts` la lit d'ici, et les plages de travail d'un
 * praticien suivent donc la convention de son salon, exactement comme les
 * rendez-vous affichés dans la même colonne. L'import va du back-office vers ce
 * module, et jamais l'inverse — c'est le sens qui ne coûte rien au LCP de la
 * vitrine, celui-là même que `wallMinutes` ci-dessus refuse de prendre.
 *
 * Le **mot** de minuit est un paramètre et non une clé lue ici : les deux surfaces
 * ne lisent pas le même namespace — `booking` pour la vitrine,
 * `admin-my-planning` pour le back-office —, et ce module n'importe plus aucun
 * catalogue (#1142).
 *
 * Une heure que le contrat n'aurait pas validée est rendue **telle quelle** : la
 * vitrine montre ce qui est en base plutôt que de blanchir une ligne, comme
 * partout ailleurs dans ce module.
 */
export function formatWallTime(time: string, display: DisplayLocale, midnight: string): string {
  const minutes = wallMinutes(time);

  return minutes === null ? time : wallTimeLabel(minutes, display, midnight);
}

/**
 * « 09:00 – 12:00 », « 9:00 AM – 12:00 PM », avec un tiret demi-cadratin et des
 * espaces insécables.
 *
 * L'espace insécable n'est pas une coquetterie : sans lui, un retour à la ligne
 * peut tomber entre l'heure et le tiret, et la plage se lit alors comme deux
 * heures sans rapport.
 *
 * Les deux bornes passent par {@link formatWallTime} depuis #1345 : elles étaient
 * recopiées du contrat, et la carte « Horaires » d'un salon de Manhattan lue en
 * anglais annonçait donc « 09:00 – 19:00 » au-dessus de créneaux proposés à
 * « 9:00 AM ». Le seul mot de la fonction est celui de minuit, d'où le traducteur
 * (#846, #1142).
 */
export function formatOpeningRange(
  entry: OpeningHoursEntry,
  display: DisplayLocale,
  t: HoursTranslator,
): string {
  const midnight = t('salon.hours.midnight');

  return `${formatWallTime(entry.opensAt, display, midnight)}\u00a0\u2013\u00a0${formatWallTime(entry.closesAt, display, midnight)}`;
}

// ---------------------------------------------------------------------------
// La semaine entière, jours fermés compris — BM-VITRINE-03 (#1046)
// ---------------------------------------------------------------------------

/** Une journée de la semaine, telle que la carte « Horaires » la rend. */
export interface ScheduledDay {
  readonly weekday: number;
  readonly label: string;
  /** Les plages du jour — **vide** quand le salon est fermé ce jour-là. */
  readonly ranges: readonly OpeningHoursEntry[];
}

/**
 * La semaine complète, du lundi au dimanche, jours fermés compris (BM-VITRINE-03).
 *
 * ## Ce qui change, et la raison qui l'autorise
 *
 * `groupOpeningHoursByDay` ci-dessus n'affiche que les jours reçus, au motif —
 * exact — que l'API ne distingue pas « le salon ferme le lundi » de « le salon
 * n'a pas encore saisi ses horaires ». Elle reste employée par la carte du salon
 * de l'espace client (`components/account/salon-aside.tsx`), qui n'y cherche que
 * les plages du jour courant et ne doit affirmer que ce qui a été publié. Les
 * données structurées, elles, ne passent pas par ici : `structured-data.tsx`
 * compose son `openingHoursSpecification` directement sur `tenant.openingHours`.
 *
 * Pour un lecteur humain, la distinction se tranche un cran plus haut : dès que
 * le salon a publié **une** plage, sa semaine est saisie, et un jour qui n'y
 * figure pas est un jour fermé. C'est la seule lecture qui rende la carte utile
 * — sept lignes dont les fermetures sont écrites — sans rien inventer, puisque
 * le cas « rien de saisi » est écarté par le tableau vide.
 *
 * Un tableau **vide** rend donc un tableau vide, et non sept jours « Fermé » :
 * un salon qui n'a rien renseigné n'est pas un salon fermé toute la semaine.
 *
 * Le mot « Fermé » lui-même n'est pas écrit ici : ce que rend cette fonction est
 * une journée **sans plage**, et c'est la carte qui la nomme, avec le catalogue
 * sous la main (#846).
 */
export function weekSchedule(
  entries: readonly OpeningHoursEntry[],
  display: DisplayLocale,
  t: HoursTranslator,
): readonly ScheduledDay[] {
  if (entries.length === 0) {
    return [];
  }

  return ISO_WEEK.map((weekday) => ({
    weekday,
    label: weekdayLabel(weekday, display, t),
    ranges: entries.filter((entry) => entry.weekday === weekday),
  }));
}

// ---------------------------------------------------------------------------
// L'état d'ouverture, calculé pour maintenant — BM-VITRINE-02 (#1046)
// ---------------------------------------------------------------------------

/** L'horloge du salon : le jour ISO et l'heure qu'il est **chez lui**. */
export interface SalonClock {
  readonly weekday: number;
  /** Minutes écoulées depuis minuit, dans le fuseau du salon. */
  readonly minutes: number;
}

/** Les abréviations qu'`Intl` rend en `en-US`, ramenées à la numérotation ISO. */
const ISO_WEEKDAY_OF: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * L'instant courant lu à l'horloge du salon.
 *
 * `hourCycle: 'h23'` et non `hour12: false` — les deux se contredisent sur
 * certains moteurs, et `hour12: false` seul peut rendre `24` pour minuit, ce qui
 * placerait 00 h 15 après la fermeture de la veille. Même précaution que
 * `lib/admin/calendar-grid.ts`, pour la même raison.
 *
 * `en-US` et non la locale d'affichage : ce sont les clés d'un `Record` qu'on
 * lit, pas un texte qu'on montre. La langue de la page n'a donc rien à y faire
 * (#846) — la changer casserait la table ci-dessus. Un fuseau inconnu fait lever
 * `Intl` — la fonction rend alors `null`, et l'appelant se tait plutôt que
 * d'annoncer un état d'ouverture faux.
 */
export function salonClock(timezone: string, now: Date): SalonClock | null {
  let parts: readonly Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return null;
  }

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = ISO_WEEKDAY_OF[value('weekday')];
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));

  if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  return { weekday, minutes: hour * 60 + minute };
}

/** Ce que le bandeau d'identité écrit de l'ouverture du salon. */
export interface OpeningStatus {
  /** Le salon est-il ouvert **en ce moment**, à son horloge à lui ? */
  readonly open: boolean;
  /** « Ouvert — ferme à 19:00 », « Fermé — ouvre demain à 10:00 », « Fermé ». */
  readonly label: string;
}

/**
 * L'état d'ouverture du salon **maintenant**, dans son fuseau (BM-VITRINE-02).
 *
 * Une ligne d'état plutôt qu'un tableau à interpréter : « la cliente sait tout
 * de suite si elle peut venir, et quand ». La carte « Horaires » reste là pour
 * qui veut la semaine.
 *
 * `now` est un paramètre et non un `new Date()` enfoui : c'est ce qui rend la
 * fonction testable sans geler l'horloge du processus, et c'est la page qui
 * décide de l'instant — elle est rendue à chaque requête (`force-dynamic`).
 *
 * `display` et `t` sont les deux derniers paramètres, et tous deux obligatoires :
 * les phrases viennent du catalogue (#846) et c'est l'appelant qui l'ouvre
 * (#1142) — voir l'en-tête.
 *
 * `null` quand le salon n'a publié aucun horaire, ou quand son fuseau est
 * illisible : on ne dit rien plutôt que de dire faux. Un salon annoncé « fermé »
 * à tort est une cliente qui n'appelle pas.
 */
export function openingStatus(
  entries: readonly OpeningHoursEntry[],
  timezone: string,
  now: Date,
  display: DisplayLocale,
  t: HoursTranslator,
): OpeningStatus | null {
  if (entries.length === 0) {
    return null;
  }

  const clock = salonClock(timezone, now);

  if (clock === null) {
    return null;
  }

  for (const entry of entries) {
    if (entry.weekday !== clock.weekday) {
      continue;
    }

    const opens = wallMinutes(entry.opensAt);
    const closes = wallMinutes(entry.closesAt);

    if (opens === null || closes === null || closes <= opens) {
      continue;
    }

    if (clock.minutes >= opens && clock.minutes < closes) {
      // L'heure de fermeture est mise en forme, et non recopiée du contrat
      // (#1345) : le bandeau d'un salon américain annonçait « closes at 19:00 »
      // au-dessus de créneaux à « 7:00 PM ». `closes` est déjà lu, et `24:00` y
      // vaut 1440 : c'est `wallTimeLabel` qui en fait « minuit ».
      return {
        open: true,
        label: t('salon.hours.openUntil', {
          time: wallTimeLabel(closes, display, t('salon.hours.midnight')),
        }),
      };
    }
  }

  const next = nextOpening(entries, clock, display, t);

  return { open: false, label: next ?? t('salon.hours.closed') };
}

/**
 * La prochaine ouverture, dite comme on la dit : « Fermé — ouvre à 14:00 »,
 * « Fermé — ouvre demain à 10:00 », « Fermé — ouvre samedi à 10:00 ».
 *
 * La semaine entière est parcourue, **jour de départ compris une seconde fois**
 * (`offset` va jusqu'à 7) : un salon qui n'ouvre qu'un jour par semaine
 * n'annoncerait sinon aucune prochaine ouverture une fois ce jour-là refermé,
 * et sa vitrine se bornerait à « Fermé » le soir même. `null` ne subsiste que
 * quand aucune plage lisible n'existe — un salon dont toutes les plages sont
 * illisibles se dit « Fermé », sans promesse.
 *
 * Le nom du jour est celui qu'`Intl` écrit **au fil d'une phrase**, sans
 * capitale forcée : « ouvre samedi » en français, « opens Saturday » en anglais
 * (#846). Le forcer d'un côté ou de l'autre aurait fait écrire l'une des deux
 * langues comme l'autre.
 */
function nextOpening(
  entries: readonly OpeningHoursEntry[],
  clock: SalonClock,
  display: DisplayLocale,
  t: HoursTranslator,
): string | null {
  for (let offset = 0; offset <= ISO_WEEK.length; offset += 1) {
    const weekday = ((clock.weekday - 1 + offset) % ISO_WEEK.length) + 1;

    const opens = entries
      .filter((entry) => entry.weekday === weekday)
      .map((entry) => wallMinutes(entry.opensAt))
      .filter((minutes): minutes is number => minutes !== null)
      // Aujourd'hui, une ouverture déjà passée n'est pas la prochaine.
      .filter((minutes) => offset > 0 || minutes > clock.minutes)
      .sort((left, right) => left - right);

    const earliest = opens[0];

    if (earliest === undefined) {
      continue;
    }

    // Écrite dans la convention du pays du salon, comme la plage qu'elle ouvre
    // (#1345). `24:00` n'y arrive pas — le contrat le refuse pour un `opensAt` —,
    // mais le mot est passé quand même : une seule façon d'écrire une heure.
    const time = wallTimeLabel(earliest, display, t('salon.hours.midnight'));

    if (offset === 0) {
      return t('salon.hours.closedOpensAt', { time });
    }

    if (offset === 1) {
      return t('salon.hours.closedOpensTomorrow', { time });
    }

    return t('salon.hours.closedOpensOnDay', {
      day: weekdayName(weekday, display) ?? weekdayLabel(weekday, display, t),
      time,
    });
  }

  return null;
}
