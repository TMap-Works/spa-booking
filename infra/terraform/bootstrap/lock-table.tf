# Verrouillage de l'état. Sans cette table, deux `apply` concurrents écrivent
# l'état l'un par-dessus l'autre et laissent des ressources orphelines, invisibles
# de Terraform mais bien facturées.

resource "aws_dynamodb_table" "lock" {
  for_each = var.environments

  name         = "spa-${each.key}-tflock"
  billing_mode = "PAY_PER_REQUEST"

  # `LockID` n'est pas un choix : c'est le nom de clé de partition qu'attend le
  # backend S3 de Terraform. Toute autre valeur casse le verrouillage.
  hash_key = "LockID"

  # Une table de verrous détruite libère tous les verrous en cours.
  deletion_protection_enabled = true

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state[each.key].arn
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "spa-${each.key}-tflock"
    Environment = each.key
  }
}
