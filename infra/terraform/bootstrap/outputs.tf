output "state_bucket_names" {
  description = "Nom du bucket d'état, par environnement."
  value       = { for env in var.environments : env => aws_s3_bucket.state[env].id }
}

output "lock_table_names" {
  description = "Nom de la table DynamoDB de verrouillage, par environnement."
  value       = { for env in var.environments : env => aws_dynamodb_table.lock[env].name }
}

output "state_kms_key_aliases" {
  description = "Alias de la clé KMS chiffrant l'état, par environnement."
  value       = { for env in var.environments : env => aws_kms_alias.state[env].name }
}

# Le backend S3 refuse les alias : `kms_key_id` n'accepte qu'un identifiant de clé
# (UUID) ou un ARN de clé. Ce sont donc ces valeurs — et non les alias ci-dessus —
# qu'il faut passer à `terraform init -backend-config="kms_key_id=…"` pour que
# l'état d'un environnement soit chiffré par sa propre clé plutôt qu'en SSE-S3.
output "state_kms_key_ids" {
  description = "Identifiant de la clé KMS chiffrant l'état, par environnement — à passer en `-backend-config` lors de l'init d'un envs/*."
  value       = { for env in var.environments : env => aws_kms_key.state[env].key_id }
}

# Sert de contrôle après l'amorçage : ces valeurs doivent correspondre trait pour
# trait aux blocs `backend` déjà versionnés dans envs/*. Un écart signifie qu'un
# environnement pointe vers un état qui n'existe pas.
output "backend_configuration" {
  description = "Configuration de backend attendue par chaque environnement, à comparer avec envs/<env>/backend.tf."
  value = {
    for env in var.environments : env => {
      bucket         = aws_s3_bucket.state[env].id
      key            = "envs/${env}/terraform.tfstate"
      region         = var.aws_region
      dynamodb_table = aws_dynamodb_table.lock[env].name
      encrypt        = true
    }
  }
}
