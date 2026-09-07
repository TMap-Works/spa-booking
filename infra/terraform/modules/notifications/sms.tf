# Canal SMS — type de message, plafond de dépense, sender ID.
#
# Le SMS est le seul poste de la chaîne que le CDC §4.16 **sort** de l'estimation
# budgétaire, et il le dit sans détour : « hors volumétrie SMS (très variable
# selon le pays et le volume) ». Un rappel J-1 vers Madagascar et le même rappel
# vers la France ne coûtent pas le même prix, et rien dans le code ne le sait.
#
# D'où l'ordre de ce fichier, qui est celui du risque :
#
# | Ce qui protège | De quoi |
# |---|---|
# | `monthly_spend_limit` | d'une facture qu'on découvre en fin de mois |
# | l'alarme à 80 % | d'un plafond atteint **en silence**, qui coupe les rappels |
# | `Transactional` | d'un rappel routé comme une promotion, donc filtré |
# | le sender ID | d'un numéro d'expéditeur illisible, voire refusé par l'opérateur |
#
# Ce que ce fichier ne fait pas : envoyer. C'est l'API qui appelle `Publish`,
# depuis la route que la Lambda d'envoi lui adresse (#70) — ce module lui donne
# le droit de le faire, et rien de plus.

# --- Un réglage de compte, pas une ressource ----------------------------------

# `aws_sns_sms_preferences` n'a pas de nom, et ce n'est pas un oubli du
# fournisseur : il y a **exactement un** jeu de préférences SMS par compte et par
# région. C'est le même piège que l'identité de domaine SES, en pire — l'identité
# se dispute au moins sur un nom distinct, ici les trois environnements
# écriraient sur la même case sans même le voir dans un plan.
#
# `manage_sms_account_preferences` désigne donc l'environnement qui l'assume : la
# production, et elle seule. Ce n'est pas une privation pour les autres — le
# réglage étant celui du compte, dev et staging **héritent** du même plafond et
# du même type de message. Une boucle d'essai en développement ne peut pas
# dépasser le plafond de la production, ce qui est exactement la protection
# recherchée.
resource "aws_sns_sms_preferences" "this" {
  count = var.manage_sms_account_preferences ? 1 : 0

  # `Transactional` et non `Promotional` (skill notifications §5). Deux effets,
  # et le second est le moins connu : la priorité de routage est supérieure — un
  # opérateur remet un message transactionnel avant un message promotionnel —, et
  # certains opérateurs **refusent** purement et simplement un message
  # promotionnel hors plage horaire ou vers un numéro inscrit sur une liste
  # d'opposition commerciale. Un rappel de rendez-vous classé promotionnel serait
  # perdu sans erreur côté AWS.
  default_sms_type = "Transactional"

  # Plafond **dur** : SNS cesse d'envoyer dès que la dépense du mois civil
  # l'atteint. Ce n'est pas une alerte, c'est un robinet qui se ferme — les
  # rappels J-1 s'arrêtent, et aucune erreur applicative ne le dit, puisque la
  # publication est refusée par le service. C'est précisément ce que l'alarme
  # ci-dessous existe pour anticiper.
  #
  # À savoir avant de poser une valeur : le quota du compte plafonne ce réglage,
  # et il vaut **1 USD par mois sur un compte neuf**. Le relever est une demande
  # de quota au support AWS, à faire tôt — la refuser reviendrait à découvrir le
  # jour du go-live que le plafond ne monte pas.
  monthly_spend_limit = var.sms_monthly_spend_limit_usd

  # Nom d'expéditeur affiché à la place d'un numéro court, là où l'opérateur du
  # pays destinataire le permet. `null` laisse SNS choisir, ce qui donne un numéro
  # partagé et un message qui n'a l'air de venir de personne. Voir la sortie
  # `sms_sender_id_registration` pour ce qu'il reste à faire pays par pays :
  # poser cette valeur ne l'enregistre nulle part.
  default_sender_id = var.sms_sender_id
}

# --- L'alarme de dépense ------------------------------------------------------

locals {
  # Le seuil en dollars, déduit du plafond plutôt que pris en variable : deux
  # réglages indépendants dont l'un doit rester sous l'autre finissent toujours
  # par diverger, et la divergence ne se voit qu'au moment où elle coûte. Même
  # raisonnement que `dispatch_visibility_timeout_seconds`.
  sms_spend_alarm_threshold_usd = var.sms_monthly_spend_limit_usd * var.sms_spend_alarm_threshold_percent / 100

  # --- Ce que Terraform ne peut pas enregistrer -------------------------------

  # Poser `default_sender_id` **ne l'enregistre nulle part**. Certains pays
  # exigent que l'expéditeur alphanumérique soit déclaré auprès du régulateur ou
  # de l'opérateur avant d'être accepté ; ailleurs, il est simplement remplacé
  # par un numéro court, sans erreur. Le fournisseur AWS n'expose **aucune
  # ressource** d'enregistrement de sender ID — ni sous `aws_sns_*`, ni sous
  # `aws_pinpointsmsvoicev2_*`, qui ne couvre que les numéros, les listes
  # d'opposition et les jeux de configuration.
  #
  # Ce n'est donc pas un oubli de ce module : c'est une démarche administrative,
  # instruite par un humain, exactement comme la sortie du bac à sable SES. Le
  # module ne peut pas la faire ; il peut ne rien laisser à deviner à celui qui
  # la fera. Chaque entrée porte les mêmes clés, y compris celle que `try` rend
  # pour un pays absent de la table : une liste dont les objets n'ont pas la même
  # forme n'a pas de type commun, et Terraform refuse de la construire.
  sms_sender_id_country_rules = {
    FR = {
      exigence = "Enregistrement préalable obligatoire. Un expéditeur alphanumérique non enregistré est remplacé par un numéro court ou le message est rejeté par l'opérateur. Le dossier passe par AWS End User Messaging et se compte en semaines, pas en jours."
      statut   = "enregistrement-requis"
    }
    MG = {
      exigence = "Expéditeur alphanumérique accepté sans enregistrement préalable à la dernière vérification. À reconfirmer avant le go-live : la table AWS des pays pris en charge évolue, et un pays y passe de « libre » à « enregistrement requis » sans préavis."
      statut   = "a-reconfirmer"
    }
  }

  sms_sender_id_registration = [
    for country in var.sms_target_countries : {
      pays     = country
      exigence = try(local.sms_sender_id_country_rules[country].exigence, "Pays non documenté par ce module. Lire la table « Supported countries and regions » d'AWS End User Messaging avant d'émettre vers lui — un sender ID refusé ne produit pas d'erreur d'API, seulement un message qui n'arrive pas.")
      statut   = try(local.sms_sender_id_country_rules[country].statut, "a-verifier")
    }
  ]
}

# `SMSMonthToDateSpentUSD` est le compteur de dépense du mois civil en cours,
# publié par SNS dans la région. L'alarme le compare au seuil déduit du plafond.
#
# Pourquoi 80 % et pas 100 % : à 100 %, il n'y a plus rien à prévenir. Le plafond
# est atteint, SNS a cessé d'envoyer, et l'alarme ne ferait que constater des
# rappels déjà perdus. Le seul moment où l'information sert est celui où il reste
# de la marge pour relever le plafond ou couper le canal.
#
# Comme les préférences, l'alarme ne se pose que dans l'environnement qui détient
# le réglage : la métrique est **celle du compte**, pas celle de l'environnement.
# Trois alarmes sur la même série ne diraient pas trois choses, elles diraient la
# même chose trois fois — et chacune se déclencherait sur la dépense des deux
# autres.
resource "aws_cloudwatch_metric_alarm" "sms_spend" {
  count = var.manage_sms_account_preferences ? 1 : 0

  alarm_name        = "${local.alarm_prefix}-sms-spend"
  alarm_description = "La dépense SMS du mois atteint ${var.sms_spend_alarm_threshold_percent} % du plafond (${local.sms_spend_alarm_threshold_usd} sur ${var.sms_monthly_spend_limit_usd} USD). Au plafond, SNS cesse d'envoyer : les rappels J-1 s'arrêtent sans erreur applicative. Relever le plafond, ou couper le canal SMS, avant d'y arriver."

  namespace   = "AWS/SNS"
  metric_name = "SMSMonthToDateSpentUSD"

  # Métrique de compte : aucune dimension. En ajouter une — `Environment`, par
  # exemple — ferait chercher une série qui n'existe pas, et l'alarme resterait
  # indéfiniment en `INSUFFICIENT_DATA` sans que rien ne le signale.
  statistic           = "Maximum"
  period              = var.sms_spend_alarm_period_seconds
  evaluation_periods  = 1
  threshold           = local.sms_spend_alarm_threshold_usd
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # `missing`, et non le `notBreaching` des quatre autres alarmes de ce module.
  # La différence tient à la nature de la série : une profondeur de file est un
  # état instantané, dont l'absence de point veut dire « vide ». Un compteur de
  # dépense cumulée, non — SNS ne publie de point que lorsqu'un SMS part, et une
  # journée sans envoi ne remet pas la dépense du mois à zéro.
  #
  # Avec `notBreaching`, l'alarme retomberait au vert à chaque période creuse
  # pour repartir au rouge au SMS suivant : un battement, c'est-à-dire une
  # notification par oscillation, c'est-à-dire une alarme qu'on finit par couper.
  # `missing` lui fait conserver son état tant qu'aucune donnée ne le contredit.
  treat_missing_data = "missing"

  alarm_actions = var.alarm_topic_arns
  ok_actions    = var.alarm_topic_arns

  tags = {
    Name = "${local.alarm_prefix}-sms-spend"
  }
}

# --- Le droit d'envoyer -------------------------------------------------------

# Ce que l'API a le droit de faire du canal SMS, et rien de plus.
data "aws_iam_policy_document" "sms_publisher" {
  statement {
    sid    = "PublishSms"
    effect = "Allow"

    actions = ["sns:Publish"]

    # `Resource = "*"`, et c'est le seul ARN possible ici — la skill aws-infra §5
    # exige qu'un tel énoncé soit justifié en commentaire ou refusé, alors le
    # voici.
    #
    # Un envoi de SMS est un `Publish` **à un numéro de téléphone**
    # (`PhoneNumber`), pas à un topic. Or `Resource` est comparé à l'ARN du topic
    # visé, et il n'y en a pas : toute valeur autre que `*` refuserait chaque
    # envoi. AWS documente exactement cette politique pour l'envoi direct.
    #
    # Le droit résiduel est réel et il faut le nommer : ce `*` autorise aussi la
    # publication vers n'importe quel topic du compte. C'est ce que l'énoncé
    # `Deny` ci-dessous retire — voir son commentaire.
    resources = ["*"]
  }

  # Le `Deny` que le commentaire ci-dessus annonçait, et le topic sensible qui le
  # déclenche est arrivé : `spa-security-alerts`, qui porte les constats
  # GuardDuty du compte (#79). Publier dessus, c'est pouvoir noyer une détection
  # sous de faux constats, ou faire croire à un incident qui n'a pas eu lieu.
  #
  # `Deny` et non un `Resource` restreint, parce que c'est la seule forme qui
  # marche ici : `sns:Publish` vers un numéro de téléphone ne compare `Resource`
  # à aucun ARN de topic, si bien que toute valeur autre que `*` dans l'`Allow`
  # refuserait chaque SMS. Un refus explicite sur les ARN de topic, lui, ne
  # rencontre jamais un envoi SMS — il n'y a pas d'ARN à comparer — et retire
  # exactement le droit résiduel sans toucher au droit voulu.
  #
  # Le joker de l'ARN couvre les topics de toutes les régions du compte : le
  # canal SMS ne publie sur aucun d'eux, et un topic créé demain dans une autre
  # région serait sinon hors de la garde.
  statement {
    sid    = "RefuserLaPublicationVersUnTopic"
    effect = "Deny"

    actions = ["sns:Publish"]

    resources = [
      "arn:${data.aws_partition.current.partition}:sns:*:${data.aws_caller_identity.current.account_id}:*",
    ]
  }
}

# Ce que la politique **ne donne pas**, et qui est le point : ni
# `sns:SetSMSAttributes`, ni `sns:SetSMSSandboxAccountStatus`. Une application
# qui pourrait relever son propre plafond de dépense rendrait le plafond
# décoratif — le premier bug d'envoi en boucle le repousserait de lui-même. Ces
# réglages appartiennent à Terraform, c'est-à-dire à une pull request relue.
resource "aws_iam_policy" "sms_publisher" {
  name        = "${local.name_prefix}-notifications-sms-publisher"
  description = "Publier un SMS vers un numéro de téléphone, et rien d'autre : ni les réglages SMS du compte — plafond de dépense compris —, ni la publication sur un topic SNS, refusée explicitement."
  policy      = data.aws_iam_policy_document.sms_publisher.json

  tags = {
    Name = "${local.name_prefix}-notifications-sms-publisher"
  }
}
