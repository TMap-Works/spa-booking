/**
 * Les réponses de paiement que le back-office lit, rejouées contre un schéma —
 * l'encaissement d'un rendez-vous (#59), puis la caisse du comptoir (#61).
 *
 * ## Les deux écarts de contrat, et comment ils se sont refermés
 *
 * Le contrat partagé publiait bien `paymentIntentSchema` et `paymentSchema`,
 * mais ni l'un ni l'autre ne décrivait ce que l'API **sert** — d'où deux
 * enveloppes redéclarées ici :
 *
 * | Contrat partagé, avant | Ce que l'API rend | Écart |
 * |---|---|---|
 * | `paymentIntentSchema` — `.strict()`, trois champs | `PaymentIntentDto` — six champs, dont `publishableKey` | le `.strict()` rejetait la réponse entière |
 * | `paymentSchema` — `capturedAt` optionnel | `PaymentTransactionDto` — `capturedAt: null` | « absent » et « nul » ne sont pas la même chose pour Zod |
 *
 * #554 les a tranchés **dans le sens du serveur** : c'est le contrat qui a suivi
 * la réponse, parce que l'inverse — retirer `publishableKey` et `status` de
 * l'API — aurait cassé le tunnel de paiement. `paymentIntentSchema` porte
 * désormais les six clés et `paymentSchema` ses deux `nullable`, si bien que les
 * deux schémas ci-dessous ne redéclarent plus l'enveloppe : ils **étendent celle
 * du contrat**, et n'y ajoutent que la normalisation de casse de la frontière.
 *
 * Ce qui restait à trancher l'a donc été des deux bords à la fois, comme
 * `apps/api/src/modules/payments/payments.types.ts` le demandait : refermer un
 * seul des deux aurait recréé la divergence.
 *
 * ## La frontière PCI, dans la forme même de ces schémas
 *
 * Aucun champ ci-dessous ne peut porter une donnée de carte : ni PAN, ni
 * cryptogramme, ni date d'expiration, ni nom de porteur — et pas davantage une
 * marque ou quatre derniers chiffres. Un objet Zod **retire** les clés qu'il ne
 * déclare pas : si l'API se mettait un jour à en émettre une, elle n'atteindrait
 * ni un composant, ni un journal du front (payments-stripe §1). C'est la même
 * propriété de forme que celle des DTO d'entrée côté serveur, appliquée au sens
 * de la lecture.
 *
 * Les deux références de prestataire (`providerPaymentIntentId`,
 * `providerChargeId`) sont, elles, volontairement **non déclarées** : elles
 * servent le rapprochement, qui est l'écran du journal des transactions, au
 * seuil `MANAGER`. Le comptoir encaisse ; il n'a pas à porter la référence
 * Stripe d'une vente sur son écran ni sur son ticket.
 */

import {
  nonNegativeMoneySchema,
  paymentIntentSchema,
  paymentMethodSchema,
  paymentSchema,
  paymentStatusSchema,
  utcInstantSchema,
  uuidSchema,
} from '@spa/shared';
import { z } from 'zod';

/**
 * Moyen de paiement **tel qu'il arrive du fil** — l'API émet `CASH`, le contrat
 * nomme `cash`.
 *
 * Même normalisation, et pour la même raison, que
 * `receivedAppointmentStatusSchema` du contrat partagé : la conversion se fait
 * une fois, à la frontière, et au-delà aucun composant n'a à se demander dans
 * quelle casse il compare un moyen de paiement.
 */
export const receivedPaymentMethodSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(paymentMethodSchema);

/** Statut d'encaissement reçu du fil (`SUCCEEDED`), même normalisation. */
export const receivedPaymentStatusSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(paymentStatusSchema);

/**
 * L'intention de paiement d'un rendez-vous — de quoi monter Stripe Elements.
 *
 * Les deux valeurs sensibles en apparence ne le sont pas :
 *
 * - `clientSecret` est un laissez-passer à usage unique qui n'autorise que la
 *   confirmation de **cette** intention. Il n'ouvre aucune autre ressource, et
 *   il n'est pas conservé — une reprise le redemande à sa source ;
 * - `publishableKey` est publiable par définition (payments-stripe §7). La clé
 *   **secrète** ne quitte jamais le serveur d'API.
 *
 * C'est ce qui permet à ces deux champs de traverser la frontière serveur vers
 * le navigateur, là où un jeton de session ne le pourrait pas.
 *
 * Les six clés viennent maintenant de `paymentIntentSchema` : seul le statut est
 * réécrit, parce que l'API l'émet en majuscules et que la conversion appartient
 * à la frontière.
 *
 * ## Pourquoi le `.strip()` explicite, contre le `.strict()` du contrat
 *
 * Le schéma partagé est `.strict()`, et c'est juste **en entrée** : un
 * `cardNumber` glissé dans un corps de requête doit sortir en refus nommé plutôt
 * que d'être ignoré. En **lecture**, la même rigueur se retournerait contre ce
 * qu'elle protège : si l'API se mettait un jour à émettre un champ de carte, un
 * schéma strict ferait échouer la réponse entière et fermerait le tunnel de
 * paiement, là où un `.strip()` le retire et laisse le parcours vivre. La donnée
 * n'atteint ni composant ni journal dans les deux cas (payments-stripe §1) ;
 * seule diffère la manière dont le front survit à l'incident.
 */
export const appointmentPaymentIntentSchema = paymentIntentSchema
  .extend({
    amount: nonNegativeMoneySchema,
    status: receivedPaymentStatusSchema,
  })
  .strip();

export type AppointmentPaymentIntent = z.infer<typeof appointmentPaymentIntentSchema>;

/**
 * Un encaissement inscrit, tel que le comptoir le relit après un règlement en
 * espèces.
 *
 * `capturedAt` est `nullable` et non `optional` : l'API émet explicitement
 * `null` tant que l'argent n'a pas été pris. Sur un règlement en espèces il est
 * toujours renseigné — la caisse fait foi, l'encaissement naît abouti — mais le
 * schéma décrit la route, pas le seul cas qu'on en attend. C'est cette
 * distinction que #554 a portée dans `paymentSchema`, d'où l'extension plutôt
 * que la redéclaration.
 *
 * Les deux références de prestataire que l'API sert en plus
 * (`providerPaymentIntentId`, `providerChargeId`) n'ont pas besoin d'être
 * exclues : un objet Zod non `.strict()` **retire** les clés qu'il ne déclare
 * pas, et le comptoir ne les verra donc jamais.
 */
export const paymentTransactionSchema = paymentSchema.extend({
  method: receivedPaymentMethodSchema,
  status: receivedPaymentStatusSchema,
});

export type PaymentTransaction = z.infer<typeof paymentTransactionSchema>;

// ---------------------------------------------------------------------------
// La caisse du comptoir — le rayon et le ticket (#61)
// ---------------------------------------------------------------------------

/**
 * Les quatre natures de ligne qu'un ticket peut porter, **dans la casse où
 * l'API les émet et les attend**.
 *
 * C'est la seule énumération de ce module qui n'est pas ramenée en minuscules,
 * et l'écart est délibéré. Les deux autres — moyen et statut de paiement — sont
 * normalisées parce que `@spa/shared` les nomme en minuscules : la conversion
 * réconcilie deux vocabulaires qui existent déjà. Ici il n'y en a qu'un. Le
 * `kind` **relu** d'une ligne de ticket est aussi le `kind` **envoyé** dans une
 * ligne de `POST /sales` (`SaleLineDto.kind`, `IsIn(['SERVICE','PRODUCT','TIP'])`) :
 * le normaliser à la lecture obligerait à le remajusculer à l'écriture, et un
 * aller-retour qui traverse deux formes de la même valeur est exactement
 * l'endroit où l'une des deux finit par être oubliée.
 *
 * `TAX` et `TIP` sont ici, alors qu'ils ne sont pas des colonnes du ticket : le
 * serveur les compose en **lignes**, et le reçu les imprime comme telles
 * (payments-stripe §5 — « taxes et pourboires sont des lignes distinctes, jamais
 * fondues dans le prix »).
 */
export const SALE_ITEM_KINDS = ['SERVICE', 'PRODUCT', 'TAX', 'TIP'] as const;

export const saleItemKindSchema = z.enum(SALE_ITEM_KINDS);

export type SaleItemKind = z.infer<typeof saleItemKindSchema>;

/**
 * Un article du rayon retail, tel que `GET /products` le rend.
 *
 * L'API sépare le montant de sa devise en deux champs plats
 * (`priceAmountMinor`, `currency`) ; la frontière les recompose en un `Money`.
 * Ce n'est pas de la cosmétique : un montant sans sa devise n'est pas un
 * montant, et deux champs indépendants sont deux champs qu'un composant peut
 * lire séparément — c'est comme cela qu'un prix finit par s'afficher sans
 * devise, ou pire, avec celle du salon d'à côté. Recomposés ici, ils ne se
 * séparent plus.
 *
 * `isActive` est rendu bien que `GET /products` ne serve par défaut que le rayon
 * vendable : un ticket ouvert avant qu'un article ne soit retiré doit pouvoir
 * expliquer pourquoi le serveur le refuse maintenant.
 *
 * ## Pourquoi un `.pipe()` et non un `.parse()` dans le `transform`
 *
 * Le prix est jugé par l'**étage suivant** du schéma, jamais par un
 * `nonNegativeMoneySchema.parse()` appelé à l'intérieur de la transformation.
 * Un `parse` imbriqué **lève** : `productSchema.safeParse(…)` sur un prix
 * négatif jetterait une `ZodError` au lieu de rendre `{ success: false }`, et
 * une exception qui traverse un `safeParse` traverse aussi la frontière du
 * client d'API, qui n'attend là qu'un échec de forme à nommer. Découpé en deux
 * étages, le refus reste un refus.
 */
const productIdentitySchema = z.object({
  id: uuidSchema,
  sku: z.string().min(1),
  name: z.string().min(1),
  isActive: z.boolean(),
});

export const productSchema = productIdentitySchema
  .extend({ priceAmountMinor: z.number(), currency: z.string() })
  .transform(({ priceAmountMinor, currency, ...product }) => ({
    ...product,
    price: { amountMinor: priceAmountMinor, currency },
  }))
  .pipe(productIdentitySchema.extend({ price: nonNegativeMoneySchema }));

export type Product = z.infer<typeof productSchema>;

/**
 * Une ligne de ticket, telle que le serveur l'a composée.
 *
 * `label`, `unitAmount` et `lineAmount` viennent tous du serveur — le front n'en
 * fabrique aucun. En particulier **`lineAmount` n'est pas recalculé à
 * l'affichage** : c'est `unitAmount × quantity` vérifié par une contrainte de la
 * base, et le multiplier de nouveau dans un composant n'ajouterait qu'un second
 * chiffre susceptible de diverger du premier (payments-stripe §4).
 *
 * `serviceId` et `productId` sont `nullable` et non `optional` : l'API émet
 * explicitement `null` sur les natures qui ne les portent pas — une ligne `TAX`
 * ne référence ni prestation ni article.
 */
export const saleItemSchema = z.object({
  id: uuidSchema,
  kind: saleItemKindSchema,
  serviceId: uuidSchema.nullable(),
  productId: uuidSchema.nullable(),
  label: z.string().min(1),
  quantity: z.number().int(),
  unitAmount: nonNegativeMoneySchema,
  lineAmount: nonNegativeMoneySchema,
  position: z.number().int().min(0),
});

export type SaleItem = z.infer<typeof saleItemSchema>;

/**
 * L'en-tête d'un ticket — ce que `GET /sales` rend, sans les lignes.
 *
 * Les quatre montants sont **les quatre autorités** de l'écran de caisse. Aucun
 * ne se déduit des autres côté front : `total` n'est pas « subtotal + tax + tip »
 * calculé ici, c'est le champ que le serveur a recalculé et que la base a
 * vérifié. Le troisième critère de ce ticket tient à cette phrase-là.
 */
export const saleSummarySchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.nullable(),
  cashierUserId: uuidSchema,
  subtotal: nonNegativeMoneySchema,
  tax: nonNegativeMoneySchema,
  tip: nonNegativeMoneySchema,
  total: nonNegativeMoneySchema,
  createdAt: utcInstantSchema,
});

export type SaleSummary = z.infer<typeof saleSummarySchema>;

/** Le ticket complet — `POST /sales` et `GET /sales/:id` —, lignes comprises. */
export const saleSchema = saleSummarySchema.extend({
  items: z.array(saleItemSchema),
});

export type Sale = z.infer<typeof saleSchema>;

/**
 * Une page d'historique de caisse — `GET /sales`.
 *
 * `totalPages` vaut `0` sur un ensemble vide, et non `1` : « page 1 sur 0 » est
 * ce que le contrat annonce, et un sélecteur de page qui afficherait « 1 sur 1 »
 * ferait croire à une page qu'on n'a pas su charger.
 */
export const salePageSchema = z.object({
  items: z.array(saleSummarySchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

export type SalePage = z.infer<typeof salePageSchema>;

/**
 * Une ligne demandée au serveur — le corps de `POST /sales`, côté aller.
 *
 * ## Le champ qui n'existe pas, et qui ne doit pas exister
 *
 * Il n'y a **aucun montant** sur une ligne `SERVICE` ou `PRODUCT`, et aucun
 * total sur la demande. Ce n'est pas une omission que le serveur rattraperait :
 * c'est la forme même du contrat, et elle est reprise ici à l'identique de
 * `SaleLineDto` pour que le front n'ait littéralement **pas de place où écrire
 * un prix**. Le `ValidationPipe` de l'API est en `forbidNonWhitelisted` : un
 * champ glissé en plus serait refusé en 400, nommé — mais il ne peut pas l'être,
 * puisque cette union ne le laisse pas se taper.
 *
 * Le pourboire fait exception et il est le seul : il n'existe dans aucune table
 * à relire, le serveur ne peut que le borner (payments-stripe §5 — un pourboire
 * est une ligne, jamais une part fondue dans le prix).
 *
 * Une union discriminée plutôt qu'un objet à champs facultatifs : un
 * `productId` sur une ligne `SERVICE` ne se compile pas, là où un objet plat
 * l'aurait laissé passer jusqu'au serveur pour y être ignoré en silence.
 */
export type SaleLineRequest =
  | { readonly kind: 'SERVICE'; readonly serviceId: string; readonly quantity: number }
  | { readonly kind: 'PRODUCT'; readonly productId: string; readonly quantity: number }
  | { readonly kind: 'TIP'; readonly amountMinor: number };

/**
 * L'ouverture d'un ticket — `POST /sales`.
 *
 * Ni `cashierUserId` ni `tenantId` : l'opérateur vient du jeton vérifié,
 * l'établissement de la revendication signée (tenant-isolation §2). Les envoyer
 * aurait fait du navigateur l'autorité sur qui a encaissé et pour quel salon.
 *
 * `appointmentId` est `null` — et non absent — pour une vente retail autonome :
 * le contrat accepte les deux, et une seule forme évite d'avoir à se demander
 * laquelle on tient.
 */
export interface CreateSaleRequest {
  readonly appointmentId: string | null;
  readonly lines: readonly SaleLineRequest[];
}
