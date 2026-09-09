output "bucket_name" {
  description = <<-EOT
    Nom du bucket d'exports. C'est la valeur à poser dans `REPORT_EXPORT_BUCKET`
    sur la définition de tâche de l'API — sans elle, la route d'export répond 503
    et les trois routes de lecture continuent de servir.

    Ce n'est **pas** un secret : un nom de bucket n'accorde aucun droit à qui le
    connaît, et le bucket refuse tout principal hors du compte.
  EOT
  value       = aws_s3_bucket.exports.id
}

output "bucket_arn" {
  description = "ARN du bucket — à nommer dans une politique qui aurait besoin d'y accéder autrement que par `producer_policy_arn`."
  value       = aws_s3_bucket.exports.arn
}

output "export_prefix" {
  description = "Préfixe sous lequel l'API dépose (`exports`). Les clés y sont préfixées par le `tenant_id` — voir `apps/api/src/modules/reporting/export/report-export.key.ts`."
  value       = local.export_prefix
}

output "producer_policy_arn" {
  description = <<-EOT
    Politique à attacher au rôle de tâche de l'API : déposer un export, et signer
    sa lecture. Elle n'accorde ni `ListBucket`, ni `DeleteObject`.

    À passer dans `task_role_policy_arns` du service `api` du module
    `ecs-service`.
  EOT
  value       = aws_iam_policy.producer.arn
}

output "retention_days" {
  description = "Nombre de jours au bout desquels un export est supprimé par le cycle de vie. Rendu pour être vérifiable sans ouvrir le module."
  value       = var.retention_days
}

output "encryption_algorithm" {
  description = "Chiffrement au repos effectivement appliqué : `aws:kms` quand une clé client est fournie, `AES256` sinon. Dans les deux cas, le bucket est chiffré."
  value       = local.customer_managed_key ? "aws:kms" : "AES256"
}
