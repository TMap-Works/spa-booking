# État distant de l'environnement de production.
#
# Le bucket et la table de verrouillage référencés ici sont créés par
# ../../bootstrap. Les valeurs sont littérales parce qu'un bloc `backend` n'accepte
# ni variable, ni interpolation, ni référence : elles doivent rester alignées sur
# la sortie `backend_configuration` de l'amorçage.
#
# Pas de `kms_key_id` ici : le backend S3 n'accepte qu'un identifiant de clé KMS
# (UUID) ou un ARN de clé. Il rejette les alias — y compris sous forme d'ARN — et
# `terraform init` échoue alors sur « Invalid KMS Key ARN ». Or l'identifiant de la
# clé n'existe qu'une fois l'amorçage appliqué : il ne peut pas être versionné ici.
#
# Conséquence à connaître : avec `encrypt = true` et sans `kms_key_id`, Terraform
# pose l'en-tête `AES256` sur le PUT, ce qui l'emporte sur le chiffrement par défaut
# du bucket — l'état est donc chiffré en SSE-S3, pas par la clé de l'environnement.
# Pour que la clé gérée par le client s'applique réellement, initialiser avec
# l'identifiant relevé dans la sortie `state_kms_key_ids` de l'amorçage :
#
#   terraform init -backend-config="kms_key_id=<uuid de la clé prod>"

terraform {
  backend "s3" {
    bucket         = "spa-booking-prod-tfstate"
    key            = "envs/prod/terraform.tfstate"
    region         = "eu-west-3"
    dynamodb_table = "spa-prod-tflock"
    encrypt        = true
  }
}
