# Benchmark — encaissement, ventes et reporting

Relevé le 2026-09-16. Écrans concernés : `/[tenantSlug]/admin/encaissement`,
`/[tenantSlug]/admin/reporting`, et le panneau de rendez-vous du planning
quand il mène à l'encaissement. Règles de lecture et de citation :
[README.md](README.md).

Les back-offices des références sont privés : tous les motifs de ce fichier
sont **documentés** par les centres d'aide, aucun n'est observé à l'écran. Ils
disent ce qu'un écran fait et dans quel ordre, rarement à quoi il ressemble.
Le centre d'aide de Vagaro refuse la lecture directe et celui de Booker est une
application que l'outil de lecture ne rend pas : leurs apports sont des
`extrait`, jamais la seule source d'un motif.

## Encaissement au comptoir

### BM-CAISSE-01 — L'encaissement part du rendez-vous, panier déjà rempli

- **Étape** : encaissement — ouverture depuis le rendez-vous
- **Ce que voit l'utilisateur** : dans le panneau du rendez-vous, un bouton « Encaisser » ; l'écran d'encaissement s'ouvre avec la prestation, le praticien et le prix du rendez-vous déjà repris, sans rien ressaisir.
- **Pourquoi** : aucune ressaisie, donc aucun écart entre ce qui a été réservé et ce qui est facturé.
- **À vérifier chez nous** : depuis le planning, combien de gestes pour arriver à un panier prêt à payer ? La prestation et le praticien y sont-ils déjà ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/355-raise-a-sale
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941386-appointment-checkout
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6001-check-out-with-the-square-appointments-app
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016486099-How-do-I-check-out-a-client-and-pay-for-an-appointment
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/12490394352155-Check-Out-a-Customer-s-Appointment

### BM-CAISSE-02 — Un panier qu'on complète, avec sous-total, total et reste dû

- **Étape** : encaissement — panier
- **Ce que voit l'utilisateur** : un bouton « Ajouter » (prestation ou produit) dans le panier ; chaque ligne se modifie ou se retire ; en bas, un récapitulatif sous-total, taxe, total et reste à payer, recalculé à chaque changement.
- **Pourquoi** : un produit vendu ou un soin ajouté sur place ne crée pas une seconde vente, et le montant dû reste toujours lisible.
- **À vérifier chez nous** : peut-on ajouter un produit retail au panier d'un rendez-vous ? Le reste à payer est-il affiché en permanence, à côté du bouton de paiement ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/355-raise-a-sale
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941386-appointment-checkout
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6001-check-out-with-the-square-appointments-app
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/12490394352155-Check-Out-Customers

### BM-CAISSE-03 — Espèces : montant remis saisi, monnaie à rendre calculée

- **Étape** : encaissement — paiement en espèces
- **Ce que voit l'utilisateur** : « Espèces » est un moyen de paiement toujours présent ; on saisit le montant remis par le client, et « Montant payé » et « À rendre » se mettent à jour pendant la frappe ; la monnaie rendue reste inscrite dans la transaction.
- **Pourquoi** : pas de calcul mental au comptoir, et un rendu vérifiable après coup.
- **À vérifier chez nous** : le paiement en espèces demande-t-il le montant remis et affiche-t-il la monnaie à rendre avant de valider ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/126-manage-manual-payment-types
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/345-payments-summary-article-1
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/22544977837723-Accept-Cash-or-Check-as-Payment

Preuve la plus mince du fichier : chez Fresha, la monnaie rendue est attestée
par une colonne de rapport, pas par l'écran d'encaissement. Un constat qui cite
ce motif le dit.

### BM-CAISSE-04 — Une fin d'encaissement sans ambiguïté, reçu au choix, planning à jour

- **Étape** : encaissement — confirmation
- **Ce que voit l'utilisateur** : un écran final marqué d'une coche de succès, le choix du reçu (e-mail, impression) pré-coché selon le client, puis « Terminé » ; de retour au planning, le rendez-vous a changé d'apparence pour dire qu'il est réglé.
- **Pourquoi** : l'accueil sait que l'argent est encaissé, et le planning montre l'état réel de la journée.
- **À vérifier chez nous** : après paiement, voit-on un succès explicite et le choix du reçu ? Le rendez-vous se distingue-t-il ensuite au planning des rendez-vous non réglés — autrement que par la seule couleur ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941386-appointment-checkout
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941488-receipts-sending-printing-and-saving
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5177-accept-cash-checks-and-other-tender
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/171-share-and-print-sale-receipts
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018094500-How-do-I-undo-a-sale-transaction
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360000278333-Print-and-Send-a-Receipt-and-Set-Up-Receipt-Settings

### BM-CAISSE-05 — Les gestes sensibles de caisse dépendent du rôle

- **Étape** : encaissement — droits
- **Ce que voit l'utilisateur** : un membre de l'équipe sans le droit voulu ne voit pas, ou ne peut pas utiliser, la modification de prix, l'annulation d'une vente ou le remboursement ; le contrôle est affiché, pas découvert après coup par un refus.
- **Pourquoi** : moins d'erreurs et de fraude sur les montants encaissés.
- **À vérifier chez nous** : un praticien sans droit de caisse voit-il des boutons qu'il ne peut pas utiliser ? Le refus arrive-t-il avant le geste ou après ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5362-apply-discounts
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/126-manage-manual-payment-types
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941479-voiding-orders
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/4412317816731-Limit-Employees-Ability-to-Change-Prices-and-Discounts

## Historique des ventes

### BM-VENTE-01 — Une liste filtrable par période, moyen de paiement, statut et praticien

- **Étape** : historique des ventes — liste
- **Ce que voit l'utilisateur** : en tête de liste, une barre de filtres — période, moyen de paiement, type (vente ou remboursement), statut, membre de l'équipe — et la liste se réduit à chaque choix.
- **Pourquoi** : retrouver « les espèces de samedi » sans parcourir toute la liste.
- **À vérifier chez nous** : l'historique des ventes se filtre-t-il au moins par période, moyen de paiement et statut ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5145-transaction-search
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941474-orders-and-closeout
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/347-payment-transactions-article-1
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018125499-How-do-I-reprint-a-client-s-receipt
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/204347940-Transaction-List-Report

### BM-VENTE-02 — Une recherche par client, référence de vente ou quatre derniers chiffres

- **Étape** : historique des ventes — recherche
- **Ce que voit l'utilisateur** : un champ au-dessus de la liste accepte le nom, le téléphone ou l'e-mail du client, le numéro de vente ou de reçu, et les quatre derniers chiffres de la carte.
- **Pourquoi** : répondre en quelques secondes à « j'ai été débitée deux fois ».
- **À vérifier chez nous** : peut-on retrouver une vente par le nom du client ou sa référence ? (Sous SAQ A, seuls la marque et les quatre derniers chiffres rendus par Stripe s'affichent — jamais davantage.)
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5145-transaction-search
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941474-orders-and-closeout
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/367-void-a-sale

### BM-VENTE-03 — Chaque vente porte un statut nommé

- **Étape** : historique des ventes — statut
- **Ce que voit l'utilisateur** : sur chaque ligne, un statut en toutes lettres — réglée, impayée, remboursée, annulée — qui sert aussi de filtre.
- **Pourquoi** : distinguer d'un coup d'œil une vente soldée d'une vente remboursée.
- **À vérifier chez nous** : le statut d'une vente est-il écrit, et pas seulement suggéré par une couleur ou un signe ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941474-orders-and-closeout
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/338-sales-summary-article-1
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale

### BM-VENTE-04 — Le détail d'une vente porte ses actions

- **Étape** : historique des ventes — détail
- **Ce que voit l'utilisateur** : un clic sur une vente ouvre son détail (panneau latéral ou page) ; les actions qui la concernent y sont réunies — reçu, rembourser, annuler.
- **Pourquoi** : toute action post-vente part de la vente concernée, ce qui évite d'agir sur la mauvaise ligne.
- **À vérifier chez nous** : depuis une vente de l'historique, peut-on renvoyer le reçu et rembourser sans changer d'écran ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018125499-How-do-I-reprint-a-client-s-receipt
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5145-transaction-search
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941474-orders-and-closeout

### BM-VENTE-05 — Chaque paiement dit comment, quand et par qui

- **Étape** : historique des ventes — détail d'un paiement
- **Ce que voit l'utilisateur** : pour chaque paiement, le moyen (marque et quatre derniers chiffres pour une carte), le montant net des remboursements, la date et l'heure, et la personne qui a encaissé.
- **Pourquoi** : chaque encaissement est attribuable, ce qu'exige un litige ou un écart de caisse.
- **À vérifier chez nous** : le détail d'une vente dit-il qui l'a encaissée, et à quelle heure dans le fuseau du salon ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941372-verifying-payments
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/347-payment-transactions-article-1
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/204347940-Transaction-List-Report

### BM-VENTE-06 — La vente et le rendez-vous se retrouvent l'un depuis l'autre

- **Étape** : historique des ventes — lien au rendez-vous
- **Ce que voit l'utilisateur** : la vente cite la référence du rendez-vous qu'elle règle, et le rendez-vous ou la fiche client mène à la vente (« Voir la vente »).
- **Pourquoi** : relier l'argent à la prestation honorée.
- **À vérifier chez nous** : depuis une vente, retrouve-t-on le rendez-vous ? Depuis le rendez-vous, retrouve-t-on la vente ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/347-payment-transactions-article-1
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941439-issuing-refunds

## Remboursement et annulation

### BM-REMBOURS-01 — « Annuler » et « Rembourser » sont deux gestes distincts

- **Étape** : remboursement — choix du geste
- **Ce que voit l'utilisateur** : deux actions séparées ; l'annulation n'est proposée que tant que la vente n'est pas partie chez le prestataire de paiement, sinon seul le remboursement l'est ; l'effet sur le rendez-vous est annoncé.
- **Pourquoi** : on ne « supprime » pas une vente carte déjà transmise, et l'on sait ce que devient le rendez-vous.
- **À vérifier chez nous** : l'interface distingue-t-elle annulation et remboursement, et n'offre-t-elle que le geste possible ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/367-void-a-sale
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941479-voiding-orders
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018094500-How-do-I-undo-a-sale-transaction

### BM-REMBOURS-02 — Total par défaut, partiel par lignes ou par montant

- **Étape** : remboursement — montant
- **Ce que voit l'utilisateur** : le formulaire s'ouvre sur un remboursement total ; on peut le réduire en cochant des lignes ou en saisissant un montant, et le total remboursé se recalcule.
- **Pourquoi** : le geste commercial partiel ne demande ni calcul à la main ni second circuit.
- **À vérifier chez nous** : le cas le plus courant (tout rembourser) est-il celui par défaut ? Le partiel est-il possible sans calcul ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941439-issuing-refunds
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/9437107653266-How-do-I-refund-only-a-part-of-a-sale-Partial-refund
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6116-process-refunds

### BM-REMBOURS-03 — Un motif est demandé avant de rembourser

- **Étape** : remboursement — motif
- **Ce que voit l'utilisateur** : une liste « Motif du remboursement » à renseigner avant de valider ; « Autre » demande une précision libre.
- **Pourquoi** : chaque sortie d'argent laisse une trace exploitable.
- **À vérifier chez nous** : le remboursement demande-t-il un motif, et ce motif se relit-il ensuite dans la vente ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6116-process-refunds
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941439-issuing-refunds
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/18699473497115-Refund-Your-Customers-Transactions

### BM-REMBOURS-04 — Le remboursement repart par le moyen d'origine, choisi d'office

- **Étape** : remboursement — destination
- **Ce que voit l'utilisateur** : « Rembourser vers » présélectionne le moyen de paiement d'origine ; les autres moyens possibles sont visibles, les impossibles sont grisés.
- **Pourquoi** : pas de remboursement en espèces d'une vente carte par erreur — et Stripe ne rembourse que vers la carte d'origine.
- **À vérifier chez nous** : la destination du remboursement est-elle affichée, et le moyen d'origine choisi d'office ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941439-issuing-refunds
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/368-refund-a-sale
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360016375559-How-do-I-process-a-refund-or-return-for-a-client-s-product
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/18699473497115-Refund-Your-Customers-Transactions

### BM-REMBOURS-05 — Une confirmation qui dit que c'est irréversible, un bouton qui dit l'action

- **Étape** : remboursement — confirmation
- **Ce que voit l'utilisateur** : une fenêtre de confirmation dédiée, qui prévient que l'opération ne peut pas être défaite, et dont le bouton porte le nom de l'action (« Rembourser 45,00 € », « Annuler la vente ») plutôt que « OK ».
- **Pourquoi** : aucune sortie d'argent sur un clic distrait.
- **À vérifier chez nous** : le bouton final nomme-t-il l'action et le montant ? L'irréversibilité est-elle dite ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941479-voiding-orders
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/367-void-a-sale
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6116-process-refunds
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018094500-How-do-I-undo-a-sale-transaction

### BM-REMBOURS-06 — Le délai de crédit est annoncé, le client est prévenu

- **Étape** : remboursement — après validation
- **Ce que voit l'utilisateur** : le délai est affiché (plusieurs jours ouvrés pour une carte, immédiat en espèces) pour être répété au client, et le client reçoit un reçu ou un e-mail de remboursement.
- **Pourquoi** : moins d'appels « je n'ai pas été remboursée ».
- **À vérifier chez nous** : l'écran dit-il quand l'argent arrivera ? Le client en est-il informé ?
- **Sources** :
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941439-issuing-refunds
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/9437107653266-How-do-I-refund-only-a-part-of-a-sale-Partial-refund
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6116-process-refunds
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/18699473497115-Refund-Your-Customers-Transactions

### BM-REMBOURS-07 — La vente d'origine reste visible, avec son nouveau statut

- **Étape** : remboursement — trace
- **Ce que voit l'utilisateur** : après remboursement ou annulation, la vente reste dans l'historique avec le statut correspondant et le lien vers l'opération ; rien ne disparaît, et un montant se corrige en remboursant puis en recréant, jamais en éditant.
- **Pourquoi** : l'historique reste auditable.
- **À vérifier chez nous** : une vente remboursée reste-t-elle lisible, avec son remboursement rattaché ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/367-void-a-sale
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/173-edit-a-sale
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941479-voiding-orders

## Reçu

### BM-TICKET-01 — Le reçu s'ouvre sur l'identité de l'établissement et se termine par un numéro

- **Étape** : reçu — en-tête et référence
- **Ce que voit l'utilisateur** : en tête, le nom et l'adresse du salon repris de ses réglages ; un numéro de reçu qui se retrouve ensuite par la recherche de l'historique.
- **Pourquoi** : la cliente identifie la dépense sur son relevé, et le papier renvoie à une ligne précise de l'historique.
- **À vérifier chez nous** : le reçu nomme-t-il le salon et porte-t-il une référence qui se retrouve dans l'historique ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/133-customize-your-sales-receipt
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/100664-manage-receipt-sequencing
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5424-customize-digital-receipts-and-invoices
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5145-transaction-search

### BM-TICKET-02 — Des lignes détaillées, puis taxes et total

- **Étape** : reçu — corps
- **Ce que voit l'utilisateur** : chaque prestation ou produit avec sa quantité et son prix, puis les remises éventuelles, les taxes et le total, et le moyen de paiement.
- **Pourquoi** : la cliente vérifie ce qu'elle paie.
- **À vérifier chez nous** : le reçu détaille-t-il les lignes, ou ne donne-t-il qu'un total ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6139-print-receipts
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/171-share-and-print-sale-receipts

### BM-TICKET-03 — Le reçu s'imprime, s'envoie et se renvoie depuis la vente

- **Étape** : reçu — canaux
- **Ce que voit l'utilisateur** : le bouton « Reçu » propose d'imprimer (ticket ou A4/PDF) et d'envoyer par e-mail ; depuis l'historique, le reçu se renvoie, et le bouton confirme l'envoi (« Envoyé »).
- **Pourquoi** : on répond à une demande tardive sans recréer la vente, avec la preuve que l'envoi est parti.
- **À vérifier chez nous** : un reçu se renvoie-t-il depuis l'historique, et l'écran confirme-t-il l'envoi ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/6139-print-receipts
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941488-receipts-sending-printing-and-saving
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018125499-How-do-I-reprint-a-client-s-receipt
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/sales/171-share-and-print-sale-receipts
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360004487034-Reprint-a-Receipt-After-Checkout

## Reporting

### BM-RAPPORT-01 — Des raccourcis de période, et une plage libre

- **Étape** : reporting — période
- **Ce que voit l'utilisateur** : en tête du rapport, des raccourcis (« Aujourd'hui », « Hier », « Cette semaine », « Ce mois », « Mois précédent ») et une plage personnalisée par calendrier ; le rapport se met à jour à chaque choix.
- **Pourquoi** : les questions courantes se règlent en un clic.
- **À vérifier chez nous** : faut-il saisir deux dates pour voir « ce mois » ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/100652-access-your-performance-insights

### BM-RAPPORT-02 — Chaque indicateur se compare à la période précédente

- **Étape** : reporting — comparaison
- **Ce que voit l'utilisateur** : à côté de chaque valeur, sa comparaison à la période de même durée qui précède (« ce mois » contre le mois dernier).
- **Pourquoi** : un chiffre seul ne dit pas si l'activité monte ou baisse.
- **À vérifier chez nous** : le revenu et le volume de rendez-vous disent-ils leur évolution ?
- **Sources** :
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports

La forme de la variation (flèche, pourcentage, couleur) n'est documentée nulle
part : un constat sur ce motif porte sur la présence de la comparaison, pas sur
son dessin.

### BM-RAPPORT-03 — Le rapport dit sur quelle date et dans quel fuseau il compte

- **Étape** : reporting — base de calcul
- **Ce que voit l'utilisateur** : le rapport précise s'il compte à la date du rendez-vous ou à la date du paiement, que les deux bornes sont incluses, et que la journée se coupe à minuit dans le fuseau de l'établissement.
- **Pourquoi** : pas d'écart inexpliqué autour de minuit, ni entre deux rapports — c'est la règle « stocké en UTC, affiché dans le fuseau du salon » (ADR 0006) rendue visible.
- **À vérifier chez nous** : le rapport dit-il quelle date il retient et dans quel fuseau ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/338-sales-summary-article-1
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/345-payments-summary-article-1
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5072-summaries-and-reports-from-the-online-dashboard
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941479-voiding-orders

### BM-RAPPORT-04 — Chaque indicateur a une définition lisible

- **Étape** : reporting — définitions
- **Ce que voit l'utilisateur** : une définition écrite de chaque chiffre — ce qu'il inclut, ce qu'il exclut (ventes annulées, remboursements) — accessible depuis le rapport.
- **Pourquoi** : deux personnes lisent le même chiffre de la même façon.
- **À vérifier chez nous** : « revenu » et « taux de no-show » sont-ils définis à l'écran ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/338-sales-summary-article-1
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941389-reports-data-glossary
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it

Seul Phorest documente une définition **dans le produit** (infobulle) ; les
autres la donnent dans leur centre d'aide.

### BM-RAPPORT-05 — Le revenu se ventile par moyen de paiement, remboursements à part

- **Étape** : reporting — revenu
- **Ce que voit l'utilisateur** : un tableau par moyen de paiement — nombre, montant encaissé, remboursements, net — où les remboursements ont leurs propres colonnes au lieu d'être fondus dans le brut.
- **Pourquoi** : rapprocher les espèces du tiroir et la carte du relevé, et garder un brut comparable d'une période à l'autre.
- **À vérifier chez nous** : le revenu distingue-t-il carte et espèces ? Les remboursements sont-ils visibles à part ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/345-payments-summary-article-1
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018217719-Financial-Totals-report-overview
  - Boulevard · documenté · 2026-09-16 · https://support.boulevard.io/en/articles/5941389-reports-data-glossary

### BM-RAPPORT-06 — Un graphique par jour, semaine ou mois, et le tableau à côté

- **Étape** : reporting — visualisation
- **Ce que voit l'utilisateur** : un graphique regroupé par jour, semaine ou mois, avec une bascule vers le tableau des valeurs exactes ; un point du graphique mène au détail.
- **Pourquoi** : le graphique montre la tendance, le tableau donne les valeurs et reste accessible sans la vue.
- **À vérifier chez nous** : les valeurs du graphique sont-elles lisibles aussi en tableau ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/5381-in-app-summaries-and-reports
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/7541672247698-What-is-the-Insights-dashboard-and-how-do-I-use-it
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/358-sales-by-time-period-article-1
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360000550993-Appointments-Summary-Report

### BM-RAPPORT-07 — Le no-show se lit en taux et en liste nominative

- **Étape** : reporting — no-shows
- **Ce que voit l'utilisateur** : un taux de no-show sur la période, et la liste des rendez-vous concernés — date, client, praticien, prestation, qui a posé le statut et quand.
- **Pourquoi** : mesurer le no-show (objectif du MVP) et pouvoir agir sur les cas.
- **À vérifier chez nous** : derrière le taux, peut-on voir les rendez-vous qui le composent ?
- **Sources** :
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/344-performance-summary-article-1
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/7904-square-appointments-reporting
  - Vagaro · extrait · 2026-09-16 · https://support.vagaro.com/hc/en-us/articles/360000346733-Cancellations-No-Shows-Report

### BM-RAPPORT-08 — L'export reprend exactement ce qui est affiché

- **Étape** : reporting — export
- **Ce que voit l'utilisateur** : un bouton « Exporter » (CSV au minimum) sur le rapport, dont le fichier reprend la période et les filtres à l'écran.
- **Pourquoi** : ce qu'on transmet au comptable est ce qu'on regarde.
- **À vérifier chez nous** : l'export respecte-t-il la période et les filtres choisis ?
- **Sources** :
  - Square · documenté · 2026-09-16 · https://squareup.com/help/us/en/article/8362-print-export-or-email-your-reports
  - Fresha · documenté · 2026-09-16 · https://www.fresha.com/help-center/knowledge-base/reports/191-export-reports
  - Phorest · documenté · 2026-09-16 · https://support.phorest.com/hc/en-us/articles/360018217719-Financial-Totals-report-overview

## Vu, mais sans identifiant

Ces pratiques sont réelles et sourcées, mais n'ouvrent pas de ticket
`ds:standard` : elles ajoutent une fonctionnalité que le CDC §1.4 ne liste pas,
et leur absence n'est pas un écart de conception. À soumettre à
`mvp-scope-guard` avant d'en faire quoi que ce soit.

- **Remise manuelle** en montant ou en pourcentage, sur la ligne ou le panier
  (Fresha, Square, Boulevard, Vagaro).
- **Paiement fractionné** carte + espèces avec « reste à payer » jusqu'à zéro
  (Fresha, Phorest, Square, Boulevard).
- **Vente impayée ou partiellement payée**, soldée plus tard (Fresha,
  Boulevard).
- **Pied de reçu personnalisable** — politique d'annulation, remerciement
  (Fresha, Square, Boulevard, Vagaro).
- **Moyens de paiement personnalisés** — chèque, virement (Fresha, Square,
  Vagaro, Boulevard) : le CDC s'en tient à la carte et aux espèces.

## Frictions relevées chez les références

À ne pas reproduire — utiles pour écrire une recommandation :

- Chez Fresha, une vente impayée ne se modifie pas et un remboursement ne
  s'annule pas, **sans chemin guidé** vers la correction (remboursement puis
  nouvelle vente) : le principe est sain, l'absence de guidage ne l'est pas.
- Chez Phorest et Boulevard, des **totaux qui diffèrent d'un rapport à
  l'autre** demandent des articles d'aide entiers pour s'expliquer — c'est ce
  que BM-RAPPORT-03 et BM-RAPPORT-04 évitent.
- Chez Booker (extrait indexé, article non lu en entier), un rendez-vous réglé
  libère son créneau et peut laisser place à une **double réservation** —
  l'inverse de l'ADR 0002.

## Cadre réglementaire — à savoir, non citable ici

Le benchmark décrit le marché, pas la loi : ces points ne sont pas des motifs
et ne fondent pas de constat d'audit. Ils sont signalés pour que l'auditeur ne
recommande pas l'inverse.

- Depuis le 1er août 2023, le ticket de caisse n'est imprimé qu'à la demande,
  **sauf** pour les prestations de services d'au moins 25 €, dont la note reste
  remise systématiquement
  (https://entreprendre.service-public.gouv.fr/actualites/A16120). Une fin
  d'encaissement qui propose « aucun reçu » par défaut sur un soin de 25 € et
  plus irait contre ce texte.
- L'enregistrement de règlements en espèces de particuliers par un assujetti à
  la TVA emporte des obligations de **logiciel de caisse** (inaltérabilité,
  sécurisation, conservation, archivage) —
  https://www.impots.gouv.fr/professionnel/questions/quel-est-le-champ-dapplication-de-lobligation-de-detenir-un-logiciel-de.
  Son application à ce produit n'est pas tranchée ; c'est une question de
  périmètre et de conformité, pas de conception.
