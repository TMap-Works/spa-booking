# budgets — plafond mensuel et alertes

Ce module pose le garde-fou budgétaire du CDC §4.16 : un budget mensuel par
environnement, notifié à 80 % et 100 % de son plafond.

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

## Composition

```hcl
module "budgets" {
  source = "../../modules/budgets"

  environment   = local.environment
  monthly_limit = 800
  alert_emails  = var.budget_alert_emails
}
```

Rien de plus, et rien qui varie d'un environnement à l'autre en dehors du
plafond : l'activation des étiquettes de répartition de coûts, dont ce filtre
dépend, est un réglage de compte porté par `infra/terraform/bootstrap`.

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

## Le filtre dépend d'une activation faite ailleurs

Poser une étiquette ne suffit pas : tant qu'elle n'est pas **activée comme
étiquette de répartition de coûts**, Cost Explorer la connaît mais refuse de
regrouper la dépense dessus, et le filtre ci-dessus ne mesure rien.

Cette activation est globale au compte, pas propre à un environnement. Elle est
donc portée par [`infra/terraform/bootstrap`](../../bootstrap/README.md), le seul
état de ce dépôt à cette portée, qui active `Environment`, `ManagedBy`, `Owner` et
`Project` — même raisonnement que celui qui tient le scan « enhanced » hors du
module `ecr`.

Un budget qui reste à zéro alors que l'environnement dépense a donc deux causes
possibles : une ressource non étiquetée, ou un amorçage dont le bloc d'étiquettes
n'a jamais été appliqué. La sortie `cost_allocation_tag_keys` de `bootstrap`
tranche entre les deux.

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

## Services globaux

Budgets n'existe qu'une fois par compte et est signé pour `us-east-1`, quelle que
soit la région du provider. Rien à configurer — mais cela explique qu'un budget
n'apparaisse pas dans la console régionale d'`eu-west-3` : il se consulte depuis
la console Billing.

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
- **Il n'active pas les étiquettes de répartition de coûts.** Ce réglage vaut pour
  le compte entier : composé une fois par environnement, ce module ferait gagner
  le dernier `apply` en écrasant silencieusement les deux autres. Il appartient à
  [`infra/terraform/bootstrap`](../../bootstrap/README.md), qui le porte — un seul
  état, appliqué bien avant que les budgets d'environnement n'aient besoin du
  filtre.

  Ce module l'a porté un temps, et le déplacement laisse une trace dans l'état de
  tout environnement déjà appliqué : `module.budgets.aws_ce_cost_allocation_tag`
  y subsiste, et son prochain `apply` le **détruit**, ce qui repasse les clés en
  `Inactive` pour le compte entier. Le sortir de l'état — sans le détruire —
  avant tout autre `apply`, depuis le répertoire de l'environnement :

  ```bash
  terraform state rm 'module.budgets.aws_ce_cost_allocation_tag.this'
  ```
