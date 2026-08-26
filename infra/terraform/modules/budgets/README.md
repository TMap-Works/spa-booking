# budgets — plafond mensuel, alertes et ventilation de la facture

Ce module pose le garde-fou budgétaire du CDC §4.16 : un budget mensuel par
environnement, notifié à 80 % et 100 % de son plafond, et la ventilation de la
facture par environnement dans Cost Explorer.

Il ne fait rien d'autre, et surtout il **n'arrête aucune dépense** — AWS Budgets
observe et notifie. Toute sa valeur est dans le délai entre le moment où la
dépense dérive et celui où quelqu'un l'apprend. C'est ce qui justifie de le poser
au premier jour plutôt qu'au premier relevé.

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Budget AWS | `spa-{env}-monthly` | Plafond mensuel filtré sur l'étiquette `Environment` |
| Notifications | une par seuil | 80 % et 100 % de la dépense constatée |
| Topic SNS | `spa-{env}-budget-alerts` | Canal des alertes, réutilisable par les alarmes CloudWatch |
| Politique de topic | — | Publication ouverte à `budgets.amazonaws.com`, gardée par `aws:SourceAccount` |
| Abonnements SNS | un par adresse | Optionnels — voir « Confirmer un abonnement » |
| Étiquettes de répartition | — | Uniquement là où `cost_allocation_tag_keys` est renseigné |

## Composition

```hcl
module "budgets" {
  source = "../../modules/budgets"

  environment   = local.environment
  monthly_limit = 800
  alert_emails  = var.budget_alert_emails
}
```

Un seul environnement — `prod` — active en plus les étiquettes de répartition de
coûts, parce que cette activation vaut pour le **compte entier** :

```hcl
  cost_allocation_tag_keys = ["Environment", "ManagedBy", "Owner", "Project"]
```

## Pourquoi un filtre d'étiquette

Les trois environnements partagent un compte AWS. Un budget sans filtre y
mesurerait la même facture trois fois, et l'alerte de `dev` se déclencherait sur
la dépense de `prod`.

Le filtre vaut `user:Environment$dev` — la forme qu'attend l'API Budgets. Il
s'appuie sur l'étiquette que `default_tags` pose sur tout ce que l'environnement
crée (skill aws-infra §2) : **un budget qui reste à zéro est presque toujours le
symptôme d'une ressource non étiquetée**, pas d'un environnement gratuit. La
sortie `budget_cost_filter` donne la valeur exacte à comparer aux `default_tags`.

Deux dépenses échappent par construction à ce découpage :

- ce qui n'est étiqueté par personne — un transfert de données inter-régions,
  une taxe, un poste de support ;
- les crédits et remboursements, qui s'appliquent au compte et non à une
  ressource. Ils sont **exclus** de la dépense mesurée
  (`include_credits_and_refunds`), faute de quoi un crédit sans rapport ferait
  redescendre le budget d'un environnement et taire son alerte.

La somme des trois budgets est donc un minorant de la facture, jamais son total.

## Pourquoi un topic SNS plutôt que des adresses

`aws_budgets_budget` accepte des adresses de courriel directement. Le module ne
s'en sert pas : le topic rend le canal indépendant de ses destinataires.

- ajouter, retirer ou rediriger un destinataire ne touche pas au budget ;
- le même topic portera les alarmes CloudWatch de l'observabilité (skill
  aws-infra §8) plutôt qu'un second canal à administrer ;
- le topic existe même sans destinataire, ce qui permet à `alert_emails` d'être
  vide par défaut. Une liste d'adresses n'a pas à être versionnée pour que
  l'infrastructure soit complète.

### Confirmer un abonnement

Un abonnement SNS par courriel n'est actif qu'**après confirmation** par son
destinataire. Terraform le crée, il ne peut pas le confirmer : l'abonnement reste
en `PendingConfirmation` et l'adresse ne reçoit rien jusque-là. La sortie
`alert_email_subscription_arns` le montre — un ARN valant `pending confirmation`
est un destinataire qui ne sera pas prévenu.

### Le topic n'est pas chiffré

Exception assumée, annotée dans le code. Le chiffrement SNS exige une clé gérée
par le client : la clé gérée par AWS ne peut pas recevoir la politique
qui autorise `budgets.amazonaws.com` à produire une clé de données, et la
publication échouerait. Il faudrait donc une clé KMS dédiée — 1 USD par mois et
par environnement — pour protéger un message dont tout le contenu est « le budget
de dev a dépassé 80 % ». Le module chargé de surveiller la dépense n'a pas à en
créer une permanente pour ce résultat.

## Les seuils portent sur la dépense constatée

`notification_type = "ACTUAL"` : l'alerte se déclenche sur ce qui est facturé, pas
sur une prévision. Une alerte prévisionnelle extrapole le rythme du mois en
cours — un `terraform apply` un peu large le premier jour suffit à la faire
crier, et le MVP n'a pas encore l'historique de facturation qui la rendrait
fiable. Le jour où cet historique existera, un seuil prévisionnel se posera en
ajoutant un type de notification, sans changer le reste du montage.

## Cost Explorer et les étiquettes de répartition

Poser une étiquette ne suffit pas : tant qu'elle n'est pas **activée comme
étiquette de répartition de coûts**, Cost Explorer la connaît mais refuse de
regrouper la dépense dessus.

Cette activation est globale au compte. Si les trois environnements la
déclaraient, le dernier `apply` gagnerait en écrasant les deux autres — le même
raisonnement que celui qui tient le scan « enhanced » hors du module `ecr`. Un
seul environnement la porte donc.

Elle ne vaut par ailleurs **que pour l'avenir** : AWS ne rétro-applique pas une
étiquette aux mois déjà facturés, et les données mettent jusqu'à 24 heures à
apparaître. C'est la raison d'activer au premier jour.

> **Le premier `apply` sur un compte neuf peut échouer ici.** Une clé n'est
> activable qu'une fois que la facturation l'a découverte — après qu'une
> ressource l'a portée et que la journée de facturation a été traitée. Terraform
> s'arrête alors sur une clé inconnue. Ce n'est pas une erreur de configuration :
> le reste de l'environnement est créé, et relancer l'`apply` le lendemain
> suffit. C'est aussi le principal argument pour que l'activation finisse dans
> `bootstrap`, appliqué une fois et bien avant les environnements.

> Sa place naturelle serait `infra/terraform/bootstrap`, le seul état déjà à
> portée de compte. Elle est ici faute de pouvoir y toucher dans le périmètre de
> cette itération — voir la note « Ce que ce module ne fait pas ».

## Variables

| Variable | Défaut | Remarque |
|---|---|---|
| `environment` | — | Entre dans les noms et dans le filtre d'étiquette |
| `monthly_limit` | — | Dénominateur des seuils, pas un plafond de dépense |
| `currency` | `USD` | Code ISO 4217 ; la facture du compte est en USD |
| `time_period_start` | `null` | `null` = premier jour du mois courant |
| `alert_thresholds_percent` | `[80, 100]` | Pourcentages du plafond, sans doublon |
| `alert_emails` | `[]` | Abonnements à confirmer par leur destinataire |
| `environment_tag_key` | `Environment` | Doit correspondre aux `default_tags` |
| `include_credits_and_refunds` | `false` | Non étiquetés, donc hors périmètre d'un budget filtré |
| `cost_allocation_tag_keys` | `[]` | Global au compte — un seul environnement le renseigne |

## Sorties

| Sortie | Usage |
|---|---|
| `budget_name` | Nom sous lequel le budget apparaît dans les alertes |
| `budget_limit` | Plafond et devise enregistrés côté AWS |
| `budget_cost_filter` | À comparer aux `default_tags` quand un budget reste à zéro |
| `alert_thresholds_percent` | Seuils effectivement posés |
| `alerts_topic_arn` | Point de branchement des alarmes CloudWatch à venir |
| `alerts_topic_name` | Nom du topic |
| `alert_email_subscription_arns` | Repère les abonnements non confirmés |
| `cost_allocation_tag_keys` | Étiquettes activées par cet environnement |

## Services globaux

Budgets et Cost Explorer n'existent qu'une fois par compte et sont signés pour
`us-east-1`, quelle que soit la région du provider. Rien à configurer — mais cela
explique qu'un budget n'apparaisse pas dans la console régionale d'`eu-west-3` :
il se consulte depuis la console Billing.

## Ce que ce module ne fait pas

- **Il n'empêche aucune dépense.** Aucun service AWS ne le fait à partir d'un
  budget. Couper une dépense qui dérive demande une action — arrêter un
  environnement hors heures ouvrées, réduire un dimensionnement — que personne ne
  déclenche automatiquement au MVP.
- **Il ne pose pas d'alarme CloudWatch.** Les seuils techniques du skill
  aws-infra §8 — 5xx de l'ALB, latence p99, CPU ECS, connexions RDS, profondeur
  de DLQ — relèvent du module `observability`, qui n'existe pas encore. Le topic
  créé ici est fait pour les accueillir.
- **Il ne fixe pas la rétention des journaux CloudWatch.** Elle appartient au
  module qui crée chaque groupe de journaux ; les environnements la passent
  explicitement (30 jours hors production, 90 en production).
- **Il ne détecte pas les anomalies de coût.** `aws_ce_anomaly_monitor` alerterait
  sur une dérive brutale sans plafond à atteindre. C'est un complément utile, pas
  un prérequis du MVP.
- **Il n'appartient pas à `bootstrap`.** L'activation des étiquettes de
  répartition y aurait sa place — c'est le seul état à portée de compte — mais
  `bootstrap` est hors du périmètre de fichiers de cette itération. Le déplacement
  fait l'objet d'une issue de suivi ; d'ici là, l'activation est portée par le
  seul environnement `prod`.
