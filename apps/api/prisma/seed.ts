/**
 * Jeu de données de recette — #76, CDC §4.13.
 *
 * « Un environnement de recette proche de la production à échelle réduite »
 * suppose des données à exercer. Ce script les pose : **deux établissements**,
 * leurs comptes, leur catalogue, leur personnel, leurs horaires et une poignée
 * de rendez-vous dans les cinq statuts du cycle de vie — de quoi dérouler
 * « réserver → confirmer → honorer → encaisser → mesurer » sans rien saisir à la
 * main.
 *
 * ## Deux établissements, et c'est le point
 *
 * Un seul tenant ne prouverait rien de ce que ce produit doit garantir en
 * premier : qu'aucune requête ne traverse la frontière d'un établissement
 * (CLAUDE.md, contrainte 2). Deux tenants, chacun avec ses comptes, ses
 * prestations et ses rendez-vous, rendent l'isolation **exerçable** — la
 * recette rejoue chaque route avec le jeton du voisin et attend un 404
 * (tenant-isolation §4, §6).
 *
 * Les deux ne sont pas des copies l'un de l'autre. Ils diffèrent par ce qui
 * casse en silence quand on se trompe :
 *
 *   * leur **fuseau** — `Europe/Paris` et `Indian/Antananarivo`. Un agenda mal
 *     fuseau-horairé est un bug de sévérité haute, et il ne se voit pas sur un
 *     jeu de données mono-fuseau ;
 *   * leur **taux de taxe** — 20 % et 0 %. Un ticket dont la ligne de taxe est
 *     fondue dans le prix est irréconciliable avec la comptabilité du salon
 *     (payments-stripe §5) ;
 *   * leur **pas de créneau** et leur **préavis minimum**, qui gouvernent ce que
 *     la page publique propose.
 *
 * ## Toute ligne porte son `tenant_id`
 *
 * Sans exception (tenant-isolation §1). Ce script écrit avec un `PrismaClient`
 * **nu**, sans l'extension de scoping de l'API : il est légitimement
 * inter-tenants, et c'est précisément pour cela qu'il pose lui-même chaque
 * `tenantId`, explicitement, ligne après ligne. Il n'y a pas de contexte de
 * requête ici pour le faire à sa place, et un oubli produirait une donnée
 * orpheline que la contrainte de clé étrangère refuserait — le bon échec.
 *
 * ## Idempotent
 *
 * Rejouable autant de fois qu'on veut, sur une base vide comme sur une base
 * déjà chargée : chaque ligne est identifiée par un UUID **déterministe**
 * (UUIDv5 d'un espace de noms fixe), et écrite par `upsert`. Deuxième
 * exécution, aucune ligne en double ; dixième, non plus.
 *
 * Les rendez-vous sont ancrés sur le **jour courant** : les rejouer les fait
 * glisser dans le temps, sur les mêmes lignes. C'est voulu — un jeu de recette
 * dont le « rendez-vous de demain » est daté du mois dernier ne sert plus à
 * rien, et surtout plus au rappel J-1.
 *
 * Le glissement est borné aux **jours ouvrés** (`openDayOffset`) : les
 * praticiens ne travaillent que du lundi au vendredi et le dimanche est fermé,
 * si bien qu'un décalage brut posait, selon le jour où le seed était joué, des
 * rendez-vous un samedi ou un dimanche — sur un agenda que ni les horaires du
 * personnel ni la vitrine ne connaissent.
 *
 * Une chose n'est délibérément pas mise à jour : l'**empreinte de mot de
 * passe**. bcrypt tire un sel neuf à chaque appel, la réécrire à chaque
 * exécution ferait battre `updated_at` sur tous les comptes sans qu'aucun
 * identifiant ne change. Pour changer le mot de passe de recette, supprimer les
 * comptes ou passer par l'API.
 *
 * ## Il refuse de s'exécuter contre une base de production
 *
 * Trois barrières, toutes en **défaut fermé** — voir `assertSafeTarget`. La
 * dernière est la seule qui compte vraiment le jour où quelqu'un se trompe de
 * `DATABASE_URL` exportée.
 *
 * ## Comment l'exécuter
 *
 * Depuis `apps/api`, contre la base locale du `docker-compose.yml` :
 *
 *     DATABASE_URL="postgresql://spa:spa@localhost:5433/spa_dev" \
 *     SEED_TARGET=local \
 *     node --require ts-node/register prisma/seed.ts
 *
 * Contre la base de recette, depuis une session qui l'atteint (tunnel Session
 * Manager, cf. skill aws-infra §4) :
 *
 *     DATABASE_URL="<lu dans le secret d'exécution>" \
 *     SEED_TARGET=staging \
 *     node --require ts-node/register prisma/seed.ts
 *
 * Le raccourci `prisma db seed` demande une clé `prisma.seed` dans
 * `apps/api/package.json`, hors de l'empreinte de fichiers de #76 : c'est l'objet
 * de l'issue de suivi #588.
 */

import { createHash } from 'node:crypto';

import { hash } from 'bcryptjs';
import {
  AppointmentCancelledBy,
  AppointmentStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  SaleItemKind,
  UserRole,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Sortie
// ---------------------------------------------------------------------------

/**
 * `console.log` est interdit par la configuration ESLint du paquet (seul
 * `console.error` est admis). L'écriture directe sur la sortie standard dit la
 * même chose sans l'exception.
 */
function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Garde-fous — le script refuse de s'exécuter contre une base de production
// ---------------------------------------------------------------------------

/**
 * Cibles admises. **Liste blanche, pas liste noire** : une liste noire de
 * motifs « production » laisse passer tout ce qu'elle n'a pas prévu, et c'est
 * exactement le cas qui coûte cher. Ici, une valeur inconnue — ou absente —
 * arrête le script.
 */
const ALLOWED_TARGETS = ['local', 'staging'] as const;
type SeedTarget = (typeof ALLOWED_TARGETS)[number];

/** Hôtes acceptés quand la cible déclarée est `local`. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'postgres']);

class UnsafeSeedTargetError extends Error {
  public constructor(reason: string) {
    super(
      `Chargement refusé — ${reason}\n` +
        "Ce script écrit un jeu de données de recette : il n'a rien à faire dans une base " +
        'de production, et il préfère refuser un cas légitime que charger un cas qui ne ' +
        "l'est pas.",
    );
    this.name = 'UnsafeSeedTargetError';
  }
}

/**
 * Les trois barrières, dans l'ordre où elles se posent.
 *
 * 1. `SEED_TARGET` doit être déclarée et connue. Pas de défaut : charger des
 *    données est un acte, il se demande.
 * 2. La chaîne de connexion ne doit **jamais** nommer la production, quelle que
 *    soit la cible déclarée. Les ressources du projet s'appellent
 *    `spa-{env}-…` (skill aws-infra §2) : un hôte, une base ou un utilisateur
 *    qui contient `prod` désigne la production, et le geste s'arrête là. C'est
 *    la barrière qui rattrape le vrai scénario de panne — la bonne intention,
 *    la mauvaise variable exportée.
 * 3. `SEED_TARGET=local` exige un hôte local. Sans elle, une session qui a
 *    encore l'URL de recette dans son environnement chargerait la recette en
 *    croyant charger sa base de développement.
 *
 * Ce qui n'est **jamais** journalisé : la chaîne de connexion elle-même. Elle
 * porte le mot de passe maître de l'instance.
 */
function assertSafeTarget(databaseUrl: string): SeedTarget {
  const declared = process.env.SEED_TARGET;
  if (declared === undefined || !ALLOWED_TARGETS.includes(declared as SeedTarget)) {
    throw new UnsafeSeedTargetError(
      `SEED_TARGET vaut ${declared === undefined ? '(absente)' : `« ${declared} »`}, ` +
        `attendu l'une de : ${ALLOWED_TARGETS.join(', ')}.`,
    );
  }
  const target = declared as SeedTarget;

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnsafeSeedTargetError("DATABASE_URL n'est pas une URL analysable.");
  }

  const host = url.hostname.toLowerCase();
  const database = url.pathname.replace(/^\//, '').toLowerCase();
  const user = decodeURIComponent(url.username).toLowerCase();

  for (const [label, value] of [
    ["l'hôte", host],
    ['le nom de base', database],
    ["l'utilisateur", user],
  ] as const) {
    if (value.includes('prod')) {
      throw new UnsafeSeedTargetError(
        `${label} de DATABASE_URL contient « prod » (${value}). ` +
          'Les ressources du projet sont nommées `spa-{env}-…` : cette base est celle de la production.',
      );
    }
  }

  if (target === 'local' && !LOCAL_HOSTS.has(host)) {
    throw new UnsafeSeedTargetError(
      `SEED_TARGET vaut « local » mais DATABASE_URL vise l'hôte distant « ${host} ». ` +
        'Corriger la variable, ou déclarer la cible réelle.',
    );
  }

  return target;
}

// ---------------------------------------------------------------------------
// Identifiants déterministes
// ---------------------------------------------------------------------------

/**
 * Espace de noms de ce jeu de données. Fixe et arbitraire : il n'a de sens que
 * comme graine, et le changer réécrirait tout le jeu sous de nouveaux
 * identifiants — c'est-à-dire en doublerait chaque ligne.
 */
const SEED_NAMESPACE = '9f2b8c14-6a7d-4c53-9d1e-2f5a8b0c3d47';

/**
 * UUID version 5 (SHA-1) — la construction de la RFC 4122.
 *
 * Déterministe **par conception**, et c'est ce qui rend le script rejouable :
 * `upsert` a besoin d'une clé stable, et la moitié des tables du schéma n'a pas
 * d'unique métier sur lequel s'accrocher — un rendez-vous ne se distingue pas
 * par un slug. Le même nom rend donc toujours le même identifiant, sur
 * n'importe quelle machine, à n'importe quelle exécution.
 *
 * Ce sont bien des UUID : le schéma en veut partout, et l'énumération
 * d'identifiants séquentiels est un vecteur de fuite inter-tenant à part
 * entière (tenant-isolation §4). Prévisibles pour qui connaît la graine, ce qui
 * n'a de conséquence que sur un jeu de données de recette — jamais sur une
 * donnée réelle, qu'aucun code de production ne fabrique ainsi.
 */
function seedId(...parts: readonly string[]): string {
  const namespaceBytes = Buffer.from(SEED_NAMESPACE.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(parts.join('/'), 'utf8'))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5 sur les quatre bits de poids fort de l'octet 6, variante RFC 4122
  // sur les deux bits de poids fort de l'octet 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// Heures murales et instants
// ---------------------------------------------------------------------------

/**
 * Décalage du fuseau à un instant donné, en minutes.
 *
 * `Intl` est la seule source de vérité disponible sans dépendance : elle porte
 * la base IANA du runtime, changements d'heure compris.
 */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `hourCycle: 'h23'` et non `hour12: false`. Les deux se ressemblent, ils ne
    // font pas la même chose : `hour12: false` laisse ICU choisir entre les
    // cycles `h23` (00–23) et `h24` (01–24), et Node 20 choisit `h24` — minuit y
    // est rendu **`24`**, avec la date du jour qui commence. `Date.UTC(…, 21,
    // 24, …)` vaut alors le 22 à minuit, et le décalage calculé gagne
    // vingt-quatre heures.
    //
    // La panne était silencieuse partout ailleurs : elle n'apparaît que sur un
    // instant qui tombe **exactement** à minuit local. C'est le cas de l'absence
    // du praticien, posée à `at(0)`, qui se retrouvait un jour trop tôt — donc
    // un dimanche, jour de fermeture, où il n'y avait plus rien à soustraire des
    // fenêtres de travail.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number.parseInt(value, 10);
  };

  // Ceinture et bretelles : les versions d'ICU ne s'accordent pas toutes sur le
  // cycle demandé, et `24 % 24` vaut `0` sans toucher au champ `day` — que la
  // forme `h24` porte déjà au jour qui commence.
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * Convertit une heure **murale** — ce que montre l'horloge du salon — en
 * l'instant UTC correspondant.
 *
 * Deux passes, et la seconde n'est pas de la superstition : le décalage à
 * appliquer dépend de l'instant, et l'instant dépend du décalage. La première
 * approximation suffit à tomber dans la bonne saison, la seconde corrige les
 * quelques heures qui encadrent un changement d'heure.
 *
 * Le résultat est stocké tel quel : **tout instant est en UTC en base**
 * (CLAUDE.md), et c'est `tenants.timezone` qui le rend à l'affichage.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutesFromMidnight);
  const firstPass = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
  return new Date(naive - zoneOffsetMinutes(firstPass, timeZone) * 60_000);
}

/** Date civile obtenue en décalant le jour courant de `offsetDays`. */
function civilDate(offsetDays: number): { year: number; month: number; day: number } {
  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return {
    year: anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day: anchor.getUTCDate(),
  };
}

/** Instant d'un rendez-vous : jour relatif + heure murale du salon. */
function appointmentStart(offsetDays: number, minutes: number, timeZone: string): Date {
  const { year, month, day } = civilDate(offsetDays);
  return wallClockToUtc(year, month, day, minutes, timeZone);
}

/**
 * Jours ISO travaillés par les deux établissements — du lundi au vendredi.
 * `WORKING_WINDOWS` en découpe les fenêtres plus bas, et `openDayOffset` s'en
 * sert pour ne jamais poser de donnée un jour où personne ne travaille.
 */
const WORKING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Jour ISO — 1 lundi … 7 dimanche — du jour courant décalé de `offsetDays`. */
function isoWeekday(offsetDays: number): number {
  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  const day = anchor.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Ramène un décalage de jour sur le **jour ouvré** le plus proche, dans le sens
 * où il pointe : un décalage passé recule, un décalage futur avance.
 *
 * Sans lui, le jeu de données dépend du jour où on le joue. Les praticiens ne
 * travaillent que du lundi au vendredi (`WORKING_WINDOWS`) et le dimanche est un
 * jour de fermeture de l'établissement (`TenantClosingDay`) : un `dayOffset` de
 * `+1` joué un vendredi poserait le rendez-vous « de demain » — celui-là même
 * que le balayage du rappel J-1 doit trouver — un samedi, sur un agenda que ni
 * les horaires du personnel ni la vitrine ne connaissent. Relevé : sur les sept
 * jours de la semaine, seul un lancement le lundi laissait les cinq rendez-vous
 * en semaine.
 *
 * Le glissement reste voulu — le jeu suit le calendrier —, il est simplement
 * borné aux jours où le salon ouvre.
 */
function openDayOffset(offsetDays: number): number {
  const step = offsetDays < 0 ? -1 : 1;
  let offset = offsetDays;
  // Sept pas suffisent à traverser n'importe quel week-end ; la borne évite une
  // boucle infinie si `WORKING_WEEKDAYS` venait à être vidé.
  for (let guard = 0; guard < 7 && !WORKING_WEEKDAYS.includes(isoWeekday(offset)); guard += 1) {
    offset += step;
  }
  return offset;
}

function minutesLater(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/** Heure murale, en minutes depuis minuit local. */
const at = (hour: number, minute = 0): number => hour * 60 + minute;

// ---------------------------------------------------------------------------
// Le jeu de données
// ---------------------------------------------------------------------------

interface StaffFixture {
  readonly key: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly displayName: string;
  readonly bio: string;
}

interface ServiceFixture {
  readonly key: string;
  readonly categoryKey: string;
  readonly name: string;
  readonly description: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly priceAmountMinor: number;
  /** Praticiens qui pratiquent cette prestation, par `key`. */
  readonly staffKeys: readonly string[];
}

interface AppointmentFixture {
  readonly key: string;
  readonly staffKey: string;
  readonly serviceKey: string;
  readonly clientKey: string;
  readonly dayOffset: number;
  readonly startMinute: number;
  readonly status: AppointmentStatus;
  readonly clientNote?: string;
  readonly cancelledBy?: AppointmentCancelledBy;
  readonly cancellationReason?: string;
}

interface TenantFixture {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly taxRateBps: number;
  readonly slotIntervalMinutes: number;
  readonly minBookingNoticeMinutes: number;
  readonly address: {
    readonly line1: string;
    readonly postalCode: string;
    readonly city: string;
    readonly countryCode: string;
  };
  readonly categories: readonly { readonly key: string; readonly name: string }[];
  readonly staff: readonly StaffFixture[];
  readonly services: readonly ServiceFixture[];
  readonly clients: readonly {
    readonly key: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly phone: string;
  }[];
  readonly product: { readonly sku: string; readonly name: string; readonly priceAmountMinor: number };
  readonly appointments: readonly AppointmentFixture[];
}

/**
 * Horaires de travail communs aux deux établissements : du lundi au vendredi,
 * 09:00–13:00 puis 14:00–19:00. Deux plages par jour, et non une seule de neuf
 * heures — c'est ainsi que se dit la coupure méridienne, et c'est ce que le
 * moteur de créneaux doit savoir découper.
 */
const WORKING_WINDOWS: readonly { readonly weekday: number; readonly start: number; readonly end: number }[] =
  WORKING_WEEKDAYS.flatMap((weekday) => [
    { weekday, start: at(9), end: at(13) },
    { weekday, start: at(14), end: at(19) },
  ]);

const TENANTS: readonly TenantFixture[] = [
  {
    slug: 'spa-lumiere',
    name: 'Spa Lumière',
    timezone: 'Europe/Paris',
    currency: 'EUR',
    // 20 % — le cas nominal d'un établissement français, et ce qui fait exister
    // une ligne de taxe distincte sur le ticket.
    taxRateBps: 2000,
    slotIntervalMinutes: 15,
    minBookingNoticeMinutes: 120,
    address: {
      line1: '12 rue des Tilleuls',
      postalCode: '69003',
      city: 'Lyon',
      countryCode: 'FR',
    },
    categories: [
      { key: 'soins-visage', name: 'Soins du visage' },
      { key: 'massages', name: 'Massages' },
    ],
    staff: [
      {
        key: 'claire',
        firstName: 'Claire',
        lastName: 'Fontaine',
        displayName: 'Claire F.',
        bio: 'Praticienne en soins du visage depuis huit ans.',
      },
      {
        key: 'yanis',
        firstName: 'Yanis',
        lastName: 'Berrada',
        displayName: 'Yanis B.',
        bio: 'Massages suédois et deep tissue.',
      },
    ],
    services: [
      {
        key: 'soin-eclat',
        categoryKey: 'soins-visage',
        name: 'Soin éclat 45 min',
        description: 'Nettoyage, gommage et masque hydratant.',
        durationMinutes: 45,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        priceAmountMinor: 6500,
        staffKeys: ['claire'],
      },
      {
        key: 'massage-suedois',
        categoryKey: 'massages',
        name: 'Massage suédois 60 min',
        description: 'Massage tonique du corps entier.',
        durationMinutes: 60,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
        priceAmountMinor: 8500,
        staffKeys: ['yanis'],
      },
      {
        key: 'rituel-duo',
        categoryKey: 'massages',
        name: 'Rituel duo 90 min',
        description: 'Gommage puis massage, à deux mains ou à quatre.',
        durationMinutes: 90,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 20,
        priceAmountMinor: 14000,
        // Deux praticiens sur la même prestation : c'est ce qui fait exister le
        // choix « n'importe quel praticien » du tunnel de réservation.
        staffKeys: ['claire', 'yanis'],
      },
    ],
    clients: [
      { key: 'alice', firstName: 'Alice', lastName: 'Marchand', phone: '+33600000001' },
      { key: 'bruno', firstName: 'Bruno', lastName: 'Nguyen', phone: '+33600000002' },
      { key: 'carla', firstName: 'Carla', lastName: 'Sow', phone: '+33600000003' },
    ],
    product: { sku: 'HUILE-ARGAN-100', name: 'Huile d’argan 100 ml', priceAmountMinor: 2400 },
    appointments: [
      {
        key: 'honore',
        staffKey: 'claire',
        serviceKey: 'soin-eclat',
        clientKey: 'alice',
        dayOffset: -7,
        startMinute: at(10),
        status: AppointmentStatus.COMPLETED,
      },
      {
        key: 'demain',
        staffKey: 'claire',
        serviceKey: 'soin-eclat',
        clientKey: 'bruno',
        dayOffset: 1,
        startMinute: at(10),
        status: AppointmentStatus.CONFIRMED,
        clientNote: 'Première visite.',
      },
      {
        key: 'a-confirmer',
        staffKey: 'yanis',
        serviceKey: 'massage-suedois',
        clientKey: 'carla',
        dayOffset: 2,
        startMinute: at(15),
        status: AppointmentStatus.PENDING,
      },
      {
        key: 'absente',
        staffKey: 'yanis',
        serviceKey: 'massage-suedois',
        clientKey: 'alice',
        dayOffset: -3,
        startMinute: at(11),
        status: AppointmentStatus.NO_SHOW,
      },
      {
        key: 'annule',
        staffKey: 'claire',
        serviceKey: 'rituel-duo',
        clientKey: 'carla',
        dayOffset: 3,
        startMinute: at(9, 30),
        status: AppointmentStatus.CANCELLED,
        cancelledBy: AppointmentCancelledBy.CLIENT,
        cancellationReason: 'Empêchement de dernière minute.',
      },
    ],
  },
  {
    slug: 'barber-tana',
    name: 'Barber Tana',
    // Second fuseau, et c'est délibéré : un décalage figé passe inaperçu tant
    // que tout le jeu de données vit dans la même zone.
    timezone: 'Indian/Antananarivo',
    // Même devise que le voisin, pour une raison de fond : l'ariary n'a pas de
    // sous-unité, et un montant en « plus petite unité » y vaudrait l'unité
    // entière. Le jeu de recette n'est pas l'endroit où éprouver ce cas — il le
    // masquerait plus qu'il ne l'exposerait.
    currency: 'EUR',
    // 0 % — l'établissement sans taxe. Le ticket ne porte alors aucune ligne de
    // taxe, et c'est le second cas que le POS doit savoir composer.
    taxRateBps: 0,
    slotIntervalMinutes: 30,
    minBookingNoticeMinutes: 60,
    address: {
      line1: 'Lot II M 12 Analakely',
      postalCode: '101',
      city: 'Antananarivo',
      countryCode: 'MG',
    },
    categories: [
      { key: 'coupe', name: 'Coupe' },
      { key: 'barbe', name: 'Barbe' },
    ],
    staff: [
      {
        key: 'tojo',
        firstName: 'Tojo',
        lastName: 'Rakoto',
        displayName: 'Tojo R.',
        bio: 'Coupes classiques et dégradés.',
      },
      {
        key: 'mamy',
        firstName: 'Mamy',
        lastName: 'Andria',
        displayName: 'Mamy A.',
        bio: 'Taille de barbe au rasoir.',
      },
    ],
    services: [
      {
        key: 'coupe-homme',
        categoryKey: 'coupe',
        name: 'Coupe homme 30 min',
        description: 'Coupe aux ciseaux ou à la tondeuse, shampoing compris.',
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
        priceAmountMinor: 1800,
        staffKeys: ['tojo', 'mamy'],
      },
      {
        key: 'taille-barbe',
        categoryKey: 'barbe',
        name: 'Taille de barbe 20 min',
        description: 'Contours au rasoir et soin.',
        durationMinutes: 20,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
        priceAmountMinor: 1200,
        staffKeys: ['mamy'],
      },
      {
        key: 'coupe-barbe',
        categoryKey: 'coupe',
        name: 'Coupe et barbe 50 min',
        description: 'La coupe et la taille dans le même passage.',
        durationMinutes: 50,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        priceAmountMinor: 2700,
        staffKeys: ['tojo'],
      },
    ],
    clients: [
      { key: 'faniry', firstName: 'Faniry', lastName: 'Rasoa', phone: '+261320000001' },
      { key: 'herizo', firstName: 'Herizo', lastName: 'Randria', phone: '+261320000002' },
      { key: 'nirina', firstName: 'Nirina', lastName: 'Ravalo', phone: '+261320000003' },
    ],
    product: { sku: 'CIRE-MATE-75', name: 'Cire coiffante mate 75 ml', priceAmountMinor: 900 },
    appointments: [
      {
        key: 'honore',
        staffKey: 'tojo',
        serviceKey: 'coupe-homme',
        clientKey: 'faniry',
        dayOffset: -7,
        startMinute: at(10),
        status: AppointmentStatus.COMPLETED,
      },
      {
        key: 'demain',
        staffKey: 'tojo',
        serviceKey: 'coupe-barbe',
        clientKey: 'herizo',
        dayOffset: 1,
        startMinute: at(10),
        status: AppointmentStatus.CONFIRMED,
      },
      {
        key: 'a-confirmer',
        staffKey: 'mamy',
        serviceKey: 'taille-barbe',
        clientKey: 'nirina',
        dayOffset: 2,
        startMinute: at(15),
        status: AppointmentStatus.PENDING,
      },
      {
        key: 'absente',
        staffKey: 'mamy',
        serviceKey: 'taille-barbe',
        clientKey: 'faniry',
        dayOffset: -3,
        startMinute: at(11),
        status: AppointmentStatus.NO_SHOW,
      },
      {
        key: 'annule',
        staffKey: 'tojo',
        serviceKey: 'coupe-homme',
        clientKey: 'nirina',
        dayOffset: 3,
        startMinute: at(9, 30),
        status: AppointmentStatus.CANCELLED,
        cancelledBy: AppointmentCancelledBy.STAFF,
        cancellationReason: 'Fermeture exceptionnelle du salon.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

/**
 * Mot de passe des comptes de recette. Ce n'est pas un secret au sens de
 * CLAUDE.md : il n'ouvre que des comptes de démonstration, sur un environnement
 * où ce script accepte de s'exécuter — c'est-à-dire jamais la production.
 * `SEED_PASSWORD` permet de le changer sans toucher au code.
 */
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Recette-2026!';

/**
 * Même coût bcrypt que l'API (`BCRYPT_COST`, défaut 12) : un jeu de comptes
 * haché à un coût plus faible ne prouverait rien du temps de connexion réel,
 * qui est justement ce que la recette mesure.
 */
const BCRYPT_COST = Number.parseInt(process.env.BCRYPT_COST ?? '12', 10);

/** Récupère une valeur obligatoire d'une map, en nommant ce qui manque. */
function required<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Jeu de données incohérent : ${what} « ${key} » introuvable.`);
  }
  return value;
}

async function seedTenant(prisma: PrismaClient, fixture: TenantFixture): Promise<void> {
  const tenantId = seedId('tenant', fixture.slug);

  // --- L'établissement ------------------------------------------------------
  //
  // La racine de l'isolation, et la seule table du schéma sans `tenant_id` :
  // elle *est* le tenant.
  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: {
      id: tenantId,
      slug: fixture.slug,
      name: fixture.name,
      timezone: fixture.timezone,
      defaultCurrency: fixture.currency,
      contactEmail: `contact@${fixture.slug}.test`,
      contactPhone: fixture.slug === 'spa-lumiere' ? '+33472000000' : '+261200000000',
      addressLine1: fixture.address.line1,
      postalCode: fixture.address.postalCode,
      city: fixture.address.city,
      countryCode: fixture.address.countryCode,
      slotIntervalMinutes: fixture.slotIntervalMinutes,
      minBookingNoticeMinutes: fixture.minBookingNoticeMinutes,
      taxRateBps: fixture.taxRateBps,
      isActive: true,
    },
    update: {
      name: fixture.name,
      timezone: fixture.timezone,
      defaultCurrency: fixture.currency,
      addressLine1: fixture.address.line1,
      postalCode: fixture.address.postalCode,
      city: fixture.address.city,
      countryCode: fixture.address.countryCode,
      slotIntervalMinutes: fixture.slotIntervalMinutes,
      minBookingNoticeMinutes: fixture.minBookingNoticeMinutes,
      taxRateBps: fixture.taxRateBps,
      isActive: true,
    },
  });

  // --- Vitrine : horaires annoncés et jour de fermeture ---------------------
  //
  // Les horaires d'ouverture ne sont **pas** une règle de disponibilité : ils
  // disent ce que le salon affiche. Le moteur de créneaux, lui, part des
  // horaires du personnel.
  for (const window of WORKING_WINDOWS) {
    const id = seedId('opening-hour', fixture.slug, `${window.weekday}`, `${window.start}`);
    await prisma.tenantOpeningHour.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        weekday: window.weekday,
        startMinute: window.start,
        endMinute: window.end,
      },
      update: { startMinute: window.start, endMinute: window.end },
    });
  }

  // Dimanche fermé — un fait de l'établissement, pas de chaque praticien.
  await prisma.tenantClosingDay.upsert({
    where: { tenantId_weekday: { tenantId, weekday: 7 } },
    create: { id: seedId('closing-day', fixture.slug, '7'), tenantId, weekday: 7 },
    update: {},
  });

  // --- Comptes --------------------------------------------------------------
  //
  // L'unicité de l'e-mail est **par tenant** : les deux établissements peuvent
  // porter la même adresse sans que l'un puisse deviner l'existence de l'autre.
  // Les adresses sont en minuscules — la forme canonique que le module
  // `identity` impose avant écriture.
  const passwordHash = await hash(SEED_PASSWORD, BCRYPT_COST);

  const upsertUser = async (
    key: string,
    role: UserRole,
    firstName: string,
    lastName: string,
    extra: { phone?: string; internalNote?: string } = {},
  ): Promise<string> => {
    const id = seedId('user', fixture.slug, key);
    const email = `${key}@${fixture.slug}.test`;
    await prisma.user.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        email,
        role,
        // Posée à la création seulement : bcrypt tire un sel neuf à chaque
        // appel, et la réécrire ferait battre `updated_at` sur tous les comptes
        // à chaque exécution sans qu'aucun identifiant ne change.
        passwordHash,
        firstName,
        lastName,
        ...(extra.phone === undefined ? {} : { phone: extra.phone }),
        ...(extra.internalNote === undefined ? {} : { internalNote: extra.internalNote }),
        isActive: true,
      },
      update: {
        email,
        role,
        firstName,
        lastName,
        ...(extra.phone === undefined ? {} : { phone: extra.phone }),
        isActive: true,
      },
    });
    return id;
  };

  await upsertUser('admin', UserRole.ADMIN, 'Adèle', 'Admin');
  const managerId = await upsertUser('manager', UserRole.MANAGER, 'Marc', 'Manager');

  const clientIds = new Map<string, string>();
  for (const client of fixture.clients) {
    clientIds.set(
      client.key,
      await upsertUser(client.key, UserRole.CLIENT, client.firstName, client.lastName, {
        phone: client.phone,
        // Une note interne sur une seule fiche : elle ne doit apparaître dans
        // aucune projection publique, et la recette a besoin d'un cas à vérifier.
        ...(client.key === fixture.clients[0]?.key
          ? { internalNote: 'Cliente fidèle — préfère les créneaux du matin.' }
          : {}),
      }),
    );
  }

  // --- Personnel ------------------------------------------------------------
  //
  // Le compte porte l'identité et les droits ; la fiche praticien porte la
  // vitrine publique et l'affectation aux prestations. Un administrateur qui ne
  // prend pas de rendez-vous n'a pas de fiche.
  const staffIds = new Map<string, string>();
  for (const member of fixture.staff) {
    const userId = await upsertUser(member.key, UserRole.STAFF, member.firstName, member.lastName);
    const id = seedId('staff', fixture.slug, member.key);
    await prisma.staff.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        userId,
        displayName: member.displayName,
        bio: member.bio,
        isActive: true,
      },
      update: { displayName: member.displayName, bio: member.bio, isActive: true },
    });
    staffIds.set(member.key, id);

    // Horaires récurrents : des **minutes depuis minuit local**, jamais un
    // instant. « Ouvre à 09:00 » vaut 08:00Z en hiver et 07:00Z en été à Paris.
    for (const window of WORKING_WINDOWS) {
      const scheduleId = seedId('schedule', fixture.slug, member.key, `${window.weekday}`, `${window.start}`);
      await prisma.staffSchedule.upsert({
        where: { id: scheduleId },
        create: {
          id: scheduleId,
          tenantId,
          staffId: id,
          weekday: window.weekday,
          startMinute: window.start,
          endMinute: window.end,
        },
        update: { startMinute: window.start, endMinute: window.end },
      });
    }
  }

  // Une absence par établissement, sur le premier praticien : le moteur de
  // créneaux la soustrait des fenêtres de travail, et sans elle la recette ne
  // vérifierait jamais qu'il le fait. À partir de J+10 — assez loin pour ne
  // croiser aucun rendez-vous du jeu.
  //
  // Deux **jours ouvrés**, et non deux jours de calendrier : posée en jours
  // bruts, l'absence tombait tout entière sur le week-end quand le seed était
  // joué un mercredi — J+10 et J+11 y valent samedi et dimanche, qui ne portent
  // aucune plage de `WORKING_WINDOWS`. Il n'y avait alors rien à soustraire, et
  // la recette ne pouvait rien constater ; jouée un mardi ou un jeudi, elle ne
  // couvrait qu'un seul jour travaillé. La borne haute est le lendemain du
  // second jour ouvré : un congé posé un vendredi couvre vendredi, le week-end
  // et le lundi, ce qui est bien deux jours travaillés.
  const firstStaffKey = fixture.staff[0]?.key;
  if (firstStaffKey !== undefined) {
    const timeOffId = seedId('time-off', fixture.slug, firstStaffKey);
    const firstDayOffset = openDayOffset(10);
    const secondDayOffset = openDayOffset(firstDayOffset + 1);
    const startsAt = appointmentStart(firstDayOffset, at(0), fixture.timezone);
    // Borne haute **exclue**, comme un créneau : minuit local au lendemain du
    // second jour ouvré.
    const endsAt = appointmentStart(secondDayOffset + 1, at(0), fixture.timezone);
    await prisma.staffTimeOff.upsert({
      where: { id: timeOffId },
      create: {
        id: timeOffId,
        tenantId,
        staffId: required(staffIds, firstStaffKey, 'praticien'),
        startsAt,
        endsAt,
        reason: 'Formation',
      },
      update: { startsAt, endsAt },
    });
  }

  // --- Catalogue ------------------------------------------------------------
  const categoryIds = new Map<string, string>();
  for (const category of fixture.categories) {
    const id = seedId('category', fixture.slug, category.key);
    await prisma.serviceCategory.upsert({
      where: { id },
      create: { id, tenantId, slug: category.key, name: category.name, isActive: true },
      update: { name: category.name, isActive: true },
    });
    categoryIds.set(category.key, id);
  }

  const serviceIds = new Map<string, string>();
  for (const service of fixture.services) {
    const id = seedId('service', fixture.slug, service.key);
    const shape = {
      name: service.name,
      description: service.description,
      categoryId: required(categoryIds, service.categoryKey, 'catégorie'),
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      // Entier dans la plus petite unité, et code devise explicite. Jamais de
      // flottant sur un montant.
      priceAmountMinor: service.priceAmountMinor,
      priceCurrency: fixture.currency,
      isActive: true,
    };
    await prisma.service.upsert({
      where: { id },
      create: { id, tenantId, slug: service.key, ...shape },
      update: shape,
    });
    serviceIds.set(service.key, id);

    for (const staffKey of service.staffKeys) {
      const staffId = required(staffIds, staffKey, 'praticien');
      await prisma.serviceStaff.upsert({
        where: { tenantId_serviceId_staffId: { tenantId, serviceId: id, staffId } },
        create: {
          id: seedId('service-staff', fixture.slug, service.key, staffKey),
          tenantId,
          serviceId: id,
          staffId,
        },
        update: {},
      });
    }
  }

  // --- Article de vente au comptoir ----------------------------------------
  const productId = seedId('product', fixture.slug, fixture.product.sku);
  await prisma.product.upsert({
    where: { id: productId },
    create: {
      id: productId,
      tenantId,
      sku: fixture.product.sku,
      name: fixture.product.name,
      priceAmountMinor: fixture.product.priceAmountMinor,
      priceCurrency: fixture.currency,
      isActive: true,
    },
    update: {
      name: fixture.product.name,
      priceAmountMinor: fixture.product.priceAmountMinor,
      isActive: true,
    },
  });

  // --- Rendez-vous ----------------------------------------------------------
  //
  // Les cinq statuts du cycle de vie, pour que le reporting ait un taux
  // d'annulation et un taux de no-show à calculer, et que le rappel J-1 ait
  // quelque chose à balayer.
  //
  // Les instants sont recalculés à chaque exécution — le jeu glisse dans le
  // temps sans se dupliquer. La contrainte d'exclusion `appointments_no_overlap`
  // n'a rien à refuser : elle ne porte que sur les statuts `PENDING` et
  // `CONFIRMED`, et chaque praticien n'en porte qu'un seul. Le rabattement sur
  // les jours ouvrés peut faire tomber deux rendez-vous le même jour, jamais
  // deux rendez-vous occupants du même praticien.
  for (const fixtureAppointment of fixture.appointments) {
    const id = seedId('appointment', fixture.slug, fixtureAppointment.key);
    const service = fixture.services.find((candidate) => candidate.key === fixtureAppointment.serviceKey);
    if (service === undefined) {
      throw new Error(`Jeu de données incohérent : prestation « ${fixtureAppointment.serviceKey} » introuvable.`);
    }

    // Le décalage est ramené sur un jour ouvré : les praticiens ne travaillent
    // que du lundi au vendredi et le dimanche est fermé, si bien qu'un
    // `dayOffset` brut posait le rendez-vous hors de tout horaire selon le jour
    // où le seed est joué — le « demain » d'un vendredi tombait un samedi, et
    // c'est celui-là que le balayage du rappel J-1 doit trouver.
    const startsAt = appointmentStart(
      openDayOffset(fixtureAppointment.dayOffset),
      fixtureAppointment.startMinute,
      fixture.timezone,
    );
    // La durée **facturée**, sans les tampons : ceux-là occupent l'agenda du
    // praticien, ils n'allongent pas le rendez-vous que la cliente a pris.
    const endsAt = minutesLater(startsAt, service.durationMinutes);

    const cancelled = fixtureAppointment.status === AppointmentStatus.CANCELLED;
    const shape = {
      clientId: required(clientIds, fixtureAppointment.clientKey, 'client'),
      staffId: required(staffIds, fixtureAppointment.staffKey, 'praticien'),
      serviceId: required(serviceIds, fixtureAppointment.serviceKey, 'prestation'),
      startsAt,
      endsAt,
      status: fixtureAppointment.status,
      // Le prix est **figé** au moment de la prise : un changement de tarif ne
      // réécrit pas l'historique.
      priceAmountMinor: service.priceAmountMinor,
      priceCurrency: fixture.currency,
      clientNote: fixtureAppointment.clientNote ?? null,
      cancelledAt: cancelled ? minutesLater(startsAt, -24 * 60) : null,
      cancelledBy: cancelled ? (fixtureAppointment.cancelledBy ?? null) : null,
      cancellationReason: cancelled ? (fixtureAppointment.cancellationReason ?? null) : null,
    };

    await prisma.appointment.upsert({
      where: { id },
      create: { id, tenantId, ...shape },
      update: shape,
    });
  }

  // --- Encaissement du rendez-vous honoré -----------------------------------
  //
  // « Réserver → confirmer → honorer → **encaisser** → mesurer » : sans une
  // vente et son paiement, le reporting de base n'a aucun chiffre d'affaires à
  // rendre, et la recette du POS part d'une caisse vide.
  //
  // Aucune donnée de carte n'apparaît ici, et il n'y en aura jamais : seules
  // les références opaques du prestataire sont stockées (payments-stripe §1).
  const honouredKey = 'honore';
  const honoured = fixture.appointments.find((candidate) => candidate.key === honouredKey);
  if (honoured !== undefined) {
    const appointmentId = seedId('appointment', fixture.slug, honouredKey);
    const service = fixture.services.find((candidate) => candidate.key === honoured.serviceKey);
    if (service === undefined) {
      throw new Error(`Jeu de données incohérent : prestation « ${honoured.serviceKey} » introuvable.`);
    }

    // Le même décalage ramené sur un jour ouvré que dans la boucle ci-dessus :
    // l'encaissement se date de la fin du rendez-vous, pas d'un autre jour.
    const capturedAt = minutesLater(
      appointmentStart(openDayOffset(honoured.dayOffset), honoured.startMinute, fixture.timezone),
      service.durationMinutes,
    );

    const paymentId = seedId('payment', fixture.slug, honouredKey);
    const paymentShape = {
      appointmentId,
      amountMinor: service.priceAmountMinor,
      currency: fixture.currency,
      method: PaymentMethod.CARD,
      status: PaymentStatus.SUCCEEDED,
      // Références du prestataire, jamais un numéro de carte. Le préfixe
      // `seed_` les distingue d'une vraie référence Stripe au premier coup d'œil.
      providerPaymentIntentId: `pi_seed_${fixture.slug}_${honouredKey}`,
      providerChargeId: `ch_seed_${fixture.slug}_${honouredKey}`,
      capturedAt,
    };
    await prisma.payment.upsert({
      where: { id: paymentId },
      create: { id: paymentId, tenantId, ...paymentShape },
      update: paymentShape,
    });

    // Le ticket : la prestation, l'article vendu au comptoir, et la ligne de
    // taxe quand l'établissement en applique une. Le total **somme ses parts** —
    // une contrainte de base l'exige, et c'est ce qui fait du serveur la seule
    // autorité sur le montant.
    const subtotal = service.priceAmountMinor + fixture.product.priceAmountMinor;
    // Multiplication puis division **entières** : deux tickets identiques
    // produisent le même centime, aujourd'hui et au prochain rapprochement.
    const tax = Math.floor((subtotal * fixture.taxRateBps) / 10_000);
    const tip = 0;

    const saleId = seedId('sale', fixture.slug, honouredKey);
    const saleShape = {
      appointmentId,
      cashierUserId: managerId,
      subtotalAmountMinor: subtotal,
      taxAmountMinor: tax,
      tipAmountMinor: tip,
      totalAmountMinor: subtotal + tax + tip,
      currency: fixture.currency,
    };
    await prisma.sale.upsert({
      where: { id: saleId },
      create: { id: saleId, tenantId, ...saleShape },
      update: saleShape,
    });

    const lines: readonly {
      readonly position: number;
      readonly kind: SaleItemKind;
      readonly label: string;
      readonly quantity: number;
      readonly unitAmountMinor: number;
      readonly serviceId: string | null;
      readonly productId: string | null;
    }[] = [
      {
        position: 0,
        kind: SaleItemKind.SERVICE,
        label: service.name,
        quantity: 1,
        unitAmountMinor: service.priceAmountMinor,
        serviceId: required(serviceIds, service.key, 'prestation'),
        productId: null,
      },
      {
        position: 1,
        kind: SaleItemKind.PRODUCT,
        label: fixture.product.name,
        quantity: 1,
        unitAmountMinor: fixture.product.priceAmountMinor,
        serviceId: null,
        productId,
      },
      // Une ligne de taxe à zéro n'apprendrait rien et encombrerait le ticket
      // de l'établissement qui n'en applique pas.
      ...(tax > 0
        ? [
            {
              position: 2,
              kind: SaleItemKind.TAX,
              label: `TVA ${(fixture.taxRateBps / 100).toFixed(0)} %`,
              quantity: 1,
              unitAmountMinor: tax,
              serviceId: null,
              productId: null,
            },
          ]
        : []),
    ];

    for (const line of lines) {
      const lineId = seedId('sale-item', fixture.slug, honouredKey, `${line.position}`);
      const lineShape = {
        saleId,
        kind: line.kind,
        label: line.label,
        quantity: line.quantity,
        unitAmountMinor: line.unitAmountMinor,
        lineAmountMinor: line.unitAmountMinor * line.quantity,
        currency: fixture.currency,
        position: line.position,
        serviceId: line.serviceId,
        productId: line.productId,
      };
      await prisma.saleItem.upsert({
        where: { id: lineId },
        create: { id: lineId, tenantId, ...lineShape },
        update: lineShape,
      });
    }
  }

  log(
    `  ${fixture.slug} — ${fixture.staff.length} praticien(s), ${fixture.services.length} prestation(s), ` +
      `${fixture.clients.length} client(s), ${fixture.appointments.length} rendez-vous, fuseau ${fixture.timezone}`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new UnsafeSeedTargetError('DATABASE_URL est absente.');
  }

  const target = assertSafeTarget(databaseUrl);
  const prisma = new PrismaClient();

  log(`Jeu de données de recette — cible « ${target} », ${TENANTS.length} établissements.`);

  try {
    for (const fixture of TENANTS) {
      await seedTenant(prisma, fixture);
    }
  } finally {
    await prisma.$disconnect();
  }

  log('');
  log(`Comptes chargés — mot de passe « ${SEED_PASSWORD} » :`);
  for (const fixture of TENANTS) {
    for (const role of ['admin', 'manager', ...fixture.staff.map((member) => member.key), ...fixture.clients.map((client) => client.key)]) {
      log(`  ${role}@${fixture.slug}.test`);
    }
  }
  log('');
  log('Rejouable sans effet de bord : chaque ligne porte un identifiant déterministe.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
