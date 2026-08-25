# Politiques de confiance.
#
# Trois conditions, dont deux non négociables :
#
#   `aud` = sts.amazonaws.com  — le jeton a bien été demandé pour AWS et non pour
#                                un autre service auquel GitHub sait aussi parler ;
#   `sub` ∈ liste exacte       — comparaison `StringEquals`, jamais `StringLike` :
#                                un `*` dans un sujet ouvre le compte à toutes les
#                                branches, voire à tous les dépôts.
#
# La liste des sujets diffère d'un rôle à l'autre parce que le sujet dépend du
# déclencheur du job, pas du rôle demandé. Se tromper de forme donne un
# `Not authorized to perform sts:AssumeRoleWithWebIdentity` sans plus d'explication.

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    sid     = "GitHubActionsDeploy"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.deploy_subjects
    }
  }
}

# `apply` ne s'obtient qu'à travers un environnement GitHub. Sur `prod`, cet
# environnement porte une approbation manuelle : accepter en plus un sujet
# `ref:refs/heads/main` la contournerait, puisqu'un workflow poussé sur `main` sans
# bloc `environment:` obtiendrait le même rôle sans passer par l'approbation.
data "aws_iam_policy_document" "terraform_trust" {
  statement {
    sid     = "GitHubActionsTerraformApply"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.terraform_apply_subjects
    }
  }
}

# Le job de `plan` tourne sur `pull_request`, donc sur du code pas encore relu.
# GitHub ne délivre `id-token: write` qu'aux pull requests issues du dépôt lui-même
# — une PR de fork n'obtient pas de jeton — mais cela reste le rôle le plus exposé
# des trois. D'où sa séparation : mêmes déclencheurs, droits en lecture seule.
data "aws_iam_policy_document" "terraform_plan_trust" {
  statement {
    sid     = "GitHubActionsTerraformPlan"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.terraform_plan_subjects
    }
  }
}
