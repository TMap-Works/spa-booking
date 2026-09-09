# Module `cdn`

Une distribution CloudFront devant l'ALB, les enregistrements DNS qui la
désignent, et le point d'accroche du WAF de bord.

Le CDC §4.4 demande une « distribution HTTPS, cache proche des utilisateurs,
intégration WAF » ; le §4.10 veut le pare-feu applicatif « en amont de
CloudFront/ALB ». Ce module est la moitié « CloudFront » de ces deux phrases ;
l'autre moitié est le module `waf`, composé une seconde fois en portée
`CLOUDFRONT`.

## Ce que la distribution apporte, dans l'ordre

1. **Un endroit où poser le WAF avant la région.** Une Web ACL de portée
   `CLOUDFRONT` bloque au point de présence, avant la traversée de l'Internet
   jusqu'à `eu-west-3`, et elle y voit l'adresse réelle de la cliente — que
   l'ALB, une fois derrière un CDN, ne voit plus.
2. **La terminaison TLS et HTTP/3 au plus près de la visiteuse.** Sur un tunnel
   de réservation, la poignée de main pèse dans le temps de la première page.
3. **Le cache des fichiers empreintés de Next.js**, et rien d'autre.

## Ce qu'elle n'apporte pas

**Elle ne rend pas l'ALB privé.** Celui-ci reste joignable par son nom
`*.elb.amazonaws.com`, et une requête qui l'atteint directement contourne la
distribution, donc son WAF de bord.

Ce qui couvre ce chemin est la **seconde Web ACL**, de portée `REGIONAL`,
associée à l'ALB. `envs/prod` compose les deux, et c'est la seule raison d'être
de la seconde. Fermer complètement le contournement demanderait un en-tête
partagé posé par CloudFront et vérifié par une règle d'écoute de l'ALB, que le
module `ecs-service` n'expose pas aujourd'hui.

## Le piège de l'origine

`origin_domain_name` **n'est jamais** le nom `*.elb.amazonaws.com` de l'ALB, et
une validation du module le refuse explicitement.

CloudFront vérifie le certificat de son origine et refuse une connexion dont le
certificat ne couvre pas le nom appelé. Aucun certificat public n'existe pour un
nom `elb.amazonaws.com` : l'origine se joint donc par un nom à soi,
`origin.<domaine>`, que ce module fait pointer sur l'ALB par un alias Route 53 et
que le certificat du listener 443 doit couvrir.

Le symptôme, quand cela manque : **`502` rendu par CloudFront, ALB parfaitement
sain, ses journaux d'accès vides**, et rien qui nomme le certificat. C'est la
panne la plus longue à diagnostiquer de cette chaîne.

## Ce qui est mis en cache, et ce qui ne l'est pas

Le comportement **par défaut est `CachingDisabled`** : tout va à l'origine à
chaque requête. Ce n'est pas une frilosité, c'est la seule position tenable —
une page de disponibilités, un tableau de bord ou une réponse d'API portent des
données propres à un établissement et parfois à une cliente. Les mettre en cache
au bord du réseau les livrerait à la visiteuse suivante, et l'isolation
multi-tenant que tout le reste du produit défend s'effondrerait à l'endroit le
plus difficile à observer.

Seuls les chemins de `cached_path_patterns` sont cachés — par défaut
`/_next/static/*`, dont les noms portent une empreinte du contenu.

## Deux certificats, deux régions

CloudFront n'accepte que des certificats ACM de **`us-east-1`**, et le module
`ecs-service` refuse au plan un certificat d'une autre région que son ALB. Le
même domaine est donc certifié deux fois. Voir `modules/certificate/README.md`.

## Journaux d'accès

Ce module n'active pas les journaux d'accès standard de CloudFront : ils
demandent un compartiment S3 dédié, avec sa politique et son cycle de vie, pour
une information que les journaux du WAF — décisions de blocage — et ceux de
l'ALB portent déjà pour l'essentiel. À reprendre le jour où l'analyse du trafic
de bord devient un besoin réel.

## Exemple

```hcl
module "cdn" {
  source = "../../modules/cdn"

  environment = "prod"

  domain_name        = "reservation.exemple.fr"
  origin_domain_name = "origin.reservation.exemple.fr"

  alb_dns_name = module.ecs_service.alb_dns_name
  alb_zone_id  = module.ecs_service.alb_zone_id

  route53_zone_id = var.route53_zone_id

  # Certificat et Web ACL de bord : tous deux dans us-east-1.
  certificate_arn = module.certificate_edge.certificate_arn
  web_acl_arn     = module.waf_edge.web_acl_arn
}
```
