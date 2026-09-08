# Journalisation du trafic du VPC (CDC §4.11).
#
# Sans flow logs, il ne reste rien de ce qui a traversé le réseau : ni le trafic
# accepté, ni — surtout — celui que les groupes de sécurité ont rejeté. Or c'est
# ce dernier qui dit qu'une tentative a eu lieu, et c'est la seule matière
# disponible après coup pour étayer la frontière d'isolation que le reste de la
# sécurité suppose acquise. Une segmentation qu'on ne peut pas observer est une
# segmentation qu'on croit.
#
# `traffic_type = "ALL"` est donc le seul réglage acceptable ici : `REJECT` seul
# raconte les tentatives sans permettre de les situer dans une session légitime,
# et `ACCEPT` seul ne montre que ce qui a marché.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# Le groupe est créé ici, avant le flow log, pour porter une rétention explicite :
# laissé au service, il naîtrait sans terme et se paierait indéfiniment
# (skill aws-infra §8). Les flow logs sont volumineux — c'est exactement le genre
# de poste qui grossit sans que personne ne le voie.
#
# Chiffré par la clé gérée par CloudWatch Logs et non par une clé du compte : la
# seule clé KMS d'un environnement est créée par le module `database`, qui se pose
# *sur* ce réseau. La lui demander ici inverserait la dépendance et rendrait le
# graphe cyclique. La contrepartie est nommée, comme pour le groupe CloudTrail du
# bootstrap : ce groupe n'est pas protégé par une clé du compte.
#tfsec:ignore:aws-cloudwatch-log-group-customer-key
resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${local.name_prefix}/flow-logs"
  retention_in_days = var.log_retention_days

  tags = {
    Name = "${local.name_prefix}-flow-logs"
  }
}

# Le service de flow logs assume ce rôle pour écrire dans le groupe. Les deux
# conditions ferment le « confused deputy » : sans elles, un flow log créé dans un
# autre compte AWS pourrait désigner ce rôle — son ARN se devine — et déverser son
# trafic dans notre groupe, à notre charge.
data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    sid     = "AutoriserLeServiceDeFlowLogs"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:vpc-flow-log/*"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${local.name_prefix}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_assume.json

  tags = {
    Name = "${local.name_prefix}-vpc-flow-logs"
  }
}

# Moindre privilège : les actions que la livraison exige, et rien d'autre, bornées
# au seul groupe créé ci-dessus. Le suffixe `:*` porte sur les flux à l'intérieur
# de ce groupe — c'est la forme d'ARN qu'attend CloudWatch Logs —, pas sur
# d'autres groupes.
#
# `logs:CreateLogGroup` figure dans les permissions qu'AWS documente comme
# exigées par la livraison, et une permission manquante ici ne casse pas
# l'`apply` : le flow log se crée, ne délivre rien, et l'échec ne se lit que dans
# son `deliver_logs_error_message`. Elle est donc accordée — mais bornée au même
# ARN que le reste, ce qui laisse ce rôle recréer *ce* groupe et aucun autre : pas
# de groupe arbitraire, donc facturé et sans rétention, créé hors de tout code.
#
# tfsec voit un `:*` en fin d'ARN et conclut à une ressource générique. C'est le
# contraire : `arn:…:log-group:<groupe>:*` est la forme que CloudWatch Logs impose
# pour désigner les flux d'**un** groupe, et le nom du flux — l'identifiant de
# l'interface réseau — est tiré au lancement, il ne peut pas être écrit à
# l'avance. La portée réelle est le groupe nommé juste au-dessus, et lui seul.
#tfsec:ignore:aws-iam-no-policy-wildcards
data "aws_iam_policy_document" "flow_logs" {
  statement {
    sid    = "EcrireLesFluxDansLeGroupeDedie"
    effect = "Allow"

    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
    ]

    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

#tfsec:ignore:aws-iam-no-policy-wildcards
resource "aws_iam_role_policy" "flow_logs" {
  name   = "${local.name_prefix}-vpc-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "this" {
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn

  # Dix minutes d'agrégation plutôt qu'une. L'intervalle d'une minute multiplie le
  # nombre d'enregistrements — donc l'ingestion CloudWatch, facturée au gigaoctet
  # — pour une précision temporelle dont l'instruction d'un incident n'a pas
  # besoin : ce qu'on cherche dans un flow log, c'est quelle adresse a parlé à
  # quel port et si le paquet est passé, pas la seconde exacte.
  max_aggregation_interval = 600

  tags = {
    Name = "${local.name_prefix}-flow-logs"
  }

  # La politique doit exister avant que le service n'essaie d'écrire. Dans l'ordre
  # inverse, la création réussit quand même et c'est pire : le flow log reste en
  # place et l'échec ne se lit que dans son `deliver_logs_error_message`, que
  # personne ne regarde.
  depends_on = [aws_iam_role_policy.flow_logs]
}
