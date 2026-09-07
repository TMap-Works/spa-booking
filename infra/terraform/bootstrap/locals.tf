data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  # Un seul bucket d'audit pour le compte entier, et non un par environnement :
  # CloudTrail comme AWS Config sont des services à portée de compte, et leurs
  # journaux décrivent des appels d'API qui ne se rangent dans aucun
  # environnement — une création de rôle IAM n'appartient ni à dev ni à prod.
  #
  # Les noms de bucket S3 sont uniques au niveau mondial : si celui-ci est déjà
  # pris, `state_bucket_prefix` le déplace en même temps que les buckets d'état.
  audit_bucket_name = "${var.state_bucket_prefix}-audit-logs"

  cloudtrail_name = "spa-account-trail"

  # ARN de la trace, construit et non lu sur la ressource. C'est ce qui évite un
  # cycle : la politique de la clé KMS et celle du bucket doivent nommer la trace
  # dans leur condition `aws:SourceArn`, alors que la trace, elle, ne peut être
  # créée qu'une fois la clé et le bucket en place.
  cloudtrail_arn = "arn:${data.aws_partition.current.partition}:cloudtrail:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:trail/${local.cloudtrail_name}"

  # Préfixes de clé dans le bucket d'audit. Séparés parce que les deux services
  # écrivent sous des chemins qu'ils imposent (`AWSLogs/<compte>/…`) et que les
  # politiques doivent nommer exactement — un préfixe commun rendrait impossible
  # d'autoriser Config sans autoriser du même geste l'écriture dans les journaux
  # CloudTrail, qui sont la trace que l'on cherche justement à protéger.
  cloudtrail_prefix = "cloudtrail"
  config_prefix     = "config"
}
