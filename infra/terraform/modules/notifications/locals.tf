data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  name_prefix = "spa-${var.environment}"

  # Domaine d'enveloppe. Sous-domaine de `domain` et non un nom indépendant : la
  # relaxation par défaut de DMARC (`aspf=r`) aligne un sous-domaine sur son
  # domaine organisationnel, ce qui fait passer l'alignement SPF sans que le
  # `From` change.
  mail_from_domain = "${var.mail_from_subdomain}.${var.domain}"

  configuration_set_name = "${local.name_prefix}-email"

  dispatcher_function_name = "${local.name_prefix}-notification-dispatcher"

  reminder_sweeper_function_name = "${local.name_prefix}-reminder-sweeper"

  # Six fois le délai de la fonction, comme AWS le recommande pour une source
  # SQS. La règle n'est pas arbitraire : si la fonction est tuée sur un délai
  # dépassé, le message ne doit redevenir visible qu'une fois l'invocation
  # réellement terminée. Un délai de visibilité **inférieur** au délai de la
  # fonction ferait traiter le même message par deux exécutions concurrentes —
  # l'idempotence de #68 le rattraperait, mais après un appel fournisseur de
  # trop.
  #
  # Déduit plutôt que pris en variable : deux réglages indépendants dont l'un
  # doit rester supérieur à l'autre finissent toujours par diverger, et la
  # divergence ne se voit qu'en production.
  dispatch_visibility_timeout_seconds = 6 * var.dispatcher_timeout_seconds

  # La clé effectivement utilisée par le topic : celle fournie par
  # l'environnement, sinon celle que le module vient de créer.
  kms_key_arn = var.kms_key_arn != null ? var.kms_key_arn : one(aws_kms_key.events[*].arn)

  manage_dns = var.route53_zone_id != null

  # Jetons Easy DKIM produits par SES à la création de l'identité. Leur valeur
  # n'est connue qu'après l'`apply` : tout ce qui les consomme doit donc tolérer
  # l'inconnu au moment du plan (voir le `count` de dns.tf).
  dkim_tokens = aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens

  # Easy DKIM rend toujours trois jetons. Ce nombre-là, contrairement aux jetons
  # eux-mêmes, est connu au plan — c'est ce qui rend les enregistrements DKIM
  # planifiables avant que l'identité n'existe.
  dkim_token_count = 3

  # Hôte de retour des rebonds, propre à la région de l'identité. Le mettre en dur
  # ferait publier un MX pointant vers une région où l'identité n'existe pas, et
  # SES considérerait le `MAIL FROM` comme non configuré.
  mail_from_mx_value = "10 feedback-smtp.${data.aws_region.current.name}.amazonses.com"

  # `~all` — échec « souple » — et non `-all`. Un rejet dur sur un domaine qui
  # vient d'être posé transforme la moindre source oubliée en messages perdus sans
  # trace ; c'est la politique DMARC, alimentée par ses rapports, qui doit
  # resserrer, pas SPF à l'aveugle.
  spf_record_value = "v=spf1 include:amazonses.com ~all"

  # Assemblé par `join` sur les parties non vides plutôt qu'en interpolation
  # conditionnelle : un `rua` absent laisserait sinon une espace double au milieu
  # de l'enregistrement. Un analyseur DMARC strict y voit une étiquette vide et
  # ignore l'enregistrement entier — sans rien signaler, puisqu'un DMARC absent
  # n'est pas une erreur.
  dmarc_record_value = join(" ", compact([
    "v=DMARC1;",
    "p=${var.dmarc_policy};",
    var.dmarc_report_uri != null ? "rua=mailto:${var.dmarc_report_uri};" : "",
    "pct=${var.dmarc_percentage};",
    # Alignement relâché sur les deux mécanismes : un envoi depuis
    # `mail.exemple.fr` reste aligné avec un `From` en `@exemple.fr`. Le mode
    # strict (`s`) exigerait l'égalité exacte des domaines et ferait échouer
    # l'alignement du `MAIL FROM` que ce module met justement en place.
    "adkim=r;",
    "aspf=r",
  ]))

  # Ce qu'il faut publier quand la zone n'est pas dans Route 53. Le module ne peut
  # pas le faire à la place de l'opérateur, mais il peut ne rien lui laisser à
  # deviner : la sortie `dns_records` reprend cette liste telle quelle.
  dns_records = concat(
    [for token in local.dkim_tokens : {
      name  = "${token}._domainkey.${var.domain}"
      type  = "CNAME"
      ttl   = var.dns_record_ttl
      value = "${token}.dkim.amazonses.com"
      role  = "DKIM — signature des messages, et vérification du domaine par SES"
    }],
    [
      {
        name  = local.mail_from_domain
        type  = "MX"
        ttl   = var.dns_record_ttl
        value = local.mail_from_mx_value
        role  = "MAIL FROM — retour des rebonds vers SES"
      },
      {
        name  = local.mail_from_domain
        type  = "TXT"
        ttl   = var.dns_record_ttl
        value = local.spf_record_value
        role  = "SPF du domaine d'enveloppe — alignement SPF pour DMARC"
      },
      {
        name  = "_dmarc.${var.domain}"
        type  = "TXT"
        ttl   = var.dns_record_ttl
        value = local.dmarc_record_value
        role  = "DMARC — politique appliquée aux messages non alignés"
      },
    ],
    var.manage_root_spf_record ? [{
      name  = var.domain
      type  = "TXT"
      ttl   = var.dns_record_ttl
      value = local.spf_record_value
      role  = "SPF du domaine d'en-tête — à fusionner avec un `v=spf1` existant, jamais à dupliquer"
    }] : [],
  )
}
