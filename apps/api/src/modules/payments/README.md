# Module `payments`

Encaissement et tokenisation (CDC §2.3). C'est l'étape « encaisser » de la
boucle de valeur du MVP, et le module dont la conception est **contrainte par la
conformité** autant que par le métier : tout ce qui suit existe pour maintenir
notre périmètre PCI en SAQ A.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #57 | L'intention de paiement Stripe, la clé publiable, et la frontière qui les sépare de la clé secrète |

À venir : les webhooks signés et idempotents (#58), le POS et ses lignes de
vente (#60, #62), les remboursements (#63).

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `POST` | `/api/v1/public/:tenantSlug/payments/intents` | — (ouverte) |

La route n'est pas gardée, et c'est délibéré : on réserve sans compte (#37),
donc on paie sans compte. Ce qui autorise l'appel est la **connaissance de
l'identifiant** du rendez-vous — un UUID v4 remis à la cliente sur son écran de
confirmation et dans son e-mail. C'est exactement le régime du report et de
l'annulation du même tunnel.

Ce qui la tient, faute de garde :

1. le `ValidationPipe` global, `whitelist` **et** `forbidNonWhitelisted` — le
   corps ne porte qu'un `appointmentId`, tout le reste fait rejeter la requête ;
2. `TenantScopeMiddleware`, qui résout le `:tenantSlug` contre la table
   `tenants` avant le contrôleur ;
3. le scoping Prisma, qui rend le rendez-vous d'un autre salon **introuvable**,
   pas interdit ;
4. `ThrottlerGuard` — cette route écrit et appelle un tiers ; sans quota, notre
   API deviendrait un amplificateur d'appels vers Stripe.

## La frontière PCI, en un coup d'œil

**Aucune donnée de carte n'atteint ce module**, et cela se vérifie en trois
endroits plutôt que dans un commentaire :

| Où | Ce qui l'empêche |
|---|---|
| `dto/create-payment-intent.dto.ts` | un seul champ déclaré ; un PAN dans le corps est un 400 avant tout code métier |
| `payments.types.ts` | le domaine n'a aucune notion de carte — pas de champ où en ranger une |
| `stripe/stripe.gateway.ts` | le port n'a pas de paramètre pour en recevoir ; `automatic_payment_methods` délègue la saisie aux iframes de Stripe |

Ce que nous conservons, et rien d'autre : l'identifiant Stripe, le montant, la
devise, le statut. La marque et les quatre derniers chiffres viendront du
webhook (#58), s'ils viennent.

## Les deux clés, et laquelle sort

| Clé | Où elle vit | Qui la voit |
|---|---|---|
| `STRIPE_SECRET_KEY` | AWS Secrets Manager → variable de tâche ECS | le conteneur d'API, pour l'en-tête `Authorization` et rien d'autre |
| `STRIPE_PUBLISHABLE_KEY` | la même source | le navigateur, rendue **par l'API** avec l'intention |

`stripe.config.ts` vérifie les préfixes `sk_`/`pk_` : l'inversion des deux
variables est l'erreur de déploiement la plus banale, et la seule qui envoie un
accès complet au compte Stripe du salon dans une réponse HTTP publique.

| | Clé mal préfixée | Configuration incomplète | Aucune clé |
|---|---|---|---|
| `staging`, `production` | refus de démarrer | refus de démarrer | refus de démarrer |
| `development`, `test` | refus de démarrer | démarre, paiements 503 | démarre, paiements 503 |

Le préfixe est la seule faute refusée **partout** : c'est celle qui expose le
compte. L'incomplétude, elle, n'immobilise que le déploiement — en local, elle
décrit un poste qui n'encaisse pas, ou dont l'environnement porte une variable
`STRIPE_*` héritée d'un autre projet. Refuser de démarrer pour cela aurait coûté
les sept autres modules, `AppModule` les montant tous.

## Ce que ce module ne fait pas

- **Il ne confirme rien.** Il crée une intention et rend de quoi la payer. Le
  passage du rendez-vous en `CONFIRMED` et du paiement en `SUCCEEDED` est
  l'affaire du webhook signé (#58) : la source de vérité du paiement est Stripe
  reçue côté serveur, jamais la réponse du navigateur (payments-stripe §2).
- **Il n'encaisse pas au comptoir.** Espèces, produits retail et lignes de vente
  sont #60 et #62, sur une surface gardée.
- **Il ne rembourse pas.** #63.

## Idempotence — trois mécanismes, du plus rapide au plus sûr

1. la ligne `payments` déjà présente, reprise en relisant son intention chez
   Stripe (le `client_secret` n'est pas conservé : rien côté serveur n'a à le
   relire) ;
2. la clé d'idempotence Stripe, dérivée du couple (établissement, rendez-vous),
   qui rend l'intention déjà créée quand deux requêtes se croisent ;
3. `@@unique([tenantId, appointmentId])`, qui tranche la course perdue par
   l'insertion et renvoie le perdant sur la ligne du gagnant.

Un double clic ne produit donc jamais deux débits, et ce n'est pas la vigilance
du service qui le garantit — c'est la base et le prestataire. Quand Stripe
refuse la clé parce qu'une requête portant la même est encore en vol
(`409 idempotency_error`), le service relit la ligne avant de conclure : le
deuxième clic reprend l'intention du premier au lieu de recevoir un 503.

## Reprise — ce qui se rejoue et ce qui est clos

| État de la ligne | Reprise |
|---|---|
| `PENDING` | oui — tunnel abandonné, onglet rouvert |
| `FAILED` | **oui** — la carte a été refusée, l'intention Stripe attend l'autre |
| `SUCCEEDED`, `REFUNDED`, `PARTIALLY_REFUNDED` | non, 409 |
| espèces au comptoir (pas d'intention) | non, 409 |

`FAILED` est le cas qui compte : `@@unique([tenantId, appointmentId])` interdit
d'inscrire une seconde ligne, donc le traiter comme clos rendrait le rendez-vous
impayable pour toujours — au comptoir compris.

La relecture chez Stripe ne sert d'ailleurs pas qu'à récupérer le
`client_secret` : si Stripe répond `succeeded` ou `canceled` pendant que notre
ligne dit encore `PENDING` — un webhook en retard —, c'est Stripe qui fait foi et
la reprise est refusée.

## Dette connue

`PaymentsRepository` lit la table `appointments` directement, pour le prix figé
à la réservation. Le chemin conforme serait un appel de service
(`AppointmentsService`, api-module §3), mais ce module n'expose aujourd'hui
aucune lecture par identifiant. La lecture est bornée à trois colonnes non
personnelles et n'écrit rien ; une issue de suivi porte la reprise.
