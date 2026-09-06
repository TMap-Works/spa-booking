# Publication des enregistrements DNS, quand et seulement quand la zone est
# servie par Route 53.
#
# Tout est gardé par `local.manage_dns`. Un module qui exigerait une zone Route 53
# rendrait la vérification du domaine impossible pour un client dont le DNS est
# ailleurs — c'est-à-dire la majorité. La sortie `dns_records` prend alors le
# relais : mêmes noms, mêmes valeurs, à publier à la main.

# --- DKIM ---------------------------------------------------------------------

# Trois CNAME, pas trois TXT : Easy DKIM délègue la clé publique à SES, qui la
# fait tourner sans que la zone change. Publier la clé en TXT obligerait à
# republier à chaque rotation, et une rotation manquée casse la signature de tous
# les messages.
#
# `count` sur un nombre fixe, et non `for_each` sur les jetons : les jetons ne
# sont connus qu'**après** l'`apply` qui crée l'identité, or `for_each` exige des
# clés connues au plan. Le plan initial échouerait sur « keys derived from
# resource attributes that cannot be determined until apply », c'est-à-dire au
# seul moment où ce module sert vraiment. Le nombre, lui, est connu — Easy DKIM
# rend toujours trois jetons —, et `count.index` accepte des valeurs inconnues.
resource "aws_route53_record" "dkim" {
  count = local.manage_dns ? local.dkim_token_count : 0

  zone_id = var.route53_zone_id
  name    = "${local.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = var.dns_record_ttl
  records = ["${local.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# --- MAIL FROM : MX et SPF ----------------------------------------------------

# Retour des rebonds. C'est cet MX que SES cherche pour considérer le `MAIL FROM`
# personnalisé comme configuré ; son absence déclenche la conduite fixée par
# `mail_from_behavior_on_mx_failure`.
resource "aws_route53_record" "mail_from_mx" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = var.dns_record_ttl
  records = [local.mail_from_mx_value]
}

# SPF du domaine d'enveloppe. Il autorise les serveurs de SES à émettre au nom de
# `mail.{domain}` — et c'est ce domaine-là, aligné avec le `From` par la
# relaxation DMARC, qui fait passer l'alignement SPF.
resource "aws_route53_record" "mail_from_spf" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = var.dns_record_ttl
  records = [local.spf_record_value]
}

# SPF du domaine d'en-tête, optionnel et faux par défaut. Deux `v=spf1` sur un
# même nom valent `permerror` : ce module ne pose celui-ci que si l'opérateur
# affirme, en passant `manage_root_spf_record`, que le domaine n'en porte pas
# déjà un.
resource "aws_route53_record" "root_spf" {
  count = local.manage_dns && var.manage_root_spf_record ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = var.dns_record_ttl
  records = [local.spf_record_value]
}

# --- DMARC --------------------------------------------------------------------

# Le troisième pied de la délivrabilité. DKIM et SPF disent « ce message est
# authentique » ; DMARC dit ce qu'il faut faire quand il ne l'est pas, et fait
# remonter des rapports sur qui écrit au nom du domaine. Sans lui, Gmail et
# Outlook appliquent depuis 2024 leur propre politique aux expéditeurs de volume —
# c'est-à-dire la boîte à spam.
resource "aws_route53_record" "dmarc" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = var.dns_record_ttl
  records = [local.dmarc_record_value]
}
