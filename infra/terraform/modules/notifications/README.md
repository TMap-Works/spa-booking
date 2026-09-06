# notifications — délivrabilité e-mail (SES) et chaîne d'envoi

Ce module pose la moitié « infrastructure » de la chaîne de notifications du
CDC §4.8 : le domaine d'envoi, sa signature, sa politique d'authentification, le
canal par lequel remontent les rebonds et les plaintes — et, depuis #67, la
**file de découplage, la Lambda d'envoi, la file d'attente morte et la
supervision** qui les relient à l'API.

Il existe pour deux raisons, chacune nommée dans le CDC :

- **Une délivrabilité insuffisante vide le rappel J-1 de son sens** (CDC §6). Un
  rappel qui arrive dans les indésirables ne réduit aucun no-show ; il coûte le
  même envoi et ne rapporte rien.
- **Une réservation ne doit jamais échouer parce qu'un e-mail n'est pas parti**
  (CDC §4.8). C'est ce que garantit la file : l'API publie et rend la main, elle
  n'appelle jamais SES depuis le chemin de requête HTTP.

Périmètre volontairement resserré, et complémentaire d'autres tickets :

| Ce module | Ailleurs |
|---|---|
| Identité de domaine, DKIM, SPF, DMARC | — |
| Jeu de configuration, liste de suppression | — |
| Topic SNS des événements de remise | Son traitement applicatif : #73 |
| File SQS, Lambda d'envoi, DLQ, alarmes | La route d'envoi côté API : #70 |
| — | SMS (SNS, plafond, sender ID) : #66 |
| — | Modèles de messages par tenant : #69 |
| — | Publication du rappel J-1 par EventBridge : #71 |

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Identité SESv2 | `{domain}` | Domaine d'envoi, signé par Easy DKIM (RSA 2048) |
| Attributs MAIL FROM | `mail.{domain}` | Domaine d'enveloppe, pour l'alignement SPF |
| Jeu de configuration | `spa-{env}-email` | TLS exigé, métriques de réputation, liste de suppression |
| Destination d'événements | `spa-{env}-delivery-events` | Rebonds, plaintes, refus, échecs de rendu → SNS |
| Topic SNS | `spa-{env}-ses-events` | Canal des événements, chiffré |
| Clé KMS + alias | `alias/spa-{env}-ses-events` | Chiffre le topic **et les deux files** |
| Enregistrements Route 53 | 6 | **Seulement si `route53_zone_id` est fourni** |
| File SQS | `spa-{env}-notifications` | Découplage — l'API y publie et rend la main |
| File SQS | `spa-{env}-notifications-dlq` | Bout de course, rétention 14 jours |
| Politique IAM | `spa-{env}-notifications-producer` | Droit de publier, jamais de dépiler |
| Lambda | `spa-{env}-notification-dispatcher` | Consomme la file et fait envoyer |
| Rôle + politique IAM | `spa-{env}-notification-dispatcher` | Au moindre privilège, ARN par ARN |
| Groupe de journaux | `/aws/lambda/spa-{env}-notification-dispatcher` | Rétention explicite |
| Alarmes CloudWatch | 4 | DLQ, erreurs, retard, refus définitifs |
| Tableau de bord | `spa-{env}-notifications` | **Seulement si `create_dashboard`** |

## Composition

```hcl
module "notifications" {
  source = "../../modules/notifications"

  environment = local.environment
  domain      = "mail.exemple.fr"

  # Zone servie par Route 53 : le module publie DKIM, SPF et DMARC lui-même.
  # Omettre quand le DNS est ailleurs — voir « Domaine hors Route 53 ».
  route53_zone_id = "Z0123456789ABCDEFGHIJ"

  # Sans destinataire de rapports, une politique `none` n'apprend rien.
  dmarc_report_uri = "rapports-dmarc@exemple.fr"

  # Chaîne d'envoi. Les alarmes se branchent sur le topic du module `budgets`
  # plutôt que d'en créer un second ; sans topic, elles changent d'état sans
  # prévenir personne.
  log_retention_days = 30
  alarm_topic_arns   = [module.budgets.alerts_topic_arn]

  # La route que la Lambda appelle. Nulle, la fonction est en défaut fermé —
  # voir « Défaut fermé » plus bas. Les deux se posent ensemble : une route
  # joignable sans jeton laisserait n'importe qui déclencher des envois.
  dispatch_url              = "https://api.exemple.fr/api/v1/interne/notifications/dispatch"
  dispatch_token_secret_arn = aws_secretsmanager_secret.dispatch_token.arn
}
```

Une identité de domaine est unique **par compte et par région**. Les trois
environnements partagent un compte : ils ne peuvent donc pas déclarer le même
`domain`, sous peine de se disputer la même ressource AWS depuis trois états
Terraform. Le découpage attendu est un sous-domaine par environnement —
`dev.mail.exemple.fr`, `staging.mail.exemple.fr` — la production gardant le nom
d'envoi réel.

## Les trois enregistrements, et pourquoi les trois

| | Ce qu'il prouve | Ce qui casse sans lui |
|---|---|---|
| **DKIM** | Le message n'a pas été altéré et vient d'une clé du domaine | SES ne vérifie même pas le domaine : rien ne part |
| **SPF** | Le serveur émetteur est autorisé par le domaine d'enveloppe | DMARC ne tient plus que sur DKIM ; un incident DKIM devient une panne totale |
| **DMARC** | Ce qu'il faut faire d'un message non aligné, et qui écrit au nom du domaine | Gmail et Outlook appliquent leur propre jugement aux expéditeurs de volume — en pratique, l'onglet « indésirables » |

Deux détails valent la peine d'être connus avant de les toucher :

- **Le `MAIL FROM` personnalisé n'est pas décoratif.** Sans lui, SES émet sous
  `amazonses.com` : SPF passe, mais sur un domaine qui n'est pas le nôtre, et
  DMARC — qui exige l'alignement — ne retient que DKIM. Le sous-domaine `mail.`
  fait aligner les deux mécanismes.
- **Deux enregistrements SPF sur un même nom valent `permerror`**, c'est-à-dire un
  échec SPF, pas une union. C'est pourquoi `manage_root_spf_record` vaut faux par
  défaut : si le domaine reçoit déjà du courrier d'un autre émetteur, il porte
  déjà un `v=spf1` auquel il faut **ajouter** `include:amazonses.com` à la main.

La politique DMARC démarre à `p=none` délibérément. Publier `reject` le jour de la
mise en place ferait disparaître sans trace les messages légitimes d'une source
oubliée. L'ordre est : `none` + `rua` → lire les rapports → `quarantine` (au
besoin `pct=10` d'abord) → `reject`.

### Rapports `rua` vers un autre domaine : l'autorisation à ne pas oublier

`dmarc_report_uri` accepte n'importe quelle adresse, mais la RFC 7489 §7.1 impose
une **autorisation de destination externe** dès que le domaine de l'adresse de
rapport diffère de celui qui porte l'enregistrement DMARC. C'est exactement le cas
de l'exemple ci-dessus — DMARC sur `mail.exemple.fr`, rapports vers
`@exemple.fr` — et de la composition par environnement, où chaque environnement
prend son propre sous-domaine.

Sans cet enregistrement, les fournisseurs **n'envoient tout simplement aucun
rapport**, sans erreur ni rebond : la politique reste à `none` faute de la seule
donnée qui permettrait de la resserrer. Ce module ne le pose pas — il vit dans la
zone du domaine **destinataire**, qui n'est pas forcément celle de `domain` :

```
mail.exemple.fr._report._dmarc.exemple.fr.   TXT   "v=DMARC1"
```

Autrement dit, dans la zone de `exemple.fr` (le domaine de l'adresse de rapport),
un TXT nommé `<domaine surveillé>._report._dmarc`. Le vérifier une fois publié :

```bash
dig +short TXT mail.exemple.fr._report._dmarc.exemple.fr
```

Une adresse de rapport prise **dans le domaine surveillé lui-même** — par exemple
`dmarc@mail.exemple.fr` — dispense de tout cela.

## Domaine hors Route 53

Le module ne suppose pas que le DNS du domaine soit chez AWS. Sans
`route53_zone_id`, il crée tout le reste et expose ce qu'il ne peut pas poser :

```bash
terraform output -json dns_records
```

Chaque entrée porte `name`, `type`, `ttl`, `value` et `role`. Tant qu'ils ne sont
pas publiés, l'identité reste en attente et **aucun message ne part** —
`verified_for_sending_status` vaut alors faux durablement.

Vérifier la propagation avant de conclure à autre chose. Les noms ci-dessous sont
ceux de l'exemple de composition — `domain = "mail.exemple.fr"` —, dont le domaine
d'enveloppe est donc `mail.` + `domain`, soit `mail.mail.exemple.fr`. C'est ce
préfixe que `dns_records` rend nom par nom : s'y référer plutôt que de le
reconstituer de tête, une interrogation `dig` sur le mauvais nom ne rendant rien
et passant pour une propagation manquante.

```bash
dig +short CNAME <jeton>._domainkey.mail.exemple.fr
dig +short MX   mail.mail.exemple.fr
dig +short TXT  mail.mail.exemple.fr
dig +short TXT  _dmarc.mail.exemple.fr

aws sesv2 get-email-identity --email-identity mail.exemple.fr --region eu-west-3 \
  --query '{verifie: VerifiedForSendingStatus, dkim: DkimAttributes.Status, mailFrom: MailFromAttributes}'
```

Une fois le MX résolu et stable, `mail_from_behavior_on_mx_failure` peut passer à
`REJECT_MESSAGE` : c'est le réglage strict, et il n'est tenable qu'à partir de ce
moment-là.

## Ce que Terraform ne fait pas — et qui reste à faire à la main

Deux critères de l'issue #65 n'ont **aucune ressource Terraform** parce qu'ils ne
sont pas des ressources : l'un est une demande à AWS, l'autre est un test. Ils
sont décrits ici pour qu'ils soient exécutables sans rien redécouvrir, et ils ne
sont pas cochés tant que quelqu'un ne les a pas réellement exécutés.

### 1. Sortie du bac à sable SES

Un compte neuf est en bac à sable : envoi limité à 200 messages par 24 h, 1 par
seconde, et **uniquement vers des adresses elles-mêmes vérifiées**. En clair, le
rappel J-1 n'atteint aucun client réel tant que la sortie n'est pas obtenue.

L'API `PutAccountDetails` de SESv2 ouvre le dossier, mais elle n'accorde rien :
elle dépose une demande qu'un humain instruit chez AWS. Il n'y a donc rien à
faire converger pour Terraform — un `apply` ne peut pas « posséder » une décision
qui appartient au support AWS, et le rejouer rouvrirait un dossier à chaque fois.

```bash
aws sesv2 put-account-details \
  --region eu-west-3 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://<domaine du produit> \
  --contact-language EN \
  --use-case-description "Plateforme SaaS de réservation pour spas et salons. \
Trois messages transactionnels uniquement : confirmation de réservation, rappel \
24 h avant le rendez-vous, avis d'annulation. Destinataires : les clients qui \
viennent de réserver, sur la base de l'exécution du contrat. Aucun envoi \
promotionnel. Rebonds et plaintes traités automatiquement, adresses en rebond \
permanent inscrites sur la liste de suppression du compte." \
  --additional-contact-email-addresses <adresse d'exploitation>
```

`--contact-language` n'accepte que `EN` ou `JA` — l'API n'a pas de valeur
française, et `FR` y est refusé. La description, elle, peut rester en français.

Compter **jusqu'à 24 h ouvrées** de délai : la demande se fait tôt, pas la veille
du go-live. Vérifier ensuite, et seulement ensuite cocher le critère :

```bash
aws sesv2 get-account --region eu-west-3 \
  --query '{production: ProductionAccessEnabled, envoiActif: SendingEnabled, quota: SendQuota}'
```

Penser à demander en même temps un relèvement du quota d'envoi si le volume
attendu dépasse celui accordé par défaut à la sortie du bac à sable.

### 2. Test d'envoi réel vers les principaux fournisseurs

Aucun `terraform apply` ne prouve qu'un message arrive en boîte de réception : la
décision appartient au fournisseur destinataire, et elle dépend de l'expéditeur,
du contenu et de la réputation. Le test se fait donc à la main, **après** la
sortie du bac à sable et **après** que `verified_for_sending_status` est passé à
vrai.

Sur une adresse jetable chez chacun des fournisseurs à couvrir — Gmail, Outlook,
Yahoo, et un domaine professionnel en Microsoft 365 :

```bash
aws sesv2 send-email \
  --region eu-west-3 \
  --from-email-address "reservations@mail.exemple.fr" \
  --destination 'ToAddresses=["essai@gmail.com"]' \
  --configuration-set-name "$(terraform output -raw notification_configuration_set_name)" \
  --content '{"Simple":{"Subject":{"Data":"Confirmation de votre rendez-vous"},"Body":{"Text":{"Data":"Essai de delivrabilite."},"Html":{"Data":"<p>Essai de delivrabilite.</p>"}}}}'
```

Ce qui est vérifié, pour chaque fournisseur — et ce qui doit être consigné :

1. le message arrive **en boîte de réception**, pas en indésirables ;
2. l'en-tête `Authentication-Results` du message reçu affiche `dkim=pass`,
   `spf=pass` et `dmarc=pass` — c'est cette ligne qui fait foi, pas l'absence de
   rebond ;
3. le domaine qui apparaît dans `spf=pass (domain of ...)` est bien le domaine
   d'enveloppe — `mail.mail.exemple.fr` pour l'exemple de composition, c'est-à-dire
   la sortie `mail_from_domain` — et non `amazonses.com` : sinon le `MAIL FROM`
   personnalisé n'est pas pris en compte, et l'alignement SPF ne joue pas.

Deux services rendent le même verdict sans compte de messagerie : envoyer à
l'adresse fournie par `mail-tester.com`, ou au vérificateur de `dkimvalidator.com`.
Ils ne remplacent pas le test chez Gmail et Outlook, dont les filtres leur sont
propres.

Un rappel utile : ces envois d'essai comptent dans le taux de rebond du compte.
Ne pas viser des adresses inventées — un rebond dur sur une adresse fantaisiste
dégrade la réputation qu'on cherche précisément à établir.

## Rebonds et plaintes

Deux mécanismes distincts, et il faut les deux :

- **La liste de suppression du compte** (`suppression_options`) est posée par ce
  module. SES refuse de lui-même tout envoi vers une adresse qui y figure, même
  si l'application le demandait. C'est le filet.
- **Le traitement applicatif** — passer la notification en `suppressed` en base,
  cesser de solliciter le client — s'abonne au topic `events_topic_arn` et fait
  l'objet de #73.

Le consommateur du topic s'abonne par **file SQS**, pas par HTTP : un abonnement
HTTP perd les événements pendant qu'un déploiement redémarre l'API, et un rebond
perdu est une adresse morte qu'on continuera à solliciter.

Le topic est chiffré par une clé KMS gérée par le compte. Tout abonné doit obtenir
`kms:Decrypt` sur `kms_key_arn`, sinon il recevra des messages qu'il ne saura pas
déchiffrer — panne silencieuse, et la plus longue à diagnostiquer de cette
chaîne.

## La chaîne d'envoi — file, Lambda, DLQ, supervision

```
API (POST /appointments)                EventBridge Scheduler (#71)
        │ publie, puis rend la main              │ balayage horaire
        └───────────────┬────────────────────────┘
                        ▼
        spa-{env}-notifications  ── 5 réceptions ──►  spa-{env}-notifications-dlq
                        │                                        │
                        ▼                                        ▼
        spa-{env}-notification-dispatcher                  alarme de profondeur
                        │
                        ▼
        POST dispatch_url  →  l'API écrit PENDING, appelle SES/SNS, écrit SENT
```

### Pourquoi la Lambda n'appelle pas SES elle-même

Parce que l'ordre d'écriture `PENDING → fournisseur → SENT` et l'index
d'idempotence qui le porte appartiennent au module `notifications` de l'API,
posés et testés par #68. Les réécrire en JavaScript dans la fonction donnerait
deux implémentations de la même règle, dans deux exécutables, avec un seul jeu
de tests — c'est-à-dire une divergence garantie, sur la règle la plus coûteuse à
casser de toute la chaîne.

La Lambda est donc le **transport** : elle dépile, valide l'enveloppe, appelle
l'API, et traduit la réponse en une décision de rejeu. Rien de plus.

### Le contrat de `dispatch_url`

`POST` d'un corps `{ messageId, message }`, où `message` est l'enveloppe
`NotificationMessage` telle que le producteur l'a publiée — des identifiants,
**jamais de coordonnée** (CDC §5.1). La réponse décide du sort du message :

| Réponse | Sort | Pourquoi |
|---|---|---|
| `2xx` | acquitté, compté `Sent` | parti |
| `204`, `409` | acquitté, compté `Skipped` | une autre livraison l'avait déjà pris — le rejeu fait son travail |
| `401`, `403`, `408`, `425`, `429`, `5xx` | **rendu à SQS**, compté `TransientFailures` | l'appel a raté, pas le message |
| coupure réseau, délai dépassé | **rendu à SQS** | idem |
| tout autre `4xx` | acquitté, compté `PermanentFailures` | adresse morte, désinscription, requête mal formée : le répéter ne le rendra pas vrai |
| enveloppe illisible ou non conforme | acquitté, compté `PermanentFailures` | un JSON invalide ne se répare pas en le relisant |

Un `401` ou un `403` compte comme **transitoire**, et il faut s'y arrêter : un
refus d'authentification ne dit rien du message, il dit que la fonction ne s'est
pas fait reconnaître — jeton tourné, secret vide, politique mal posée. Ce
refus-là frappe *tous* les messages à la fois. Les compter permanents les
acquitterait, donc les supprimerait de la file sans qu'aucun passe par la DLQ :
il n'y aurait plus rien à rejouer le jour où le jeton est corrigé. Transitoires,
ils épuisent leurs tentatives, atterrissent en DLQ, et s'y rejouent.

### Les deux règles de reprise

**Aucune boucle maison.** Un enregistrement, un appel, une décision. Le rejeu est
le métier de SQS, qui compte jusqu'à `dispatch_max_receive_count`. Boucler dans
la fonction doublerait la file, masquerait la profondeur de DLQ sur laquelle
repose l'alarme, et retiendrait le lot entier pendant qu'un fournisseur est en
panne.

À savoir avant de régler quoi que ce soit : **SQS n'espace pas les tentatives**.
Il n'a pas de report exponentiel. Un message rendu redevient visible au plus tard
au bout du délai de visibilité — `6 × dispatcher_timeout_seconds`, soit 180 s par
défaut — et plus tôt encore, la source d'événements le rendant immédiatement par
`ChangeMessageVisibility`. Cinq réceptions consomment donc **au plus un quart
d'heure**, pas une nuit : une panne d'API qui dure davantage envoie en DLQ tout ce
qui est en vol. C'est la DLQ, pas l'alarme d'âge, qui parle en premier — et c'est
`dispatch_max_receive_count` × le délai de visibilité, non `backlog_age_alarm_seconds`,
qu'il faut relever pour tenir une panne plus longue.

**Les échecs permanents ne sont pas rejoués.** C'est
`function_response_types = ["ReportBatchItemFailures"]` qui le rend possible : la
fonction rend la liste des seuls enregistrements à rejouer, et SQS supprime tous
les autres. Sans ce réglage, une erreur dans un lot de cinq ferait rejouer les
cinq — quatre messages sains verraient leur compteur de réception avancer, et
finiraient en DLQ sans avoir jamais échoué.

### Défaut fermé

Sans `dispatch_url`, la fonction ne prétend pas envoyer : elle journalise
`notification.unconfigured` et **rend le message à SQS**. Le message épuise ses
cinq réceptions — un quart d'heure au plus, voir ci-dessus — puis part en DLQ, et
l'alarme de profondeur parle. C'est voulu : une chaîne non branchée doit se voir.
Une fonction qui acquitterait sans envoyer serait, elle, strictement invisible.

L'alarme d'âge, elle, ne dira rien de ce cas-là : un message qui échoue vite
n'atteint jamais une heure d'attente. Elle couvre l'autre panne — la source
d'événements arrêtée ou bridée, où plus personne ne dépile du tout.

`terraform output notification_dispatch_configured` répond à cette question sans
ouvrir la console. C'est la première chose à regarder quand rien ne part.

### Supervision — quatre façons de ne rien envoyer

| Ce qui se passe | Ce qui le dit | Alarme |
|---|---|---|
| Le message a épuisé ses tentatives | profondeur de la DLQ | `…-notifications-dlq-depth` |
| La fonction plante avant de décider | erreurs Lambda | `…-notifications-dispatcher-errors` |
| Plus personne ne consomme, l'API ne répond plus | âge du plus vieux message | `…-notifications-backlog-age` |
| Le message est refusé pour de bon | métrique `PermanentFailures` | `…-notifications-permanent-failures` |

La quatrième est la moins évidente et la plus importante. Un échec permanent est
**acquitté** : il ne remplit ni la file, ni la DLQ. Sans compteur dédié, une
adresse invalide serait rigoureusement invisible — la file resterait vide, et
personne ne saurait que la cliente n'a rien reçu.

Les quatre métriques `Sent`, `Skipped`, `TransientFailures` et
`PermanentFailures` sont publiées par la fonction au format **EMF** : CloudWatch
les extrait du journal, ce qui évite un appel `PutMetricData` dans le chemin
d'envoi et le droit IAM qui va avec. Elles sont publiées à chaque invocation, y
compris à zéro — c'est ce qui distingue « rien à envoyer » de « plus personne ne
consomme ».

Les alarmes ne préviennent que si `alarm_topic_arns` est renseigné :
`terraform output notification_alarms_notify` le dit.

### Rejouer la file d'attente morte

Une fois la panne corrigée — jeton remis, route rétablie, quota SES relevé :

```bash
QUEUE=$(terraform output -raw notification_dispatch_queue_url)
DLQ=$(aws sqs get-queue-url --queue-name "$(terraform output -raw notification_dispatch_dlq_name)" --query QueueUrl --output text)

aws sqs start-message-move-task \
  --source-arn "$(aws sqs get-queue-attributes --queue-url "$DLQ" \
       --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)" \
  --destination-arn "$(aws sqs get-queue-attributes --queue-url "$QUEUE" \
       --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
```

L'idempotence de #68 rend l'opération sans danger : un message déjà envoyé est
reconnu et ignoré. Ce qui ne l'est pas, c'est de rejouer **avant** d'avoir
corrigé la cause — les messages reprendraient le même chemin et reviendraient en
DLQ, cinq réceptions plus tard.

Avant de rejouer, lire ce que la fonction a dit d'eux :

```bash
aws logs tail "/aws/lambda/$(terraform output -raw notification_dispatcher_function_name)" \
  --since 24h --filter-pattern '{ $.event = "notification.*" }'
```

### Éprouver le handler sans déployer

Les deux règles de reprise sont des affirmations sur ce que la fonction **rend**,
que ni `terraform validate` ni la lecture du code ne prouvent :

```bash
cd infra/terraform/modules/notifications/lambda && node dispatcher.smoke.mjs
```

Trois vérifications : le tri des issues (seuls les transitoires sont rendus à
SQS), la garde de fin de temps imparti, et le défaut fermé. Ce script n'est
**pas** joué par `npm run verify` — ce dossier n'appartient à aucun espace de
travail npm, et l'y rattacher demanderait de toucher le `package.json` de la
racine. Une issue de suivi porte ce câblage.

### Ce qui reste à faire ailleurs

- **La route d'envoi côté API** (#70) : c'est elle que `dispatch_url` désigne,
  et le contrat ci-dessus est ce qu'elle doit servir. Tant qu'elle n'existe pas,
  la chaîne est posée et inerte — visiblement inerte.
- **Le jeton partagé** : Terraform crée le droit de le lire, pas sa valeur. Le
  secret se dépose hors code, comme celui d'exécution de l'API.

  **À éprouver en développement avant staging.** La fonction lit ce secret avec
  `@aws-sdk/client-secrets-manager`, qu'elle attend du runtime `nodejs20.x` —
  l'archive ne transporte aucune dépendance, c'est ce qui lui évite une étape de
  construction. Si le runtime ne le fournissait pas, l'import échouerait, tous
  les messages deviendraient transitoires et la file entière partirait en DLQ. Le
  journal distingue ce cas des autres : un `notification.token_unavailable` avec
  `code: "ERR_MODULE_NOT_FOUND"` désigne le runtime, un refus IAM ou une panne
  réseau porte un autre code. Le remède, si le cas se présente, est de vendre le
  client dans l'archive ou de passer par l'extension Lambda de Secrets Manager —
  hors du périmètre de #67, une issue de suivi le porte.
- **La publication du rappel J-1** (#71) : la règle EventBridge cible cette file,
  avec la politique `dispatch_producer_policy_arn` sur son rôle.

## Coût

Négligeable devant le reste de l'environnement, mais non nul :

| Poste | Ordre de grandeur |
|---|---|
| Clé KMS | 1 USD / mois / environnement — partagée par le topic et les deux files |
| SES | 0,10 USD / 1000 messages hors Free Tier |
| SNS (événements) | quelques centimes — seuls les échecs publient |
| Route 53 | aucun coût propre, la zone préexiste |
| SQS | premier million de requêtes gratuit ; l'interrogation longue divise le reste par vingt |
| Lambda | quelques centimes — arm64, 256 Mio, un appel HTTP par message |
| Métriques EMF | 4 métriques × 0,30 USD / mois / environnement |
| Tableau de bord | gratuit jusqu'à trois par compte, soit un par environnement |

Le choix de ne publier ni `SEND` ni `DELIVERY` est aussi un choix de coût : ces
deux types produisent un message SNS **par envoi réussi**, pour une information
que la table `notifications` porte déjà (skill notifications §2). Le même
raisonnement vaut pour la Lambda, laissée **hors VPC** : elle n'appelle que
l'API et CloudWatch, et la placer dans les sous-réseaux applicatifs lui
imposerait des interfaces réseau et une sortie facturée au gigaoctet par la NAT
Gateway, pour aucun accès qu'elle n'ait déjà.

## Références

- CDC §4.8 (chaîne de notifications), §6 (risque de délivrabilité), §5.1 (RGPD)
- [.claude/skills/notifications/SKILL.md](../../../../.claude/skills/notifications/SKILL.md) §1 (architecture), §4 (échecs et reprises), §5 (délivrabilité), §7 (RGPD)
- [.claude/skills/aws-infra/SKILL.md](../../../../.claude/skills/aws-infra/SKILL.md) §2, §5 (moindre privilège), §7, §8 (alarmes et rétention), §9 (coûts)
- `apps/api/src/modules/notifications/README.md` — l'ordre d'écriture et
  l'idempotence dont ce module est le transport
