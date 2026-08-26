output "repository_names" {
  description = "Nom de chaque dépôt, par application — `{ api = \"spa-dev-api\" }`. C'est ce que les workflows de déploiement construisent pour étiqueter puis pousser leurs images."
  value       = { for app, repo in aws_ecr_repository.this : app => repo.name }
}

output "repository_urls" {
  description = "URL de chaque dépôt, par application — `<compte>.dkr.ecr.<région>.amazonaws.com/spa-dev-api`. Suffixée de `:<étiquette>`, c'est la valeur attendue par l'attribut `image` du module ecs-service."
  value       = { for app, repo in aws_ecr_repository.this : app => repo.repository_url }
}

output "repository_arns" {
  description = "ARN de chaque dépôt, par application. À passer en `ecr_repository_arn` au module ecs-service : c'est ce qui limite le droit de tirage du rôle d'exécution de chaque service à son propre dépôt, au lieu de tout le registre du compte."
  value       = { for app, repo in aws_ecr_repository.this : app => repo.arn }
}

output "registry_id" {
  description = "Identifiant du registre — l'identifiant du compte AWS propriétaire des dépôts. Le registre est unique par compte et par région : tous les dépôts du module rendent la même valeur, le premier suffit donc à la porter. `applications` en garantit au moins un."
  value       = values(aws_ecr_repository.this)[0].registry_id
}

output "kms_key_arn" {
  description = "Clé KMS qui chiffre les couches d'image au repos. Le rôle d'exécution ECS n'a **pas** besoin de `kms:Decrypt` dessus pour tirer une image : ECR crée ses propres grants sur la clé et déchiffre les couches lui-même. Cette sortie sert à l'audit et à la rotation ; voir le README avant de la passer en `kms_key_arn` au module ecs-service, qui n'en accepte qu'une."
  value       = local.kms_key_arn
}

output "image_scanning_enabled" {
  description = "Vrai — le scan de vulnérabilités à la publication est actif sur tous les dépôts et n'est pas désactivable. Cette sortie existe pour qu'un environnement puisse l'affirmer dans un contrôle, pas pour qu'il en dépende conditionnellement."
  value       = true
}
