# Module `certificate`

Un certificat ACM **validé par DNS**, ses enregistrements de validation, et
l'attente de son émission.

Le CDC §4.9 demande des « certificats pour ALB et CloudFront, renouvellement
automatique ». Ce module ne fait rien d'autre — et c'est le mot
*automatique* qui décide de tout ce qui suit.

## Ce que « renouvellement automatique » exige réellement

ACM réémet un certificat **validé par DNS** environ soixante jours avant son
échéance, sans intervention. Il ne le fait qu'à une condition : les
enregistrements CNAME de validation doivent être **toujours publiés** ce jour-là.

Trois conséquences, qui sont la raison d'être de ce module :

1. **La validation par courriel est exclue.** Elle redemande à un humain de
   cliquer un lien tous les treize mois. C'est une panne de production
   programmée à date connue, et personne n'aura le contexte le jour venu.
2. **Les CNAME de validation ne se suppriment jamais.** Rien ne casse le jour où
   on les retire. La coupure arrive un an plus tard, et rien ne la relie au geste
   qui l'a causée. Quand `route53_zone_id` est fournie, le module les tient
   lui-même — c'est le seul régime où l'oubli est impossible.
3. **`renewal_eligibility` est la seule preuve.** La sortie du même nom vaut
   `ELIGIBLE` quand ACM peut renouveler seul. C'est ce qu'on relit après avoir
   touché à la zone, pas la date d'expiration.

## Deux certificats en production, et pourquoi

ACM est un service **régional**, et CloudFront n'accepte que des certificats de
`us-east-1`. Le même nom de domaine est donc certifié deux fois :

| Usage | Région | Porté par |
|---|---|---|
| `edge` | `us-east-1` | la distribution CloudFront |
| `alb` | celle de l'environnement | le listener 443 de l'ALB |

Deux barrières le rappellent, chacune à sa manière : le module `ecs-service`
refuse **au plan** un certificat d'une autre région que son ALB
(`modules/ecs-service/alb.tf`), et CloudFront refuse **à l'apply** un certificat
hors `us-east-1`. La sortie `region` est là pour trancher en une lecture.

## Le nom que le certificat de l'ALB doit couvrir

Ce n'est pas celui qu'on croit. CloudFront **vérifie** le certificat de son
origine et refuse une connexion dont le certificat ne couvre pas le nom appelé.
Un ALB joint par son nom `*.elb.amazonaws.com` ne peut donc pas être une origine
HTTPS, quelle que soit la validité du certificat qu'il porte : aucun certificat
public n'existe pour ce nom.

L'origine se joint donc par un nom à soi — `origin.<domaine>` dans `envs/prod` —,
et c'est **ce nom-là**, pas le nom public, que le certificat de l'ALB doit
couvrir. C'est la panne la plus coûteuse à diagnostiquer de tout ce module :
CloudFront rend un `502`, l'ALB est sain, ses journaux d'accès sont vides, et
rien ne nomme le certificat.

## Ne pas faire se recouvrir deux certificats

`subject_alternative_names` existe, et il faut résister à l'envie d'y remettre un
nom qu'un **autre** certificat du compte couvre déjà.

**ACM émet le même enregistrement CNAME de validation pour un domaine donné dans
un compte donné**, quelle que soit la région et quel que soit le certificat. Deux
certificats qui se recouvrent font donc gérer le même enregistrement Route 53 par
deux instances de ce module. Rien ne casse à la création — les deux écrivent la
même valeur. Mais le jour où l'un des deux certificats est détruit, il emporte
l'enregistrement dont l'autre a encore besoin, et le renouvellement de celui qui
reste échoue **un an plus tard**, sans que rien ne relie la panne au geste qui
l'a causée.

C'est l'accident que la validation par DNS est censée rendre impossible. En
production, le certificat de l'ALB couvre `origin.<domaine>` et celui de bord
couvre `<domaine>` : deux ensembles disjoints, deux enregistrements distincts.

## Pas de joker, et pourquoi

`domain_name` et `subject_alternative_names` refusent un nom en `*.`.

La raison est mécanique. Les enregistrements de validation sont posés par un
`for_each`, dont les **clés doivent être connues au plan** : elles viennent donc
des noms déclarés en variables, et non de `domain_validation_options`, qui
n'existe pas encore sur un certificat neuf. Or un joker et son apex —
`*.exemple.fr` et `exemple.fr` — partagent **un seul** enregistrement de
validation. Deux clés distinctes produiraient deux ressources Route 53 se
disputant le même nom, et aucune déduplication n'est possible au plan puisque le
nom de l'enregistrement n'est connu qu'à l'`apply`.

Plutôt qu'un conflit à l'`apply` ou une divergence permanente, le module refuse
au plan, avec le message qui l'explique. Ce dépôt n'a pas besoin de joker : les
noms servis sont énumérables.

## Sans Route 53

`route53_zone_id = null` crée le certificat et s'arrête là. Il reste
`PENDING_VALIDATION`, la sortie `validation_records` donne la liste exacte à
publier chez le registraire, et `wait_for_validation` est sans effet — attendre
un enregistrement que personne ne va poser serait attendre pour toujours.

Une fois publiés à la main, ces enregistrements sont soumis au point 2 ci-dessus,
sans qu'aucun code ne les protège. C'est la raison de préférer une zone Route 53
en production.

## Exemple

```hcl
module "certificate_alb" {
  source = "../../modules/certificate"

  environment = "prod"
  usage       = "alb"

  # Le nom que CloudFront appelle, et lui seul : le public passe par la
  # distribution, jamais par l'ALB — et ajouter le nom public en SAN ferait se
  # recouvrir ce certificat et celui de bord (voir la section ci-dessus).
  domain_name = "origin.reservation.exemple.fr"

  route53_zone_id = var.route53_zone_id
}
```

Le certificat d'`edge` se compose à l'identique, avec `usage = "edge"` et un
provider aliasé sur `us-east-1`.
