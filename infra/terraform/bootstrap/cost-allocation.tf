# Activation des étiquettes de répartition de coûts.
#
# Poser une étiquette ne suffit pas à ce que Cost Explorer sache regrouper la
# dépense dessus : il faut l'activer, une fois, pour le compte. Tant que ce n'est
# pas fait, les `default_tags` étiquettent consciencieusement des ressources dont
# la facture reste un bloc indivisible, et le filtre d'étiquette des budgets
# d'environnement ne mesure rien.
#
# C'est ici que cette activation a sa place, et nulle part ailleurs : elle vaut
# pour le **compte entier**, et l'amorçage est le seul état de ce dépôt à cette
# portée. Déclarée dans un module composé une fois par environnement, elle ferait
# gagner le dernier `apply` en écrasant silencieusement les deux autres — le même
# raisonnement qui tient le scan « enhanced » d'Inspector hors de `modules/ecr`.
#
# Deux autres propriétés à connaître avant d'y toucher :
#
#   * l'activation n'est possible que depuis le compte de facturation ;
#   * elle ne vaut que pour l'avenir. AWS ne rétro-applique pas une étiquette aux
#     mois déjà facturés : la ventilation commence au mois où l'`apply` a eu lieu,
#     ce qui est la raison d'activer dès l'amorçage.
#
# Comme Budgets, Cost Explorer est un service global signé pour `us-east-1` : la
# région du provider n'entre pas en jeu.
#
# Sur un compte neuf, ce bloc échoue au premier `apply`, et c'est attendu : une
# clé n'est activable qu'une fois que la facturation l'a découverte, c'est-à-dire
# après qu'une ressource l'a portée **et** que la journée de facturation a été
# traitée — jusqu'à 24 heures. Or l'amorçage est justement ce qui crée les
# premières ressources étiquetées du compte : au moment où il tourne pour la
# première fois, aucune des quatre clés n'a encore été vue par la facturation.
# `UpdateCostAllocationTagsStatus` répond qu'elles sont inconnues et Terraform
# s'arrête. Ce n'est pas une erreur de configuration : relancer l'`apply` le
# lendemain suffit. Pour obtenir un premier `apply` vert du même coup, poser
# `cost_allocation_tag_keys = []` le premier jour et retirer la surcharge le
# lendemain.
#
# Le `depends_on` ci-dessous n'existe que pour ça. Sans lui, ce bloc n'a aucune
# dépendance : Terraform le planifie dans la première vague, il échoue en
# quelques secondes et l'`apply` s'arrête **avant** que les buckets, les tables
# et les clés KMS ne soient créés — l'amorçage ne produit alors rien du tout et
# le lendemain ne change rien. Ordonné derrière eux, l'échec ne coûte que
# lui-même : le reste de l'amorçage est acquis, `backend_configuration` est
# lisible, et la reprise du lendemain ne recrée rien.

resource "aws_ce_cost_allocation_tag" "this" {
  for_each = var.cost_allocation_tag_keys

  tag_key = each.value
  status  = "Active"

  depends_on = [
    aws_s3_bucket.state,
    aws_dynamodb_table.lock,
    aws_kms_key.state,
  ]
}
