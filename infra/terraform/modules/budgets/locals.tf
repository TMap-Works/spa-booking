locals {
  name_prefix = "spa-${var.environment}"

  # Forme attendue par l'API Budgets pour un filtre sur étiquette :
  # `user:Environment$dev`. Le `$` est produit par `format` et non écrit dans une
  # chaîne interpolée — `"user:Environment$${var.environment}"` serait lu comme la
  # séquence d'échappement `$${`, qui rend un `${…}` littéral au lieu d'interpoler,
  # et le budget mesurerait alors la dépense d'un environnement qui n'existe pas.
  environment_cost_filter = format("user:%s$%s", var.environment_tag_key, var.environment)
}
