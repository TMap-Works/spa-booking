data "aws_caller_identity" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  # Le nom d'un bucket S3 est **unique à l'échelle du monde**, pas du compte :
  # `spa-dev-reporting-exports` serait pris par le premier lecteur de ce dépôt
  # qui déploierait avant nous. L'identifiant de compte suffit à le rendre nôtre,
  # et il ne divulgue rien qu'un ARN ne divulgue déjà.
  bucket_name = "${local.name_prefix}-reporting-exports-${data.aws_caller_identity.current.account_id}"

  # Le préfixe sous lequel l'API dépose, et le seul que la politique ouvre.
  # Il doit rester identique à `REPORT_EXPORT_KEY_PREFIX` de
  # `apps/api/src/modules/reporting/export/report-export.key.ts` : c'est un
  # contrat entre deux dépôts de code qui ne se compilent pas ensemble, et une
  # divergence se manifesterait par des `AccessDenied` à l'exécution.
  export_prefix = "exports"

  # Vrai quand l'exploitant fournit une clé gérée par le client. Le module ne
  # crée aucune clé de lui-même : une clé KMS créée par un module et détruite
  # avec lui emporte la lisibilité de tout ce qu'elle a chiffré, et ce module est
  # justement celui d'un environnement qu'on recrée.
  customer_managed_key = var.kms_key_arn != null
}
