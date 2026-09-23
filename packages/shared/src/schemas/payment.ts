/**
 * Encaissement — en ligne ou au comptoir, carte ou espèces.
 *
 * **Frontière PCI, et c'est la raison d'être de ce fichier autant que ses
 * types** : aucun champ ci-dessous ne peut transporter une donnée de carte. Ni
 * PAN, ni cryptogramme, ni date d'expiration, ni nom du porteur. La tokenisation
 * se fait côté client vers Stripe ; le serveur ne voit que des références
 * opaques (`pi_…`, `pm_…`) et le périmètre reste en SAQ A.
 *
 * Le contrat est le bon endroit pour l'écrire : un champ ajouté ici serait
 * accepté par le `ValidationPipe` du back et sérialisé par le front sans que
 * personne n'ait à décider quoi que ce soit. Le `.strict()` de chaque schéma
 * d'entrée refuse ce qu'il ne connaît pas — un `cardNumber` glissé dans un corps
 * de requête sort en 422 plutôt que d'atterrir dans un log.
 */

import { z } from 'zod';

import { opaqueTokenSchema, reasonSchema, uuidSchema } from '../common/identifiers';
import {
  currencyCodeSchema,
  nonNegativeMoneySchema,
  positiveMoneySchema,
} from '../common/money';
import { utcInstantSchema } from '../common/time';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../constants/payment';

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * Moyen d'encaissement **tel qu'il arrive du fil**, ramené au vocabulaire du
 * contrat.
 *
 * L'API émet `CASH` — la casse de l'énumération PostgreSQL que Prisma génère —
 * là où ce contrat nomme le même moyen `cash`. La conversion se fait donc **une
 * fois, à la frontière**, exactement comme `receivedAppointmentStatusSchema` le
 * fait pour les statuts de rendez-vous : au-delà, plus aucun écran n'a à se
 * demander dans quelle casse il compare un moyen de paiement.
 *
 * Ce n'était pas ici jusqu'à #1026 mais dans `apps/web`, et c'est exactement le
 * défaut que #444 avait corrigé sur l'agenda : un schéma de sortie qui nomme ses
 * valeurs autrement que la route ne les sert **échoue sur la casse d'une
 * chaîne**, et il échoue pour tout lecteur qui n'a pas pensé à réécrire le champ.
 * Le champ inféré reste `PaymentMethod`, en minuscules : rien ne change pour qui
 * consomme ce type.
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
 * Par quel tuyau une carte est passée — `enum PaymentCardChannel` du schéma
 * (#834, [ADR 0015](../../../../docs/adr/0015-carte-au-comptoir-par-tpe.md)).
 *
 * `STRIPE` est l'intention du tunnel public, le seul endroit du produit où
 * Stripe touche une carte. `TERMINAL` est le **TPE autonome** du salon : celui
 * de sa banque, non relié à l'application, dont nous n'enregistrons que
 * l'issue — rien de ce qu'il manipule ne traverse notre code
 * (payments-stripe §1).
 *
 * En majuscules, comme {@link counterPaymentMethodSchema} et pour la même
 * raison : c'est la casse que `GET /v1/payments` **sert**, et décrire ce que la
 * route sert plutôt que ce qu'elle devrait servir est ce que #554 a tranché.
 * C'est aussi pourquoi ce canal n'est pas normalisé par un `received…` comme le
 * moyen l'est : il n'a pas de second vocabulaire en minuscules dont il faudrait
 * le rapprocher.
 */
export const paymentCardChannelSchema = z.enum(['STRIPE', 'TERMINAL']);

export type PaymentCardChannel = z.infer<typeof paymentCardChannelSchema>;

/**
 * La référence du ticket du TPE — #834, deuxième critère.
 *
 * Le terminal imprime un numéro d'opération ou d'autorisation ; le caissier le
 * recopie pour que le rapprochement de fin de journée puisse partir de notre
 * ligne et retrouver la sienne. C'est un identifiant opaque émis par la banque
 * du salon, du même rang qu'un `pi_…`.
 *
 * ## Les bornes, et celle qui n'est pas ici
 *
 * La **forme** est bornée comme la colonne et comme le DTO la bornent : 32
 * caractères alphanumériques au plus, et au moins un. Ni espace, ni tiret, ni
 * barre oblique — aucun terminal n'imprime de référence qui en ait besoin, et
 * les séparateurs sont précisément ce qui rend un numéro de carte méconnaissable
 * à un contrôle. La longueur nulle n'en est pas une : un champ laissé vide doit
 * être **absent** du corps, sans quoi « le caissier n'a pas saisi la référence »
 * et « le caissier a saisi une chaîne vide » deviendraient deux états
 * indiscernables d'une même colonne.
 *
 * La seconde barrière de l'API — **la clé de Luhn**, qui refuse en 400 une suite
 * de 13 à 19 chiffres qui la vérifie — n'est **pas** reprise ici, et c'est
 * délibéré : elle vit à un seul endroit,
 * `apps/api/src/modules/payments/terminal-reference.ts`, et la recopier dans ce
 * paquet donnerait deux implémentations d'un même contrôle de conformité, donc
 * deux implémentations à faire diverger un jour. La garantie ne s'en trouve pas
 * affaiblie : le refus tombe dans le `ValidationPipe` global, avant qu'aucune
 * ligne de code métier ne s'exécute et avant que la valeur n'atteigne un journal
 * (payments-stripe §1). Ce que ce schéma garantit est qu'aucun appelant ne peut
 * *construire* une référence hors format ; ce que l'API garantit est qu'un PAN
 * bien formé n'entre pas.
 */
export const terminalReferenceSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9]+$/);

/**
 * Encaissement tel que l'API le renvoie.
 *
 * `amount` et `refunded` sont deux `Money` complets et non deux entiers
 * partageant une devise implicite : le rapprochement additionne des montants,
 * et un entier sans devise est exactement ce qui permet d'additionner des euros
 * à des dollars sans que rien ne proteste.
 *
 * `appointmentId` et `capturedAt` sont `nullable` et non `optional` : l'API émet
 * explicitement `null` sur une vente retail sans rendez-vous et tant que
 * l'argent n'a pas été pris. « Absent » et « nul » ne sont pas la même chose
 * pour Zod, et c'est le second des deux écarts que #554 a tranchés — le contrat
 * suit ce que `PaymentTransactionDto` sert, plutôt que l'inverse.
 *
 * `refunded` porte le nom de la clé du fil, celui de `PaymentTransactionDto` :
 * décrire la même réponse sous deux noms était exactement ce qui obligeait le
 * back-office à redéclarer l'enveloppe au lieu de lire celle-ci.
 *
 * ## Le moyen et le statut sont normalisés **à la réception** (#1026)
 *
 * `receivedPaymentMethodSchema` et `receivedPaymentStatusSchema`, et non les deux
 * énumérations nues : l'API émet la casse de l'énumération PostgreSQL (`CASH`,
 * `SUCCEEDED`), ce contrat nomme les mêmes valeurs en minuscules, et un schéma
 * qui les exigeait telles quelles **ne pouvait pas lire la réponse** qu'il
 * prétendait décrire. C'est la conversion que `apps/web` portait seul et qu'un
 * second lecteur — l'écran d'encaissement de #1025 — aurait dû redécouvrir à ses
 * frais ; même remède, et pour la même raison, que `appointmentSchema` en #444.
 * Les champs inférés ne changent pas : `PaymentMethod` et `PaymentStatus`, en
 * minuscules.
 */
export const paymentSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.nullable(),
  /**
   * Le ticket que ce règlement solde — #817, CDC §2.4.
   *
   * `nullable` parce que l'API émet explicitement `null` sur les encaissements
   * inscrits **avant** que la colonne n'existe : c'est le script de reprise
   * (`pos.sale-backfill.ts`) qui les rattache, et tout règlement neuf en porte
   * un — la base l'exige par `payments_sale_required_check`.
   *
   * `optional` **en plus**, et c'est une décision de contrat plutôt qu'une
   * commodité : un champ ajouté à une réponse s'ajoute de façon **additive**,
   * comme une colonne s'ajoute à une table (api-module §6). Le déclarer exigé
   * d'emblée ferait échouer à la compilation tout consommateur qui construit un
   * encaissement — le tableau d'encaissement du back-office et ses fixtures en
   * premier — pour un champ qu'aucun d'eux ne lit encore. Le resserrer en
   * `nullable` seul est le travail du ticket qui le fera lire, une fois que
   * chacun le produit.
   *
   * Ce que l'assouplissement **ne** dit pas : que l'API puisse l'omettre. Elle
   * ne l'omet jamais — `PaymentTransactionDto` le sert toujours, `null` compris.
   */
  saleId: uuidSchema.nullable().optional(),
  amount: nonNegativeMoneySchema,
  refunded: nonNegativeMoneySchema,
  method: receivedPaymentMethodSchema,
  /**
   * Le tuyau de la carte — `null` sur un règlement en espèces (#834).
   *
   * Avec `method`, il forme le **moyen** : c'est ce couple, et non `method`
   * seul, qui distingue le TPE du salon de l'intention du tunnel public. Deux
   * rapprochements différents en dépendent — le relevé de fin de journée du
   * terminal d'un côté, le relevé Stripe de l'autre — et `method` seul les
   * confondrait.
   *
   * `nullable` parce que l'API émet explicitement `null` : sur une vente en
   * espèces, et sur les lignes `CARD` inscrites avant #834 que la migration n'a
   * volontairement pas reprises. `optional` **en plus**, pour la raison qui vaut
   * déjà pour `saleId` juste au-dessus : un champ ajouté à une réponse s'ajoute
   * de façon **additive** (api-module §6), et le déclarer exigé d'emblée ferait
   * échouer à la compilation tout consommateur qui construit un encaissement —
   * fixtures du back-office comprises — pour un champ qu'aucun d'eux ne lit
   * encore. Le resserrer est le travail du ticket qui le fera lire.
   */
  cardChannel: paymentCardChannelSchema.nullable().optional(),
  /**
   * La référence du ticket du TPE, quand le caissier l'a saisie — #834.
   *
   * Elle est au rapprochement du terminal ce que `providerChargeId` est au relevé
   * Stripe : la ligne par laquelle on retrouve l'opération chez celui qui l'a
   * exécutée. `null` partout ailleurs, et **jamais une donnée de carte**.
   *
   * Même régime d'ajout que `cardChannel` ci-dessus. En revanche **pas** la
   * borne de forme de {@link terminalReferenceSchema}, et c'est la même règle
   * que celle qui fait de `saleSettlementSchema` un schéma non strict : borner
   * en lecture ce qu'on borne à l'écriture, c'est faire échouer la **réponse
   * entière** sur une valeur qui existe déjà. La base ne garantit que
   * `VARCHAR(32)` ; une référence posée hors du DTO — reprise de données,
   * import, chaîne blanche que `receipt-pdf.format.ts` sait déjà absorber — ferait
   * alors tomber le journal des transactions au complet plutôt que d'afficher un
   * champ douteux. Le refus de forme appartient à l'aller, où il empêche la
   * valeur d'entrer ; au retour, on décrit ce qui est là.
   */
  terminalReference: z.string().nullable().optional(),
  status: receivedPaymentStatusSchema,
  capturedAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
});

export type Payment = z.infer<typeof paymentSchema>;

/**
 * Ouvre un paiement en ligne pour un rendez-vous.
 *
 * Le corps ne porte **pas** de montant : il est relu du rendez-vous côté
 * serveur. Laisser le client l'annoncer, c'est le laisser payer le prix qu'il
 * choisit — la validation « le montant envoyé égale le montant dû » n'ajoute
 * rien qu'une relecture serveur ne fasse déjà, et elle ouvre un écart dès que
 * les deux sources divergent.
 */
export const createPaymentIntentRequestSchema = z
  .object({
    appointmentId: uuidSchema,
  })
  .strict();

export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequestSchema>;

/**
 * Ce que le front reçoit pour finir le paiement dans l'élément Stripe.
 *
 * `clientSecret` est un jeton opaque à usage unique, lié à une intention. Il
 * n'est **pas** un secret d'API : il ne permet que de confirmer ce paiement-là.
 * Le contrat le type comme opaque pour que personne ne soit tenté d'y lire
 * quelque chose. `publishableKey` est publiable par définition
 * (payments-stripe §7) : c'est elle qui évite de graver la clé Stripe du salon
 * dans le build du front. La clé **secrète** ne quitte jamais le serveur.
 *
 * ## Les six clés, et pourquoi elles sont six
 *
 * Ce schéma n'en portait que trois — `paymentId`, `clientSecret`, `amount` —, et
 * son `.strict()` aurait donc rejeté la réponse entière de
 * `POST /appointments/:id/payment-intent`, qui en sert six. C'est le premier des
 * deux écarts que #510 avait instruits sans pouvoir les refermer, et #554 l'a
 * tranché dans ce sens-ci : **le contrat suit la réponse**. Retirer
 * `appointmentId`, `status` et `publishableKey` de l'API aurait cassé le tunnel
 * de paiement, alors que les décrire ici ne coûte que cette déclaration — et
 * rend au back-office comme au module `payments` une enveloppe qu'ils
 * redéclaraient chacun de leur côté.
 *
 * `status` est nommé dans le vocabulaire **du contrat**, en minuscules. L'API
 * sert la casse de l'énumération PostgreSQL (`PENDING`), et le tunnel de paiement
 * réécrit donc ce seul champ par `receivedPaymentStatusSchema`
 * (`apps/web/lib/admin/payment-contract.ts`). Il reste le dernier schéma de ce
 * fichier dans ce cas : `paymentSchema` normalise désormais lui-même, et le jour
 * où celui-ci le fera aussi l'extension du front n'aura plus de raison d'être.
 * C'est la même discipline que pour le statut d'un rendez-vous, et elle est
 * délibérée : un seul endroit sait dans quelle casse la valeur est arrivée.
 */
export const paymentIntentSchema = z
  .object({
    paymentId: uuidSchema,
    appointmentId: uuidSchema,
    amount: positiveMoneySchema,
    status: paymentStatusSchema,
    clientSecret: opaqueTokenSchema,
    publishableKey: opaqueTokenSchema,
  })
  .strict();

export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

/**
 * Encaissement au comptoir (POS).
 *
 * `amount` est ici une entrée légitime, contrairement au paiement en ligne : une
 * vente retail sans rendez-vous n'a aucun montant à relire ailleurs. Le champ
 * est un `Money` strictement positif — encaisser zéro n'est pas une opération.
 *
 * Aucune référence de carte n'entre : un règlement carte au comptoir passe par
 * le terminal du salon, dont on ne conserve que l'issue.
 */
export const recordCounterPaymentRequestSchema = z
  .object({
    appointmentId: uuidSchema.optional(),
    amount: positiveMoneySchema,
    method: paymentMethodSchema,
  })
  .strict();

export type RecordCounterPaymentRequest = z.infer<typeof recordCounterPaymentRequestSchema>;

/**
 * Remboursement total ou partiel.
 *
 * `amount` omis vaut « tout ce qui reste encaissé ». Le plafonnement se fait
 * côté serveur — un remboursement supérieur au restant sort en
 * `REFUND_EXCEEDS_CAPTURED`, jamais en conversion silencieuse.
 *
 * **La devise déclarée ici n'est pas encore celle que la route reçoit.** Ce
 * schéma décrit un couple `{ amountMinor, currency }` là où
 * `POST /payments/:id/refunds` porte un `amountMinor` nu et relit la devise de
 * l'encaissement en base : elle n'est pas au choix de l'appelant, et l'API
 * n'émet aucun refus pour une devise contredite — il n'y en a pas à contredire.
 * L'écart est instruit, avec la décision qui reste à prendre, en tête de
 * `apps/api/src/modules/payments/dto/refund.dto.ts` : poster le couple tel quel
 * se fait aujourd'hui refuser en 400 par le `whitelist` du `ValidationPipe`.
 */
export const refundPaymentRequestSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict();

export type RefundPaymentRequest = z.infer<typeof refundPaymentRequestSchema>;

/**
 * Les moyens de règlement **au comptoir**, dans la casse que la caisse emploie
 * sur le fil — #817.
 *
 * ## Pourquoi cette liste et non `paymentMethodSchema`
 *
 * Parce que les routes du POS servent la casse de l'énumération PostgreSQL
 * (`CASH`), là où le reste du contrat nomme les moyens en minuscules. Ce n'est
 * pas un oubli : `pos.types.ts` le dit depuis #510, `SALE_ITEM_KINDS` est dans
 * le même cas, et unifier la casse est une décision de contrat qui se prend une
 * fois pour tout le POS — pas au détour d'un ticket de correction. Décrire ici
 * ce que la route accepte réellement vaut mieux que décrire ce qu'elle
 * *devrait* accepter : c'est l'écart que #554 a tranché en faveur de la
 * réponse, et que le corps de `refundPaymentRequestSchema` documente encore
 * faute d'avoir pu le refermer.
 *
 * `CARD` au comptoir désigne le **terminal de paiement du salon**, jamais
 * Stripe (arbitrage du 16/09, #834) : rien de ce que le terminal manipule ne
 * traverse notre code, et le serveur n'en conserve que l'issue
 * (payments-stripe §4).
 *
 * ## Ce n'est plus ce que le règlement **accepte** — #1026
 *
 * Ce schéma décrivait aussi le `method` de {@link settleSaleRequestSchema}. Il ne
 * le décrit plus : depuis #834 la route de règlement attend `CARD_TERMINAL`, et
 * les deux valeurs ont cessé d'être la même liste sous deux emplois. Ce qui reste
 * à cette énumération est ce que la **pièce** imprime — la ligne de règlement du
 * reçu, où « carte » n'a plus à distinguer un tuyau puisque le comptoir n'en a
 * qu'un : `ReceiptSettlementDto.method` sert bien `CASH` ou `CARD`. Voir
 * {@link counterSettlementMeanSchema} pour l'aller.
 */
export const counterPaymentMethodSchema = z.enum(['CASH', 'CARD']);

export type CounterPaymentMethod = z.infer<typeof counterPaymentMethodSchema>;

/**
 * Les moyens de règlement que le **comptoir** sait produire — #834, deuxième
 * critère.
 *
 * ## Pourquoi ce n'est pas `counterPaymentMethodSchema`
 *
 * Parce que la base porte deux faits là où le caissier en désigne un seul. « La
 * cliente a payé au terminal » est une phrase ; en base, c'est le couple
 * (`method = CARD`, `card_channel = TERMINAL`). Demander à l'écran de caisse
 * d'envoyer les deux champs l'aurait rendu capable d'en composer un troisième qui
 * n'existe pas — une espèce avec un canal, une carte sans tuyau —, alors que
 * `payments_card_channel_check` refuse précisément ces couples-là. Le fil nomme
 * donc les **combinaisons légitimes**, et la conversion se fait une fois, côté
 * serveur (`payments.types.ts`, `counterSettlementOf`).
 *
 * ## `CARD_ONLINE` n'y est pas, et c'est le cœur de l'ADR 0015
 *
 * « Stripe n'est plus utilisé au comptoir » : une carte réglée devant le caissier
 * passe par le TPE de la banque du salon, l'application n'appelle aucun
 * prestataire et n'a aucun formulaire de carte à afficher. Ce n'est pas un
 * contrôle défensif mais la **forme du contrat** — il n'y a pas de valeur à
 * refuser, puisqu'aucun appelant ne peut la taper. `GET /v1/sales?method=` sait
 * en revanche filtrer `CARD_ONLINE` : relire les intentions du tunnel n'est pas
 * en produire une.
 */
export const counterSettlementMeanSchema = z.enum(['CASH', 'CARD_TERMINAL']);

export type CounterSettlementMean = z.infer<typeof counterSettlementMeanSchema>;

/**
 * Régler un ticket, en une fois ou en plusieurs — quatrième critère de #817.
 *
 * ## Aucun total n'entre ici
 *
 * Ni `total`, ni `currency` : le montant dû est celui que le serveur a composé
 * en écrivant le ticket, relu en base à chaque règlement (cinquième critère).
 * Ce que l'appelant fixe est la **part** qu'il règle maintenant, et rien
 * d'autre — c'est ce qui permet à un ticket de 78,00 € de se régler en 50,00 €
 * d'espèces puis 28,00 € au terminal.
 *
 * - `amountMinor` omis vaut **tout le reste dû**. L'écran de caisse n'a donc
 *   rien à calculer pour le cas courant, qui est le règlement en une fois.
 * - `amountMinor` fourni et supérieur au reste dû sort en `SALE_OVERPAYMENT`
 *   (422) : le serveur ne rogne jamais un montant en silence.
 * - `tenderedAmountMinor` est **ce que la cliente a tendu**, et il n'a de sens
 *   qu'en espèces. L'excédent n'est pas un dépassement, c'est la monnaie
 *   rendue : le règlement n'engage que le reste dû, et la réponse dit ce qu'il
 *   faut rendre. Les deux montants s'excluent — tendre un billet *et* désigner
 *   une part serait deux instructions pour un seul geste.
 *
 * Le `.strict()` refuse ce qu'il ne connaît pas, à commencer par un `saleId`
 * glissé dans le corps : la vente est désignée par l'URL, et l'établissement
 * par le jeton (tenant-isolation §2).
 *
 * ## Le moyen est celui du fil, pas celui de la base — #834, refermé par #1026
 *
 * `method` valait `CASH` ou `CARD` ; la route attend `CASH` ou `CARD_TERMINAL`
 * depuis #834, si bien que **la seule requête carte que ce schéma savait
 * construire était celle que l'API refuse en 400**. Un contrat qui ne sait
 * produire qu'un refus est pire qu'un contrat absent : il donne l'assurance
 * d'avoir vérifié. C'est le constat de #1026, et la raison pour laquelle
 * `counterSettlementMeanSchema` existe.
 *
 * `terminalReference` entre par le même chemin : facultative — le caissier n'a
 * pas toujours le ticket du terminal sous la main, et bloquer la caisse sur un
 * champ de confort serait un refus de service —, bornée en forme par
 * {@link terminalReferenceSchema}, et **refusée sur un règlement en espèces** :
 * seul un passage au terminal en porte une (`settlement.dto.ts`,
 * `LegitimateTerminalReference`). Ce dernier refus est croisé et reste côté
 * serveur, comme la clé de Luhn.
 */
export const settleSaleRequestSchema = z
  .object({
    method: counterSettlementMeanSchema,
    amountMinor: z.number().int().positive().optional(),
    tenderedAmountMinor: z.number().int().positive().optional(),
    terminalReference: terminalReferenceSchema.optional(),
  })
  .strict();

export type SettleSaleRequest = z.infer<typeof settleSaleRequestSchema>;

/**
 * Ce que le comptoir reçoit en retour d'un règlement — #817.
 *
 * Trois faits, et il faut les trois pour que l'écran sache quoi afficher :
 * l'encaissement qui vient d'être inscrit, l'état du ticket après lui, et la
 * monnaie à rendre. Sans le deuxième, la caisse ne saurait pas s'il reste
 * quelque chose à encaisser ; sans le troisième, elle devrait recalculer une
 * différence dont le serveur est seul à connaître les deux termes.
 *
 * `change` vaut zéro dès que rien n'est à rendre — un `Money` à zéro plutôt
 * qu'un champ absent, pour que l'écran n'ait pas deux formes à lire.
 *
 * ## `replayed`, quatrième fait — #834, refermé par #1026
 *
 * `true` lorsque la clé `Idempotency-Key` désignait un règlement **déjà
 * inscrit** : rien n'a été écrit, et `payment` est celui de la première
 * soumission. L'écran n'a rien de différent à faire des deux cas — c'est tout
 * l'intérêt de la clé — mais le comptoir a le droit de savoir qu'il n'a pas
 * encaissé deux fois, et un journal structuré a le droit de le distinguer d'un
 * geste réel.
 *
 * ## Pourquoi ce schéma n'est plus `.strict()`
 *
 * Parce qu'il décrit une **sortie**, et que le `.strict()` annoncé en tête de
 * fichier est un dispositif d'**entrée** : y refuser l'inconnu est ce qui empêche
 * un `cardNumber` d'atterrir dans un journal. En lecture, la même rigueur se
 * retourne contre ce qu'elle protège, et c'est exactement ce que #1026 constate :
 * l'API a ajouté `replayed`, le schéma a rejeté la réponse **entière** par
 * `unrecognized_keys`, et un écran de caisse aurait cessé d'encaisser pour un
 * champ qu'il ne lit pas. Un objet Zod non strict **retire** ce qu'il ne déclare
 * pas : la donnée n'atteint ni composant ni journal dans les deux cas, seule
 * diffère la manière dont le comptoir survit à l'ajout. Le raisonnement est écrit
 * au long dans `apps/web/lib/admin/payment-contract.ts`, où le même arbitrage a
 * dû être rendu à l'envers : faute de pouvoir lever le `.strict()` de
 * {@link paymentIntentSchema}, le front y pose un `.strip()` explicite sur
 * `appointmentPaymentIntentSchema`. Ce schéma-ci n'a pas eu besoin d'un tel
 * contrepoids — aucun consommateur ne le lisait encore quand #1026 l'a
 * constaté —, et c'est bien pourquoi la rigueur se corrige à la source.
 */
export const saleSettlementSchema = z.object({
  payment: paymentSchema,
  saleId: uuidSchema,
  total: nonNegativeMoneySchema,
  settled: nonNegativeMoneySchema,
  remaining: nonNegativeMoneySchema,
  change: nonNegativeMoneySchema,
  settledAt: utcInstantSchema.nullable(),
  replayed: z.boolean(),
});

export type SaleSettlement = z.infer<typeof saleSettlementSchema>;

/**
 * Filtres du journal des encaissements du back-office.
 *
 * `currency` sert au rapprochement : un établissement qui encaisse en deux
 * devises n'additionne pas ses deux journaux.
 */
export const paymentListQuerySchema = z
  .object({
    appointmentId: uuidSchema.optional(),
    statuses: z.array(paymentStatusSchema).nonempty().optional(),
    method: paymentMethodSchema.optional(),
    currency: currencyCodeSchema.optional(),
  })
  .strict();

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
