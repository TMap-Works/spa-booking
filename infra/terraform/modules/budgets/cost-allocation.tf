# Activation des étiquettes de répartition de coûts.
#
# Poser une étiquette ne suffit pas à ce que Cost Explorer sache regrouper la
# dépense dessus : il faut l'activer, une fois, pour le compte. Tant que ce n'est
# pas fait, `default_tags` étiquette consciencieusement des ressources dont la
# facture reste un bloc indivisible, et le filtre du budget ne mesure rien.
#
# Trois choses à savoir avant d'y toucher :
#
#   * l'activation est **globale au compte** — d'où `cost_allocation_tag_keys`
#     vide par défaut et renseigné par le seul environnement `prod`, qui en est
#     le propriétaire désigné (voir le README) ;
#   * elle n'est possible que depuis le compte de facturation ;
#   * elle ne vaut que pour l'avenir. AWS ne rétro-applique pas une étiquette aux
#     mois déjà facturés : la ventilation par environnement commence au mois où
#     l'`apply` a eu lieu, ce qui est la raison d'activer dès le premier jour.
#
# Comme Budgets, Cost Explorer est un service global signé pour `us-east-1` : la
# région du provider n'entre pas en jeu.
#
# Attention : sur un compte neuf, le **premier** `apply` de cet environnement peut
# échouer ici. Une clé d'étiquette n'est activable qu'une fois que la facturation l'a
# découverte, c'est-à-dire après qu'une ressource l'a portée et que la journée de
# facturation a été traitée — jusqu'à 24 heures. `UpdateCostAllocationTagsStatus`
# répond alors qu'elle est inconnue et Terraform s'arrête. Ce n'est pas une
# erreur de configuration : relancer l'`apply` le lendemain suffit, le reste de
# l'environnement étant déjà créé. Cette dépendance au calendrier de facturation
# est l'argument principal pour déplacer l'activation vers `bootstrap`, appliqué
# une fois et bien avant les environnements (issue de suivi, voir le README).

resource "aws_ce_cost_allocation_tag" "this" {
  for_each = var.cost_allocation_tag_keys

  tag_key = each.value
  status  = "Active"
}
