/**
 * Établissement — la racine de l'isolation.
 *
 * Le seul objet du contrat dont l'identifiant de tenant est exposé, pour une
 * raison simple : il *est* le tenant. Partout ailleurs, `tenantId` est absent
 * des schémas — il est résolu côté serveur depuis la requête et ne doit ni
 * entrer (un client qui le pose choisit son établissement) ni sortir (le
 * renvoyer confirme l'existence d'une frontière qu'on n'a pas à documenter au
 * cas par cas).
 */

import { z } from 'zod';

import { displayNameSchema, emailSchema, phoneSchema, slugSchema, uuidSchema } from '../common/identifiers';
import { currencyCodeSchema } from '../common/money';
import { localTimeSchema, timeZoneSchema } from '../common/time';
import {
  ADDRESS_LINE_MAX_LENGTH,
  CITY_MAX_LENGTH,
  MAX_MIN_BOOKING_NOTICE_MINUTES,
  MAX_OPENING_HOURS_ENTRIES,
  MAX_SLOT_INTERVAL_MINUTES,
  MIN_BOOKING_NOTICE_MINUTES_FLOOR,
  MIN_SLOT_INTERVAL_MINUTES,
  POSTAL_CODE_MAX_LENGTH,
} from '../constants/limits';
import { isoWeekdaySchema, scheduleEndTimeSchema, wallMinutesOrNull } from './availability';

/**
 * Adresse postale d'un établissement — CDC §1.4, « page vitrine du salon ».
 *
 * ## Un objet, et non cinq champs à plat
 *
 * L'adresse voyage d'un bloc parce qu'elle se lit d'un bloc : la page publique
 * l'affiche en un paragraphe, le JSON-LD la rend en `PostalAddress`, et le
 * formulaire de réglages la saisit ou l'efface en entier. À plat, chacun de ces
 * trois consommateurs aurait eu à recomposer le même objet, et à décider seul de
 * ce qu'est une adresse « suffisante ».
 *
 * ## Le triplet minimal
 *
 * `line1`, `city` et `country` sont **requis dans l'objet**, alors que l'objet
 * lui-même est facultatif partout où il apparaît. C'est la distinction qui
 * compte : un salon a le droit de ne pas publier d'adresse — la vitrine se sert
 * sans —, mais une adresse sans ville n'oriente personne et produirait un
 * `PostalAddress` que les moteurs jugeraient incomplet. Publier faux coûte plus
 * cher que ne pas publier (#343).
 *
 * `postalCode` reste facultatif : tous les pays n'en ont pas, et l'exiger
 * refuserait des adresses réelles. `line2` l'est aussi — c'est un complément.
 */
export const postalAddressSchema = z
  .object({
    /** Numéro et voie — « 12 rue des Lilas ». */
    line1: z.string().trim().min(1).max(ADDRESS_LINE_MAX_LENGTH),
    /** Complément — bâtiment, étage, boîte. */
    line2: z.string().trim().min(1).max(ADDRESS_LINE_MAX_LENGTH).optional(),
    postalCode: z.string().trim().min(1).max(POSTAL_CODE_MAX_LENGTH).optional(),
    city: z.string().trim().min(1).max(CITY_MAX_LENGTH),
    /**
     * Pays en ISO 3166-1 alpha-2, majuscules — « FR », « MG », « BE ».
     *
     * Un code et non un nom : « France », « france » et « FRANCE » sont trois
     * chaînes pour un seul pays, et `schema.org/addressCountry` accepte
     * explicitement le code à deux lettres. La casse est normalisée à la
     * lecture, comme celle d'un slug, pour que la même adresse saisie deux fois
     * produise la même valeur.
     */
    country: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, { message: 'code pays ISO 3166-1 alpha-2 attendu (« FR »)' }),
  })
  .strict();

export type PostalAddress = z.infer<typeof postalAddressSchema>;

/**
 * Une plage d'ouverture hebdomadaire de l'**établissement** — « le mardi, de
 * 09:00 à 12:00 ».
 *
 * ## Ce que ce n'est pas
 *
 * Ni un horaire de praticien (`staffScheduleEntrySchema`), ni une contrainte de
 * disponibilité. Le moteur de créneaux ne lit pas ces plages : il part des
 * horaires du personnel et des jours de fermeture. Celles-ci décrivent ce que le
 * salon **annonce** à ses clientes, et c'est tout ce qu'elles décrivent — les
 * confondre ferait d'un affichage de vitrine une règle d'agenda.
 *
 * La forme, elle, est délibérément la même : jour ISO 8601 (1 lundi … 7
 * dimanche, jamais le `0`-dimanche *falsy* de `Date.getDay`), heures **murales**
 * dans le fuseau de l'établissement, borne haute **exclue** avec `24:00` pour
 * minuit. Deux formes différentes pour deux tables de plages horaires auraient
 * obligé chaque écran à savoir laquelle il tient.
 */
export const openingHoursEntrySchema = z
  .object({
    weekday: isoWeekdaySchema,
    opensAt: localTimeSchema,
    closesAt: scheduleEndTimeSchema,
  })
  .strict()
  .refine(
    (entry) => {
      const opens = wallMinutesOrNull(entry.opensAt);
      const closes = wallMinutesOrNull(entry.closesAt);

      return opens !== null && closes !== null && closes > opens;
    },
    {
      message: 'la fermeture doit être strictement postérieure à l’ouverture',
      path: ['closesAt'],
    },
  );

export type OpeningHoursEntry = z.infer<typeof openingHoursEntrySchema>;

/**
 * `true` si deux plages du **même jour** se recouvrent, borne haute exclue.
 *
 * Jumelle de `staffScheduleEntriesOverlap`, sur la forme voisine : « 09:00–12:00
 * et 14:00–19:00 » est une journée avec coupure, « 09:00–13:00 et 12:00–19:00 »
 * est une saisie fautive que la vitrine afficherait telle quelle.
 *
 * Une plage dont les bornes ne se lisent pas est **ignorée** plutôt que refusée
 * ici : sa propre validation l'a déjà rejetée, et lever depuis un `refine`
 * transformerait le 400 attendu en 500.
 */
export function openingHoursOverlap(entries: readonly OpeningHoursEntry[]): boolean {
  const byWeekday = new Map<number, { start: number; end: number }[]>();

  for (const entry of entries) {
    const start = wallMinutesOrNull(entry.opensAt);
    const end = wallMinutesOrNull(entry.closesAt);

    if (start === null || end === null) {
      continue;
    }

    const sameDay = byWeekday.get(entry.weekday) ?? [];

    // Adjacence tolérée (`end === start`) : une journée continue décrite en deux
    // morceaux, pas un double emploi.
    if (sameDay.some((other) => start < other.end && other.start < end)) {
      return true;
    }

    sameDay.push({ start, end });
    byWeekday.set(entry.weekday, sameDay);
  }

  return false;
}

/** La semaine d'ouverture telle qu'elle entre et telle qu'elle sort. */
export const openingHoursSchema = z
  .array(openingHoursEntrySchema)
  .max(MAX_OPENING_HOURS_ENTRIES, {
    message: `au plus ${String(MAX_OPENING_HOURS_ENTRIES)} plages d’ouverture par semaine`,
  })
  .refine((entries) => !openingHoursOverlap(entries), {
    message: 'deux plages d’ouverture du même jour se recouvrent',
  });

/**
 * Vitrine publique d'un établissement, servie **avant toute authentification**
 * à la page de réservation.
 *
 * `timezone` en fait partie et n'est pas optionnel : le front reçoit des
 * instants UTC et n'a aucun autre moyen de les afficher dans le calendrier du
 * salon. Sans lui, il retomberait sur le fuseau du navigateur — et une cliente
 * en déplacement verrait son rendez-vous décalé.
 *
 * Ce qui n'y figure pas est aussi un choix : ni `isActive`, ni les compteurs,
 * ni quoi que ce soit qui n'aide pas à réserver.
 *
 * ## Adresse et horaires : facultatifs, et **omis** quand ils manquent (#343)
 *
 * Ils complètent le contact pour la section « informations pratiques » et pour
 * le graphe schema.org de la page vitrine. Ils suivent exactement le régime des
 * deux contacts : `.optional()`, jamais `.nullable()`, et l'API omet la clé
 * plutôt que de rendre `null`.
 *
 * La conséquence est celle qui compte : **un établissement sans adresse ni
 * horaires reste servi**, et sa vitrine a rigoureusement la même forme qu'avant
 * l'existence de ces champs. La page publique se sert donc d'un salon fraîchement
 * inscrit exactement comme d'un salon complet.
 *
 * Un tableau d'horaires **vide** est omis lui aussi. Rendre `[]` aurait été un
 * troisième état — « publié, mais vide » — qu'aucun écran n'aurait su distinguer
 * de « pas encore renseigné », et qui aurait affiché une section d'horaires
 * blanche là où il n'y a rien à dire.
 */
export const publicTenantSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: displayNameSchema,
  timezone: timeZoneSchema,
  defaultCurrency: currencyCodeSchema,
  contactEmail: emailSchema.optional(),
  contactPhone: phoneSchema.optional(),
  address: postalAddressSchema.optional(),
  /**
   * Plages d'ouverture de la semaine, dans le fuseau de l'établissement.
   *
   * Non trié par contrat : c'est l'API qui rend l'ordre stable (jour ISO
   * croissant, puis heure d'ouverture), et un écran qui en dépendrait sans le
   * dire serait fragile. Voir `sortOpeningHours`.
   */
  openingHours: openingHoursSchema.optional(),
});

/**
 * Ordonne les plages d'ouverture : jour ISO croissant, puis heure d'ouverture.
 *
 * Écrit ici, dans le contrat, plutôt que dans chaque consommateur : l'API doit
 * rendre cet ordre, la page publique doit l'afficher, et le formulaire de
 * réglages doit le présenter. Trois implémentations de « du lundi au dimanche »
 * auraient fini par diverger sur la seule question intéressante — un salon
 * ouvert deux fois le même jour.
 *
 * Ne modifie pas le tableau reçu : un tri en place sur une réponse d'API
 * réordonnerait la valeur que l'appelant garde par ailleurs.
 */
export function sortOpeningHours(
  entries: readonly OpeningHoursEntry[],
): readonly OpeningHoursEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.weekday - right.weekday ||
      (wallMinutesOrNull(left.opensAt) ?? 0) - (wallMinutesOrNull(right.opensAt) ?? 0),
  );
}

export type PublicTenant = z.infer<typeof publicTenantSchema>;

/**
 * Vue back-office du même établissement : la vitrine, plus l'état
 * d'activation que seul le staff a besoin de connaître.
 *
 * Composé par `.extend` et non réécrit — ajouter un champ à la vitrine le
 * propage ici, l'inverse n'est pas vrai.
 */
export const tenantSchema = publicTenantSchema.extend({
  isActive: z.boolean(),
});

export type Tenant = z.infer<typeof tenantSchema>;

/**
 * Réglages modifiables d'un établissement depuis le back-office.
 *
 * `.partial()` sur un objet `.strict()` : **absent** vaut « ne touche pas »,
 * `null` vaut « efface ». La distinction est celle d'`updateProfileRequestSchema`
 * et elle est load-bearing — un formulaire qui renverrait `null` sur les champs
 * qu'il n'affiche pas effacerait les coordonnées du salon sans que personne
 * l'ait demandé.
 *
 * `slug` n'y figure pas : c'est l'adresse publique du salon, changer la clé
 * d'URL casserait les liens et le référencement acquis. `isActive` non plus —
 * fermer un établissement n'est pas un réglage d'écran.
 */
export const updateTenantRequestSchema = z
  .object({
    name: displayNameSchema,
    timezone: timeZoneSchema,
    defaultCurrency: currencyCodeSchema,
    contactEmail: emailSchema.nullable(),
    contactPhone: phoneSchema.nullable(),
    /**
     * L'adresse se pose ou s'efface **en entier** (#343).
     *
     * `null` retire les cinq colonnes d'un coup. Il n'y a pas de mise à jour
     * partielle d'adresse, et c'est voulu : « change la ville sans changer la
     * rue » n'est pas une opération dont un formulaire d'adresse a besoin, et
     * l'autoriser rendrait représentable une adresse à moitié réécrite —
     * l'ancienne rue avec la nouvelle ville.
     */
    address: postalAddressSchema.nullable(),
    /**
     * Remplacement **intégral** de la semaine d'ouverture.
     *
     * Même arbitrage que `setStaffScheduleRequestSchema` : la seule invariante
     * qui compte — aucune plage ne se recouvre — porte sur l'ensemble, et la
     * vérifier plage par plage ferait dépendre le résultat de l'ordre des
     * appels. Un tableau vide efface les horaires publiés.
     */
    openingHours: openingHoursSchema,
  })
  .strict()
  .partial();

export type UpdateTenantRequest = z.infer<typeof updateTenantRequestSchema>;

/**
 * Les deux réglages qui gouvernent le calcul des créneaux libres (#34).
 *
 * Ils vivent sur l'établissement et non sur la prestation : un salon annonce une
 * grille, il n'en annonce pas une par soin. Les poser par prestation produirait
 * des grilles concurrentes sur un même agenda — deux soins aux pas différents
 * proposant des créneaux qui se chevauchent à moitié.
 *
 * ## Ce qu'ils ne disent pas
 *
 * Ni les tampons de préparation et de remise en état — ils appartiennent à la
 * prestation (`services.buffer_before_minutes` / `buffer_after_minutes`), parce
 * qu'un massage aux pierres chaudes n'a pas le même temps de cabine qu'une
 * coupe —, ni la fenêtre maximale interrogeable, qui est une borne de coût du
 * serveur (`MAX_AVAILABILITY_RANGE_DAYS`) et non un choix du salon.
 *
 * Ce schéma décrit une forme, il n'ouvre pas d'endpoint : #34 pose les colonnes
 * et l'algorithme qui les lit, #35 sert la disponibilité, et l'écran de réglages
 * du back-office les rendra modifiables. Même précédent que
 * `staffBusyIntervalSchema`, déclaré par #33 pour le moteur qui le consomme.
 */
export const tenantBookingSettingsSchema = z
  .object({
    /** Pas de découpage des créneaux proposés, en minutes. */
    slotIntervalMinutes: z
      .number()
      .int({ message: 'un pas de créneau s’exprime en minutes entières' })
      .min(MIN_SLOT_INTERVAL_MINUTES, {
        message: `pas de créneau attendu entre ${String(MIN_SLOT_INTERVAL_MINUTES)} et ${String(MAX_SLOT_INTERVAL_MINUTES)} minutes`,
      })
      .max(MAX_SLOT_INTERVAL_MINUTES, {
        message: `pas de créneau attendu entre ${String(MIN_SLOT_INTERVAL_MINUTES)} et ${String(MAX_SLOT_INTERVAL_MINUTES)} minutes`,
      }),
    /** Délai minimum avant le début d'un créneau proposable, en minutes. */
    minBookingNoticeMinutes: z
      .number()
      .int({ message: 'un délai de réservation s’exprime en minutes entières' })
      .min(MIN_BOOKING_NOTICE_MINUTES_FLOOR, {
        message: `délai minimum attendu entre ${String(MIN_BOOKING_NOTICE_MINUTES_FLOOR)} et ${String(MAX_MIN_BOOKING_NOTICE_MINUTES)} minutes`,
      })
      .max(MAX_MIN_BOOKING_NOTICE_MINUTES, {
        message: `délai minimum attendu entre ${String(MIN_BOOKING_NOTICE_MINUTES_FLOOR)} et ${String(MAX_MIN_BOOKING_NOTICE_MINUTES)} minutes`,
      }),
  })
  .strict();

export type TenantBookingSettings = z.infer<typeof tenantBookingSettingsSchema>;
