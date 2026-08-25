output "oidc_provider_arn" {
  description = "ARN du fournisseur d'identité GitHub Actions, créé ici ou repris de `existing_oidc_provider_arn`."
  value       = local.oidc_provider_arn
}

output "deploy_role_arn" {
  description = "Rôle assumé par les workflows deploy-*. À poser dans la variable de dépôt `AWS_DEPLOY_ROLE_ARN`."
  value       = aws_iam_role.deploy.arn
}

output "terraform_role_arn" {
  description = "Rôle assumé par le job `apply` du workflow Terraform. À poser dans la variable de dépôt `AWS_TERRAFORM_ROLE_ARN`."
  value       = aws_iam_role.terraform.arn
}

output "terraform_plan_role_arn" {
  description = "Rôle en lecture seule assumé par le job `plan` du workflow Terraform. À poser dans la variable de dépôt `AWS_TERRAFORM_PLAN_ROLE_ARN`."
  value       = aws_iam_role.terraform_plan.arn
}

# Une politique de confiance ne se relit pas facilement dans la console : cette
# sortie met les sujets autorisés à plat, pour qu'une revue puisse constater d'un
# coup d'œil qu'aucun joker ni aucun autre dépôt ne s'y est glissé.
output "trusted_subjects" {
  description = "Sujets OIDC acceptés, par rôle. Comparaison stricte : tout sujet absent de ces listes se voit refuser `sts:AssumeRoleWithWebIdentity`."
  value = {
    deploy         = local.deploy_subjects
    terraform      = local.terraform_apply_subjects
    terraform_plan = local.terraform_plan_subjects
  }
}

output "github_repository_variables" {
  description = "Variables de dépôt GitHub à poser pour activer les workflows. Ce sont des `vars`, pas des `secrets` : un ARN de rôle n'est pas un secret, et le garder hors des secrets rend visible qu'aucun identifiant AWS n'y est stocké."
  value = {
    AWS_DEPLOY_ROLE_ARN         = aws_iam_role.deploy.arn
    AWS_TERRAFORM_ROLE_ARN      = aws_iam_role.terraform.arn
    AWS_TERRAFORM_PLAN_ROLE_ARN = aws_iam_role.terraform_plan.arn
  }
}

# Le sujet d'un job qui déclare `environment: X` ne porte pas la branche : la
# restriction par branche des déploiements se fait donc côté GitHub, par la
# politique de branches de déploiement de l'environnement. Cette sortie rappelle
# quelle branche doit être autorisée sur quel environnement — le module ne peut
# pas le faire à la place de GitHub.
output "expected_deployment_branch_policies" {
  description = "Branche attendue par environnement GitHub, à refléter dans la politique de branches de déploiement de chaque environnement."
  value       = var.deployment_branch_policies
}
