# notifications — délivrabilité e-mail (SES)

Ce module pose la moitié « infrastructure » de la chaîne de notifications du
CDC §4.8 : le domaine d'envoi, sa signature, sa politique d'authentification, et
le canal par lequel remontent les rebonds et les plaintes.

Il existe pour un risque nommé au CDC §6 : **une délivrabilité insuffisante vide
le rappel J-1 de son sens**. Un rappel qui arrive dans les indésirables ne réduit
aucun no-show ; il coûte le même envoi et ne rapporte rien.

Périmètre volontairement resserré, et complémentaire d'autres tickets :

| Ce module | Ailleurs |
|---|---|
| Identité de domaine, DKIM, SPF, DMARC | — |
| Jeu de configuration, liste de suppression | — |
| Topic SNS des événements de remise | Son traitement applicatif : #73 |
| — | File SQS, Lambda d'envoi, DLQ : #67 |
| — | SMS (SNS, plafond, sender ID) : #66 |
| — | Modèles de messages par tenant : #69 |

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Identité SESv2 | `{domain}` | Domaine d'envoi, signé par Easy DKIM (RSA 2048) |
| Attributs MAIL FROM | `mail.{domain}` | Domaine d'enveloppe, pour l'alignement SPF |
| Jeu de configuration | `spa-{env}-email` | TLS exigé, métriques de réputation, liste de suppression |
| Destination d'événements | `spa-{env}-delivery-events` | Rebonds, plaintes, refus, échecs de rendu → SNS |
| Topic SNS | `spa-{env}-ses-events` | Canal des événements, chiffré |
| Clé KMS + alias | `alias/spa-{env}-ses-events` | Chiffre le topic — un rebond porte une adresse |
| Enregistrements Route 53 | 6 | **Seulement si `route53_zone_id` est fourni** |

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

## Coût

Négligeable devant le reste de l'environnement, mais non nul :

| Poste | Ordre de grandeur |
|---|---|
| Clé KMS | 1 USD / mois / environnement |
| SES | 0,10 USD / 1000 messages hors Free Tier |
| SNS (événements) | quelques centimes — seuls les échecs publient |
| Route 53 | aucun coût propre, la zone préexiste |

Le choix de ne publier ni `SEND` ni `DELIVERY` est aussi un choix de coût : ces
deux types produisent un message SNS **par envoi réussi**, pour une information
que la table `notifications` porte déjà (skill notifications §2).

## Références

- CDC §4.8 (chaîne de notifications), §6 (risque de délivrabilité), §5.1 (RGPD)
- [.claude/skills/notifications/SKILL.md](../../../../.claude/skills/notifications/SKILL.md) §5
- [.claude/skills/aws-infra/SKILL.md](../../../../.claude/skills/aws-infra/SKILL.md) §2, §7
