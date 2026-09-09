# Certificat ACM validé par DNS.
#
# ## Pourquoi la validation par DNS, et pas par courriel
#
# Parce que c'est **elle seule** qui rend le renouvellement automatique (CDC
# §4.9). ACM réémet un certificat validé par DNS environ soixante jours avant son
# échéance, sans que personne n'ait rien à faire, à une condition : que les
# enregistrements CNAME de validation soient toujours publiés le jour venu. La
# validation par courriel, elle, redemande à un humain de cliquer un lien tous
# les treize mois — ce qui revient à programmer une panne de production à date
# connue, un dimanche.
#
# Le corollaire est écrit ici parce qu'il ne se voit nulle part ailleurs : **ne
# jamais supprimer les CNAME de validation d'un certificat en service**. Rien ne
# casse le jour où on les retire ; la coupure arrive un an plus tard, et rien
# dans l'infrastructure ne la relie au geste qui l'a causée. C'est pour cela que
# ce module les gère lui-même dès qu'une zone Route 53 lui est confiée.
resource "aws_acm_certificate" "this" {
  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"
  key_algorithm             = var.key_algorithm

  # Ce que ce bloc active, et c'est le cœur du critère de renouvellement
  # automatique : ACM surveille la validité et réémet de lui-même.
  options {
    certificate_transparency_logging_preference = "ENABLED"
  }

  tags = {
    Name = local.certificate_name
  }

  # Un listener ALB et une distribution CloudFront **référencent** ce certificat :
  # il faut donc le remplaçant avant de retirer le remplacé, sinon un changement
  # de nom de domaine couperait la terminaison TLS le temps du remplacement.
  lifecycle {
    create_before_destroy = true
  }
}
