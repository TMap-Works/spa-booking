variable "github_repository" {
  description = "Dépôt autorisé à assumer les rôles, au format `owner/repo`. C'est la restriction la plus importante du module : sans elle, n'importe quel dépôt GitHub du monde présente un jeton valide à `sts:AssumeRoleWithWebIdentity` et entre dans le compte AWS."
  type        = string
  default     = "TMap-Works/spa-booking"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Format attendu : `owner/repo`. Ni joker, ni chemin partiel — un sujet OIDC construit sur une valeur approximative autorise plus que prévu."
  }
}

variable "deployment_environments" {
  description = "Environnements GitHub dont les jobs peuvent assumer un rôle. Un job qui déclare `environment: dev` présente le sujet `repo:<dépôt>:environment:dev` — c'est cette forme, et non la branche, que porte alors le jeton OIDC."
  type        = set(string)
  default     = ["dev", "staging", "prod"]

  validation {
    condition     = length(var.deployment_environments) > 0
    error_message = "Sans environnement autorisé, aucun workflow de déploiement ne peut s'authentifier."
  }

  validation {
    condition     = alltrue([for env in var.deployment_environments : can(regex("^[a-z0-9-]+$", env))])
    error_message = "Un nom d'environnement se limite aux minuscules, chiffres et tirets — surtout pas de joker."
  }
}

variable "deployment_branches" {
  description = "Branches dont un workflow *sans* environnement GitHub peut assumer le rôle de déploiement. Vide par défaut, et ce n'est pas une précaution gratuite : le rôle de déploiement est unique pour les trois environnements — il pousse dans l'ECR de production, déroule les services `spa-prod-*` et prend l'instantané RDS. Un sujet `ref:refs/heads/<branche>` donnerait donc à n'importe quel job sans bloc `environment:` poussé sur cette branche les pleins droits de déploiement en production, sans passer par l'approbation manuelle de l'environnement `prod` — exactement ce que l'absence de `ref:refs/heads/main` cherche à empêcher. Les trois workflows `deploy-*` déclarent tous un `environment:` : aucun n'a besoin de cette forme de sujet."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for branch in var.deployment_branches : can(regex("^[A-Za-z0-9._/-]+$", branch))])
    error_message = "Un nom de branche ne contient ici ni joker ni espace : la politique de confiance compare le sujet à l'identique, un `*` y ouvrirait toutes les branches."
  }
}

variable "deployment_branch_policies" {
  description = "Branche autorisée à déployer chaque environnement GitHub. Le sujet OIDC d'un job qui déclare `environment: X` ne porte pas la branche : cette restriction-là s'applique côté GitHub, dans la politique de branches de déploiement de l'environnement. La valeur est reprise en sortie pour que la configuration attendue soit vérifiable, mais le module ne peut pas la poser à la place de GitHub."
  type        = map(string)
  default = {
    dev     = "develop"
    staging = "staging"
    prod    = "main"
  }
}

variable "existing_oidc_provider_arn" {
  description = "ARN d'un fournisseur d'identité GitHub déjà présent sur le compte. AWS n'en accepte qu'un seul par URL d'émetteur : si un autre projet l'a déjà créé, le renseigner ici plutôt que de laisser le module échouer sur `EntityAlreadyExists`. Laisser à `null` pour que le module le crée."
  type        = string
  default     = null
}

variable "oidc_thumbprints" {
  description = "Empreintes du certificat de l'émetteur. AWS ne les vérifie plus pour `token.actions.githubusercontent.com` depuis juillet 2023 — il s'appuie sur ses autorités de certification de confiance — mais l'API continue de les accepter et certains fournisseurs Terraform les exigent. Elles ne sont donc pas un secret et n'ont pas à être tenues à jour."
  type        = list(string)
  default = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

variable "role_prefix" {
  description = "Préfixe des noms de rôles. Ces rôles ne portent pas d'environnement dans leur nom, contrairement à la convention `spa-{env}-{composant}` : ils sont uniques pour le compte et servent les trois environnements, comme le module `bootstrap`."
  type        = string
  default     = "spa-github"

  validation {
    condition     = can(regex("^[a-zA-Z0-9+=,.@_-]{1,48}$", var.role_prefix))
    error_message = "Le préfixe doit respecter le jeu de caractères des noms de rôle IAM et laisser la place au suffixe (64 caractères au total)."
  }
}

variable "max_session_duration_seconds" {
  description = "Durée de vie maximale d'une session assumée. Un déploiement dure quelques minutes : rallonger cette valeur ne fait qu'allonger la fenêtre d'exploitation d'un jeton volé."
  type        = number
  default     = 3600

  validation {
    condition     = var.max_session_duration_seconds >= 900 && var.max_session_duration_seconds <= 43200
    error_message = "AWS n'accepte qu'une valeur comprise entre 900 et 43200 secondes."
  }
}

variable "container_services" {
  description = "Services conteneurisés déployés par les workflows `deploy-*`. Sert à construire les ARN exacts des dépôts ECR et des services ECS autorisés — c'est ce qui évite un `Resource: \"*\"` sur le rôle de déploiement."
  type        = set(string)
  default     = ["api", "web"]
}

variable "ecs_cluster_names" {
  description = "Nom du cluster ECS de chaque environnement de `deployment_environments`, tel que `modules/ecs-service` le crée — c'est-à-dire la valeur de sa sortie `cluster_name`, reportée ici pour l'environnement correspondant. Ce module s'applique depuis une racine d'administration distincte de `envs/<env>`, dont l'état ne lui est pas accessible : à défaut de pouvoir lire la sortie, la valeur littérale convient, ce qui compte étant qu'elle soit écrite une fois au vu du module qui crée le cluster, et non déduite ici. Pas de valeur par défaut, délibérément : le module reconstruisait auparavant ce nom à la main en `spa-<env>` alors que `modules/ecs-service` nomme le cluster `spa-<env>-cluster`, si bien que les ARN de la politique de déploiement désignaient des ressources inexistantes et que `ecs:UpdateService`, `ecs:RunTask` et `ecs:DescribeTasks` revenaient en `AccessDenied` (#198). Un défaut rétablirait la duplication qui a produit l'écart, et le ferait en silence."
  type        = map(string)

  # Obligatoire *et* non nul. Avec `nullable` à sa valeur par défaut — `true` —,
  # un appelant qui relaie sa propre variable optionnelle (`ecs_cluster_names =
  # var.cluster_names`, nulle) ferait échouer `length(null)` sur « invalid value
  # for "v": argument must not be null », sans jamais atteindre le message de la
  # validation ci-dessous ni celui de la précondition. Refuser le nul ici, c'est
  # garder l'erreur lisible.
  nullable = false

  validation {
    condition     = length(var.ecs_cluster_names) > 0
    error_message = "Nommer le cluster ECS de chaque environnement de déploiement : sans lui, la politique du rôle de déploiement ne peut désigner ni le cluster, ni ses services, ni ses tâches."
  }

  validation {
    condition     = alltrue([for name in values(var.ecs_cluster_names) : can(regex("^[A-Za-z0-9_-]{1,255}$", name))])
    error_message = "Un nom de cluster ECS se limite à 255 caractères parmi lettres, chiffres, tirets et soulignés. Ce qui est attendu ici est un **nom** (`spa-dev-cluster`), pas un ARN ni un identifiant de cluster — l'ARN est composé par le module."
  }
}

variable "production_environment" {
  description = "Environnement considéré comme la production. Seul son rôle reçoit le droit de prendre un instantané RDS avant déploiement ; les autres ne l'ont pas."
  type        = string
  default     = "prod"
}

variable "terraform_managed_policy_arns" {
  description = "Politiques attachées au rôle Terraform d'`apply`. `AdministratorAccess` par défaut, et c'est assumé : Terraform crée ici des rôles IAM, des clés KMS, des bases RDS et des VPC — toute politique plus étroite se traduirait par un `apply` qui échoue à mi-parcours en laissant l'infrastructure à moitié posée. Le confinement vient de la politique de confiance (trois environnements, un dépôt) et de l'approbation manuelle sur `prod`, pas de l'étendue des droits."
  type        = list(string)
  default     = ["arn:aws:iam::aws:policy/AdministratorAccess"]
}

variable "terraform_plan_managed_policy_arns" {
  description = "Politiques attachées au rôle Terraform de `plan`. En lecture seule : ce rôle est assumé depuis un job `pull_request`, donc à partir de code non encore relu. Un `plan` peut exécuter un `provisioner local-exec` ou une source de données externe — lui donner les droits d'`apply` reviendrait à donner l'administration du compte à quiconque ouvre une pull request."
  type        = list(string)
  default     = ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
}

variable "state_bucket_prefix" {
  description = "Préfixe des buckets d'état Terraform, tel que défini par le module `bootstrap`. Le rôle de `plan` reçoit l'accès aux buckets `<prefix>-<env>-tfstate` et à eux seuls."
  type        = string
  default     = "spa-booking"
}

variable "lock_table_prefix" {
  description = "Préfixe des tables DynamoDB de verrouillage, tel que défini par le module `bootstrap`. `terraform plan` pose un verrou comme `apply` : le rôle de lecture doit pouvoir écrire dans `<prefix>-<env>-tflock`, et nulle part ailleurs."
  type        = string
  default     = "spa"
}

variable "state_kms_key_arns" {
  description = "Clés KMS chiffrant les états Terraform, en **ARN complets** : une politique IAM refuse un UUID nu en `Resource`, or l'amorçage n'expose que les identifiants (`state_kms_key_ids`). Les composer en `arn:<partition>:kms:<région>:<compte>:key/<uuid>`. Laisser vide retombe sur `*`, borné à la fois par `kms:ViaService` (S3 et DynamoDB seulement) et par `kms:ResourceAliases` (les clés portant l'alias `<state_kms_alias_prefix>-<env>-tfstate`) : c'est le repli qui permet d'appliquer ce module avant l'amorçage, pas la cible."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.state_kms_key_arns : can(regex("^arn:[a-z0-9-]+:kms:", arn))])
    error_message = "Des ARN de clé KMS sont attendus (`arn:<partition>:kms:<région>:<compte>:key/<uuid>`). La sortie `state_kms_key_ids` de l'amorçage ne donne que les UUID : les composer en ARN avant de les passer ici."
  }
}

variable "state_kms_alias_prefix" {
  description = "Préfixe des alias de clé KMS posés par le module `bootstrap` (`alias/<prefix>-<env>-tfstate`). Sert à borner le repli `*` de `state_kms_key_arns` aux seules clés d'état, tant que leurs ARN ne sont pas connus."
  type        = string
  default     = "spa"
}

variable "protect_oidc_resources" {
  description = "Interdit au rôle Terraform de modifier le fournisseur d'identité et les rôles créés ici. Sans ce garde-fou, un `apply` détourné pourrait élargir sa propre politique de confiance à `*` et s'ouvrir un accès permanent. Conséquence à connaître : ce module doit alors être appliqué par une identité d'administrateur, pas par la CI."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Étiquettes supplémentaires. `Project`, `ManagedBy` et `Owner` sont attendues via `default_tags` du provider appelant."
  type        = map(string)
  default     = {}
}
