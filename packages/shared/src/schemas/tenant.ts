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

import {
  countryCodeSchema,
  displayNameSchema,
  emailSchema,
  phoneSchema,
  slugSchema,
  storedPhoneSchema,
  uuidSchema,
} from '../common/identifiers';
import { currencyCodeSchema } from '../common/money';
import { localTimeSchema, timeZoneSchema } from '../common/time';
import { localeSchema, submittedLocaleSchema } from '../locale/index';
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
import {
  LEGAL_ID_MAX_LENGTH,
  LEGAL_ID_TYPES,
  LEGAL_NAME_MAX_LENGTH,
  MAX_TAX_RATE_BPS,
  RECEIPT_FOOTER_MAX_LENGTH,
  RECEIPT_PREFIX_PATTERN,
  isValidLegalId,
  isValidVatNumber,
} from '../constants/receipt';
import { messageKey } from '../errors/zod-messages';
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
     * `countryCodeSchema` et non un motif recopié : depuis #824 ce même code
     * décide aussi du pays par défaut d'un numéro national
     * (`e164PhoneSchemaFor`), et deux écritures de « code pays » auraient fini
     * par en accepter deux formes — `libphonenumber-js` ne connaît que `FR`,
     * jamais `fr`.
     */
    country: countryCodeSchema,
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
      ...messageKey('tenant.closesAfterOpens'),
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
  .refine(
    (entries) => entries.length <= MAX_OPENING_HOURS_ENTRIES,
    messageKey('tenant.openingHoursTooMany', { max: MAX_OPENING_HOURS_ENTRIES }),
  )
  .refine((entries) => !openingHoursOverlap(entries), messageKey('tenant.openingHoursOverlap'));

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
  /**
   * La langue dans laquelle le salon s'annonce — #844.
   *
   * **Toujours présente**, comme `timezone` et `defaultCurrency` et pour la même
   * raison : la colonne est `NOT NULL` avec un défaut (`en`), il n'existe donc
   * aucun établissement qui n'en ait pas. La déclarer facultative aurait obligé
   * chaque écran du parcours public à réinventer le repli de son côté — c'est
   * l'arbitrage déjà rendu pour `receiptPrefix` et `taxRateBps`.
   *
   * Elle est sur la **vitrine**, non sur la seule vue back-office : c'est la
   * page publique qui en a le plus besoin, puisqu'elle s'affiche avant toute
   * authentification et qu'aucun compte ne peut alors dire sa préférence.
   */
  defaultLocale: localeSchema,
  contactEmail: emailSchema.optional(),
  contactPhone: storedPhoneSchema.optional(),
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

// ---------------------------------------------------------------------------
// Identité légale et fiscalité de l'établissement — #818, #913
// ---------------------------------------------------------------------------

/**
 * Les six colonnes d'identité légale et le taux de taxe vivent sur `tenants`, et
 * leurs schémas vivent donc **ici** — non dans `receipt.ts`, qui n'en est qu'un
 * lecteur.
 *
 * Le sens de la dépendance est ce qui compte : `receipt.ts` importe déjà
 * `postalAddressSchema` de ce fichier, et l'inverse aurait fermé un cycle
 * d'imports. Un cycle entre deux modules dont l'évaluation construit des schémas
 * n'échoue pas à la compilation mais au **démarrage**, sur une liaison encore
 * non initialisée — le pire moment pour l'apprendre. Les cinq schémas que #818
 * avait posés dans `receipt.ts` sont donc déplacés ici, et y restent réexportés
 * pour que rien de ce qui les importait ne change.
 */
export const legalIdTypeSchema = z.enum(LEGAL_ID_TYPES);

/** La raison sociale — `VARCHAR(160)`, jamais vide quand elle est posée. */
export const legalNameSchema = z.string().trim().min(1).max(LEGAL_NAME_MAX_LENGTH);

/** Un identifiant d'entreprise **borné**, sans jugement sur sa nature. */
export const legalIdSchema = z.string().trim().min(1).max(LEGAL_ID_MAX_LENGTH);

/** Les mentions de pied de ticket — `VARCHAR(500)`. */
export const receiptFooterSchema = z.string().trim().min(1).max(RECEIPT_FOOTER_MAX_LENGTH);

/** Le préfixe de numérotation, normalisé en majuscules dès la lecture. */
export const receiptPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((value) => RECEIPT_PREFIX_PATTERN.test(value), messageKey('tenant.receiptPrefix'));

/**
 * Le numéro de TVA **tel qu'on le saisit** — forme commune à l'Union, plus la
 * clé recalculée pour la France (`isValidVatNumber`).
 *
 * Plus strict que `legalIdSchema`, que `receiptIssuerSchema` emploie pour
 * **restituer** le même numéro. L'asymétrie est voulue et elle a un sens précis :
 * on refuse une saisie fautive à l'entrée, mais on continue de servir le reçu
 * d'un établissement dont la valeur a été posée avant que cette règle n'existe.
 * Durcir la sortie aurait rendu illisible la fiche d'un salon déjà en base —
 * c'est-à-dire cassé la lecture pour corriger l'écriture.
 */
export const vatNumberSchema = legalIdSchema
  .toUpperCase()
  .refine(isValidVatNumber, messageKey('tenant.vatNumber'));

/**
 * Le taux de taxe des ventes au comptoir, en **points de base** — `2000` vaut
 * 20 % (#60).
 *
 * Un entier, jamais un flottant : le projet n'accepte aucun nombre à virgule sur
 * le chemin de l'argent (CLAUDE.md), et le calcul de la ligne de taxe reste ainsi
 * une multiplication d'entiers suivie d'une division entière — exacte et
 * reproductible au centime près.
 */
export const taxRateBpsSchema = z.number().int().min(0).max(MAX_TAX_RATE_BPS);

/**
 * La nature et l'identifiant **tels qu'on les saisit**, casse normalisée.
 *
 * Le pendant contractuel du `TrimUpper` de `UpdateTenantDto` : un SIRET et une
 * nature se recopient d'un document officiel, et « siret » comme « hrb12345 »
 * désignent la même chose que leurs majuscules. `receiptPrefixSchema` et
 * `vatNumberSchema` normalisent déjà ; sans ces deux-ci, l'action serveur du
 * back-office — qui valide contre ce schéma **avant** d'appeler l'API — aurait
 * refusé une saisie que `PATCH /v1/tenant` accepte et corrige, en la déclarant
 * « identifiant invalide pour la nature ». Les deux frontières du contrat
 * doivent refuser les mêmes valeurs.
 *
 * Bornés avant la mise en majuscules, comme `legalIdSchema` : la largeur de la
 * colonne ne dépend pas de la casse.
 */
const submittedLegalIdTypeSchema = z.string().trim().toUpperCase().pipe(legalIdTypeSchema);

const submittedLegalIdSchema = legalIdSchema.toUpperCase();

/**
 * Vue back-office du même établissement : la vitrine, plus l'état d'activation
 * que seul le staff a besoin de connaître, plus l'identité légale et le taux de
 * taxe qui composent le ticket de caisse (#913).
 *
 * Composé par `.extend` et non réécrit — ajouter un champ à la vitrine le
 * propage ici, l'inverse n'est pas vrai. **Et c'est l'inverse qui compte ici** :
 * une raison sociale, un SIRET, un numéro de TVA et un taux de taxe n'ont rien à
 * faire sur la page publique d'un salon. Ils sont imprimés sur une pièce
 * comptable remise à la cliente qui a payé, pas publiés à qui connaît le slug.
 *
 * ## Facultatifs et **omis**, sauf les deux qui ne peuvent pas l'être
 *
 * Les cinq premiers suivent le régime de l'adresse (#343) : `.optional()`,
 * jamais `.nullable()`, l'API omet la clé plutôt que de rendre `null`. Un salon
 * qui n'a rien saisi se lit donc exactement comme avant #818.
 *
 * `receiptPrefix` et `taxRateBps` sont **toujours présents**, parce que leurs
 * colonnes sont `NOT NULL` avec un défaut (`TIC`, `0`) : il n'existe aucun
 * établissement qui n'en ait pas, et les déclarer facultatifs aurait obligé
 * chaque écran à inventer le défaut de son côté.
 */
export const tenantSchema = publicTenantSchema.extend({
  isActive: z.boolean(),
  /** La raison sociale, quand elle diffère de l'enseigne. */
  legalName: legalNameSchema.optional(),
  legalIdType: legalIdTypeSchema.optional(),
  legalId: legalIdSchema.optional(),
  vatNumber: legalIdSchema.optional(),
  receiptFooter: receiptFooterSchema.optional(),
  receiptPrefix: receiptPrefixSchema,
  taxRateBps: taxRateBpsSchema,
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
    /**
     * La langue par défaut du salon — #844, réservée au rôle `ADMIN` comme tout
     * le reste de cette charge utile.
     *
     * **Pas `.nullable()`**, à la différence des contacts : la colonne est
     * `NOT NULL`, et « efface la langue » ne veut rien dire — une vitrine doit
     * toujours savoir en quelle langue s'ouvrir. Pour revenir au défaut du
     * système, on repose `en`.
     *
     * `submittedLocaleSchema` et non `localeSchema` : une étiquette de langue se
     * recopie d'un en-tête ou d'un sélecteur de navigateur, où la casse n'est pas
     * normalisée, et `« FR »` désigne la même langue que `« fr »`. Même
     * arbitrage que le code pays d'une adresse et que `submittedLegalIdTypeSchema`.
     * Une valeur hors vocabulaire, elle, est refusée — 400, code
     * `VALIDATION_ERROR`, champ nommé.
     */
    defaultLocale: submittedLocaleSchema,
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
    /**
     * L'identité légale et la fiscalité (#913), au régime des contacts :
     * **absent** ne touche à rien, `null` efface.
     *
     * `receiptPrefix` et `taxRateBps` font exception et ne sont pas
     * `.nullable()` : leurs colonnes sont `NOT NULL`, et « efface le préfixe »
     * ne veut rien dire — un numéro de pièce doit rester décomposable. Pour
     * revenir au défaut, on repose `TIC`.
     */
    legalName: legalNameSchema.nullable(),
    legalIdType: submittedLegalIdTypeSchema.nullable(),
    legalId: submittedLegalIdSchema.nullable(),
    vatNumber: vatNumberSchema.nullable(),
    receiptFooter: receiptFooterSchema.nullable(),
    receiptPrefix: receiptPrefixSchema,
    taxRateBps: taxRateBpsSchema,
  })
  .strict()
  .partial()
  .superRefine((changes, ctx) => {
    // La nature et l'identifiant vont **par paire** — c'est ce que la contrainte
    // `tenants_legal_id_completeness_check` tient en base, et ce qu'un
    // identifiant sans sa nature rendrait invérifiable.
    //
    // Le contrôle ne porte que sur ce que la charge utile pose : un `PATCH` qui
    // ne change que l'identifiant s'appuie sur la nature **déjà enregistrée**, et
    // ce schéma ne la connaît pas. C'est l'API, qui a lu l'établissement, qui
    // juge la paire résultante — ici on refuse seulement ce qui se voit d'un
    // bloc, pour que le formulaire n'ait pas à faire l'aller-retour.
    if (changes.legalIdType === undefined || changes.legalId === undefined) {
      return;
    }

    if ((changes.legalIdType === null) !== (changes.legalId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [changes.legalId === null ? 'legalId' : 'legalIdType'],
        ...messageKey('tenant.legalIdPair'),
      });
      return;
    }

    if (
      changes.legalIdType !== null &&
      changes.legalId !== null &&
      !isValidLegalId(changes.legalIdType, changes.legalId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['legalId'],
        ...messageKey('tenant.legalIdInvalid', { type: changes.legalIdType }),
      });
    }
  });

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
      .int()
      .min(MIN_SLOT_INTERVAL_MINUTES)
      .max(MAX_SLOT_INTERVAL_MINUTES),
    /** Délai minimum avant le début d'un créneau proposable, en minutes. */
    minBookingNoticeMinutes: z
      .number()
      .int()
      .min(MIN_BOOKING_NOTICE_MINUTES_FLOOR)
      .max(MAX_MIN_BOOKING_NOTICE_MINUTES),
  })
  .strict();

export type TenantBookingSettings = z.infer<typeof tenantBookingSettingsSchema>;
