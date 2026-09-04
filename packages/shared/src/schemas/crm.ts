/**
 * CRM — fiches clientes, notes internes, historique de visites (#56).
 *
 * Le CDC §2.3 confie au module `crm` les « profils clients, coordonnées, notes,
 * historique de visites ». Trois traits de ce contrat méritent d'être lus avant
 * d'écrire un écran :
 *
 * 1. **La fiche cliente n'est pas un compte.** C'est la même ligne en base — une
 *    cliente *est* un compte de rôle `client` —, mais ce que l'API en montre
 *    diffère : `identity` sert l'authentification et les droits, `crm` sert la
 *    relation commerciale. D'où deux schémas distincts plutôt qu'un `userSchema`
 *    étendu : le premier n'a rien à dire de `internalNote`, le second rien à dire
 *    d'un rôle.
 * 2. **La note interne ne sort jamais vers la cliente.** `customerSchema` la
 *    porte parce que ce schéma décrit une réponse de **back-office**, servie au
 *    rang `staff` ; `customerSummarySchema`, qui alimente les listes et les
 *    imbrications, ne la porte pas. Aucun schéma du parcours public ne la
 *    référence, et c'est une propriété qui se vérifie en lisant ce fichier.
 * 3. **Aucun schéma ne porte `tenantId`.** Il est résolu depuis la requête. Voir
 *    l'en-tête de `./tenant`.
 *
 * ## Ce que ce contrat ne dit pas
 *
 * Ni fusion de doublons, ni segmentation, ni export RGPD : le CDC §1.4 borne le
 * MVP à un « CRM client de base ». Chacun de ces trois besoins est une décision
 * de produit à part entière, donc une issue, pas un champ ajouté ici.
 */

import { z } from 'zod';

import {
  emailSchema,
  longTextSchema,
  nameSchema,
  phoneSchema,
  uuidSchema,
} from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import { paginatedSchema, paginationQuerySchema } from '../common/pagination';
import { utcInstantSchema } from '../common/time';
import { APPOINTMENT_STATUSES } from '../constants/appointment';

/**
 * Longueur minimale d'un terme de recherche.
 *
 * Une lettre unique ramènerait la quasi-totalité du fichier client à chaque
 * frappe, sans qu'aucun index ne puisse aider — et le back-office ferait alors
 * porter à PostgreSQL le coût d'un balayage complet par caractère saisi. Deux
 * caractères sont le seuil au-delà duquel un préfixe commence à discriminer.
 */
export const CUSTOMER_SEARCH_MIN_LENGTH = 2;

/**
 * Longueur maximale d'un terme de recherche — celle de la colonne la plus large
 * qu'il interroge (`users.email`, `VARCHAR(320)`), ramenée à la borne d'adresse
 * de la RFC 5321. Au-delà, la requête ne peut de toute façon rien trouver.
 */
export const CUSTOMER_SEARCH_MAX_LENGTH = 254;

/**
 * Nombre maximal de visites rendues par `GET /customers/:id/history`.
 *
 * L'historique est **agrégé** : le compteur, le total dépensé et la dernière
 * venue sont calculés sur la totalité des rendez-vous, la liste ne montre que
 * les plus récents. Sans borne, la fiche d'une cliente fidèle depuis dix ans
 * rendrait plusieurs centaines de lignes qu'aucun écran n'affiche.
 */
export const CUSTOMER_HISTORY_MAX_VISITS = 50;

/**
 * Fiche cliente réduite — la forme des listes et des imbrications.
 *
 * `internalNote` en est **absente**, et c'est le point : une liste de deux cents
 * fiches ferait transiter deux cents notes de deux mille caractères, dont aucun
 * tableau n'affiche une ligne. Ce qui n'est pas lu ne peut pas fuiter.
 *
 * `phone` est `.nullable()` et non `.optional()` : l'API émet toujours le champ,
 * à `null` quand il n'est pas renseigné. Même convention que `sessionUserSchema`
 * — un front qui distingue « absent » de « vide » finit par afficher
 * `undefined`.
 */
export const customerSummarySchema = z.object({
  id: uuidSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  email: emailSchema,
  phone: phoneSchema.nullable(),
  /**
   * Une fiche cliente ne se supprime pas — ses rendez-vous passés la
   * référencent, et le reporting doit continuer à les compter. `false` la retire
   * des écrans de saisie sans rien effacer.
   */
  isActive: z.boolean(),
});

export type CustomerSummary = z.infer<typeof customerSummarySchema>;

/**
 * Fiche cliente complète — ce que rend `GET /customers/:id`.
 *
 * `internalNote` est le « notes internes distinctes des informations visibles du
 * client » du CDC §2.3. La distinction n'est pas une convention de nommage :
 * aucun schéma servi au parcours public ne porte ce champ, et c'est la seule
 * façon d'en faire une propriété vérifiable plutôt qu'une promesse.
 */
export const customerSchema = customerSummarySchema.extend({
  internalNote: longTextSchema.nullable(),
  createdAt: utcInstantSchema,
});

export type Customer = z.infer<typeof customerSchema>;

/** Une page de fiches clientes — ce que rend `GET /customers`. */
export const customerPageSchema = paginatedSchema(customerSummarySchema);

export type CustomerPage = z.infer<typeof customerPageSchema>;

/**
 * Recherche et pagination du fichier client — `GET /customers`.
 *
 * `q` interroge **le nom, le téléphone et l'e-mail** d'un seul terme : le
 * front-desk tape ce qu'il a sous la main — un nom au téléphone, un numéro sur
 * un SMS, une adresse sur une confirmation — et n'a pas à choisir un champ avant
 * de chercher. Trois paramètres distincts auraient obligé l'écran à deviner la
 * nature de ce qui vient d'être tapé.
 *
 * `includeInactive` est `false` par défaut : une fiche désactivée n'a rien à
 * faire dans l'écran de prise de rendez-vous, qui est l'usage dominant. Le
 * back-office qui veut la retrouver le demande explicitement.
 */
export const customerSearchQuerySchema = paginationQuerySchema
  .extend({
    q: z
      .string()
      .trim()
      .min(CUSTOMER_SEARCH_MIN_LENGTH, {
        message: `la recherche demande au moins ${String(CUSTOMER_SEARCH_MIN_LENGTH)} caractères`,
      })
      .max(CUSTOMER_SEARCH_MAX_LENGTH)
      .optional(),
    // **Pas** `z.coerce.boolean()`, et c'est le piège à ne pas retomber dedans :
    // la coercition de Zod est `Boolean(value)`, qui rend `true` pour *toute*
    // chaîne non vide — `?includeInactive=false` ouvrirait donc la liste aux
    // fiches désactivées, exactement l'inverse de ce que la valeur demande.
    // Une query string ne transporte que des chaînes : seule `'true'` vaut vrai,
    // tout le reste vaut faux. C'est mot pour mot ce que fait le DTO de l'API
    // (`ListCustomersQueryDto.includeInactive`), et les deux doivent rester le
    // même prédicat — un `?includeInactive=oui` ne doit ouvrir la liste ni ici
    // ni là-bas.
    includeInactive: z
      .union([z.boolean(), z.string()])
      .default(false)
      .transform((value) => value === true || value === 'true'),
  })
  .strict();

export type CustomerSearchQuery = z.infer<typeof customerSearchQuerySchema>;

/**
 * Création d'une fiche cliente au comptoir — `POST /customers`.
 *
 * **Aucun mot de passe, aucun rôle.** La fiche naît sans empreinte : elle existe
 * pour être réservée et rappelée, pas pour se connecter.
 *
 * ## Une limite connue, et à ne pas se raconter autrement
 *
 * Une fiche saisie au comptoir **ne peut pas encore devenir un compte** :
 * `POST /auth/register` refuse en 409 toute adresse déjà prise dans
 * l'établissement, sans regarder si la ligne porte une empreinte, et le parcours
 * d'invitation est réservé au personnel. La cliente qui voudrait un accès sur
 * cette adresse-là est donc en impasse. Le correctif appartient à `identity` —
 * adopter la ligne sans empreinte à l'inscription plutôt que la refuser — et
 * c'est une décision de produit, pas une ligne de code d'ici. Une issue de suivi
 * la porte.
 *
 * `internalNote` est acceptée dès la création : le front-desk qui saisit une
 * fiche au téléphone a souvent la remarque à noter au même instant, et l'obliger
 * à enchaîner sur un `PATCH` perdrait la moitié des notes.
 */
export const createCustomerRequestSchema = z
  .object({
    email: emailSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.optional(),
    internalNote: longTextSchema.optional(),
  })
  .strict();

export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

/**
 * Modification d'une fiche cliente — `PATCH /customers/:id`.
 *
 * Ni `email`, ni `isActive`. Le premier est la clé de `@@unique([tenantId,
 * email])` et l'identifiant de connexion : le changer demande une vérification
 * de la nouvelle adresse que le périmètre MVP ne prévoit pas (même arbitrage
 * qu'`updateProfileRequestSchema`). Le second a sa propre route, parce que
 * désactiver une fiche n'est pas corriger une faute de frappe.
 *
 * `phone` et `internalNote` sont `.nullable()` : `null` est la valeur par
 * laquelle on **efface**, un champ absent laisse la valeur en place.
 */
export const updateCustomerRequestSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    phone: phoneSchema.nullable(),
    internalNote: longTextSchema.nullable(),
  })
  .strict()
  .partial();

export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

/**
 * Désactivation — ou réactivation — d'une fiche cliente,
 * `PATCH /customers/:id/status`.
 *
 * Un booléen et non deux routes : la réactivation est le même geste, et deux
 * points d'entrée auraient deux jeux de gardes à tenir en accord. Le champ est
 * **obligatoire** — un corps vide qui « bascule » l'état rendrait l'opération
 * non idempotente, donc dangereuse à rejouer.
 */
export const setCustomerStatusRequestSchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict();

export type SetCustomerStatusRequest = z.infer<typeof setCustomerStatusRequestSchema>;

/**
 * Une visite, telle que l'historique la rend.
 *
 * Volontairement plus pauvre qu'`appointmentSchema` : l'historique d'une fiche
 * répond à « qu'a-t-elle pris, quand, avec qui, pour combien », et n'a pas à
 * rejouer le contrat complet du rendez-vous. `clientNote` et `staffNote` en sont
 * absentes — la première appartient au rendez-vous, la seconde se lit sur sa
 * fiche.
 *
 * `staff` est `.nullable()` : un praticien peut avoir été retiré de
 * l'établissement, et une visite sans praticien nommé reste une visite à
 * compter.
 */
export const customerVisitSchema = z.object({
  appointmentId: uuidSchema,
  status: z.enum(APPOINTMENT_STATUSES),
  startsAt: utcInstantSchema,
  endsAt: utcInstantSchema,
  serviceName: z.string().min(1),
  staffName: z.string().min(1).nullable(),
  price: nonNegativeMoneySchema,
});

export type CustomerVisit = z.infer<typeof customerVisitSchema>;

/**
 * L'agrégat de l'historique — le « historique de visites agrégé » du critère.
 *
 * Il porte sur **tous** les rendez-vous de la fiche, pas seulement sur ceux que
 * `visits` montre : c'est la raison d'être d'un agrégat, et un compteur calculé
 * sur une page de cinquante lignes mentirait dès la cinquante et unième.
 *
 * `totalSpent` est un montant, donc un couple indissociable entier + devise.
 * Il additionne les prix figés des rendez-vous **honorés** : ni les annulations,
 * ni les absences, ni ce qui n'a pas encore eu lieu. Un chiffre d'affaires qui
 * compterait les rendez-vous à venir se démentirait à chaque annulation.
 *
 * `null` sur les deux dates et sur `totalSpent` quand la fiche n'a aucune visite
 * honorée : `0 EUR` laisserait croire à une cliente venue sans rien payer.
 */
export const customerVisitSummarySchema = z.object({
  totalVisits: z.number().int().min(0),
  honoredVisits: z.number().int().min(0),
  cancelledVisits: z.number().int().min(0),
  noShowVisits: z.number().int().min(0),
  upcomingVisits: z.number().int().min(0),
  firstVisitAt: utcInstantSchema.nullable(),
  lastVisitAt: utcInstantSchema.nullable(),
  totalSpent: nonNegativeMoneySchema.nullable(),
});

export type CustomerVisitSummary = z.infer<typeof customerVisitSummarySchema>;

/** Ce que rend `GET /customers/:id/history` — l'agrégat, puis les visites récentes. */
export const customerVisitHistorySchema = z.object({
  summary: customerVisitSummarySchema,
  visits: z.array(customerVisitSchema).max(CUSTOMER_HISTORY_MAX_VISITS),
});

export type CustomerVisitHistory = z.infer<typeof customerVisitHistorySchema>;

/**
 * Fenêtre de l'historique — `GET /customers/:id/history?limit=…`.
 *
 * Seule la **liste** est bornée ; l'agrégat ne l'est jamais. Le plafond est
 * appliqué côté serveur et n'est pas négociable, comme celui de la pagination.
 */
export const customerHistoryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CUSTOMER_HISTORY_MAX_VISITS)
      .default(CUSTOMER_HISTORY_MAX_VISITS),
  })
  .strict();

export type CustomerHistoryQuery = z.infer<typeof customerHistoryQuerySchema>;
