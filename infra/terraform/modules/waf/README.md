# waf — filtrage applicatif en amont de l'ALB

Ce module pose la première barrière que rencontre une requête venue d'Internet :
une Web ACL AWS WAF v2, ses groupes de règles managés AWS, une limitation de
débit par adresse IP, sa journalisation et deux alarmes (CDC §4.10, skill
aws-infra §4).

Le CDC dit « en amont de CloudFront/ALB ». Aucune distribution CloudFront
n'existe dans ce dépôt : l'ALB du module `ecs-service` est donc la seule
frontière publique, et la Web ACL est de portée `REGIONAL`. Le jour où un
CloudFront apparaît, le module sait aussi produire une Web ACL de portée
`CLOUDFRONT` — voir « Passer à CloudFront » plus bas.

**Ce qu'il ne fait pas, et qu'aucun WAF ne fait.** Il filtre la *forme* des
requêtes — charge d'injection, en-tête malformé, débit anormal. Il ne connaît ni
les tenants, ni les rôles, ni les règles de réservation. L'isolation
inter-tenant reste entièrement du ressort de l'application
([tenant-isolation](../../../.claude/skills/tenant-isolation/SKILL.md)) ; un WAF
qui laisserait croire le contraire serait pire qu'aucun WAF.

## Ce qu'il crée

| Ressource | Nom | Rôle |
|---|---|---|
| Web ACL | `spa-{env}-waf` | Action par défaut `allow` — une liste de refus, pas d'autorisations |
| Règle | `limitation-de-debit` (priorité 1) | Plus de `rate_limit` requêtes en 5 min depuis une IP → 429 |
| Groupe managé | `AWSManagedRulesAmazonIpReputationList` (10) | Adresses de mauvaise réputation |
| Groupe managé | `AWSManagedRulesKnownBadInputsRuleSet` (20) | Charges d'exploitation publiées |
| Groupe managé | `AWSManagedRulesSQLiRuleSet` (30) | Injection SQL |
| Groupe managé | `AWSManagedRulesCommonRuleSet` (40) | XSS, LFI, tailles aberrantes |
| Groupe managé | `AWSManagedRulesBotControlRuleSet` (50) | Bots — **facturé**, en observation par défaut |
| Groupe de journaux | `aws-waf-logs-spa-{env}` | Décisions du WAF, en-têtes sensibles caviardés |
| Alarme | `spa-{env}-waf-blocked-requests` | Salve de blocages au-dessus du bruit de fond |
| Alarme | `spa-{env}-waf-rate-limited` | Une adresse inonde la plateforme |

L'ordre des priorités n'est pas neutre : WAF évalue par priorité croissante et
s'arrête au premier blocage. La limitation de débit passe donc avant tout —
inspecter le corps de dix mille requêtes pour découvrir qu'elles viennent de la
même adresse coûte l'inspection.

## Composition

```hcl
module "waf" {
  source = "../../modules/waf"

  environment        = local.environment
  log_retention_days = local.log_retention_days
  alarm_topic_arns   = [module.budgets.alerts_topic_arn]

  associated_resource_arns = {
    alb = module.ecs_service.alb_arn
  }
}
```

`associated_resource_arns` est une **map** et non une liste, pour la même raison
que `allowed_security_group_ids` dans les modules `database` et `cache` : la clé
est écrite par l'appelant, donc connue au plan, tandis que l'ARN de l'ALB est un
attribut calculé, inconnu au premier `apply`. Un `for_each` sur un ensemble
d'ARN échouerait sur « Invalid for_each argument ».

Laissée vide, la Web ACL existe et ne protège rien. C'est l'état d'un
environnement qui ne compose pas encore `ecs-service`, et c'est ce que la sortie
`protects_anything` sert à rendre visible : une Web ACL qui ne filtre rien a
exactement l'apparence d'une Web ACL calme.

## Observation avant blocage

`count_only_rule_groups` laisse un groupe managé s'évaluer et compter **sans
bloquer**. C'est le mode dans lequel un groupe doit vivre le temps de vérifier ce
qu'il aurait bloqué : un WAF posé d'emblée en blocage sur un parcours de
réservation coupe des clientes réelles, et personne ne le découvre avant le
premier appel au support.

Par défaut, seul `AWSManagedRulesBotControlRuleSet` y figure — c'est le plus
intrusif des cinq, celui qui classe le trafic plutôt que d'y chercher un motif.

La procédure pour l'en retirer, dans cet ordre :

1. lire la métrique `CountedRequests` du groupe sur une semaine complète, samedi
   compris — le samedi est le jour de pointe d'un salon ;
2. ouvrir les requêtes comptées dans `aws-waf-logs-spa-{env}` et vérifier
   qu'aucune ne vient du parcours de réservation ;
3. si une règle précise du groupe est en cause, la neutraliser seule par
   `counted_rules` plutôt que de désarmer le groupe entier :

```hcl
counted_rules = {
  AWSManagedRulesCommonRuleSet = ["SizeRestrictions_BODY"]
}
```

4. retirer le groupe de `count_only_rule_groups` et appliquer.

Le faux positif le plus courant sur cette plateforme est
`SizeRestrictions_BODY` : le groupe commun refuse un corps de requête au-delà de
8 Ko, ce qu'une fiche client avec notes peut dépasser.

## Journalisation

Deux arbitrages, tous deux visibles dans `logging.tf` :

- **`authorization` et `cookie` sont caviardés.** Sans cela, le journal du WAF
  serait le seul endroit de la plateforme où des jetons de session valides sont
  écrits en clair — une escalade de privilèges offerte à qui obtient
  `logs:GetLogEvents`.
- **Seules les requêtes bloquées ou comptées sont journalisées**
  (`log_only_inspected_requests`). Journaliser tout le trafic produirait une ligne
  par requête, soit le poste CloudWatch Logs le plus volumineux de la plateforme,
  pour une information que les journaux d'accès de l'ALB portent déjà. Le passer à
  faux le temps d'un incident donne la vue complète, au prix correspondant.

Le nom du groupe **doit** commencer par `aws-waf-logs-` : WAF refuse toute autre
destination, sur une erreur qui ne dit pas pourquoi.

`create_log_resource_policy` pose la politique de ressource CloudWatch Logs sans
laquelle la configuration de journalisation échoue sur un refus d'accès. Un
compte n'en admet que **dix par région** : trois environnements en consomment
trois.

## Coût

| Poste | Ordre de grandeur (USD/mois) |
|---|---|
| Web ACL | 5 |
| Règle ou groupe de règles | 1 par règle — 5 groupes managés + 1 règle de débit |
| Requêtes analysées | 0,60 par million |
| Bot Control | 10 par Web ACL, plus 1 par million de requêtes analysées |
| CloudWatch Logs | proportionnel au volume — d'où le filtre ci-dessus |

Soit environ 11 USD par mois hors Bot Control, 21 avec, pour un environnement à
faible trafic. Sur les 430 à 800 USD par mois du CDC §4.16, Bot Control est
acceptable en production et discutable en développement :
`bot_control_inspection_level = null` le retire.

## Passer à CloudFront

Le jour où une distribution CloudFront sert le front, la Web ACL qui la protège
obéit à deux contraintes qu'aucune variable ne peut porter :

1. elle doit être créée par un provider **aliasé sur us-east-1** — WAF n'accepte
   pas d'autre région pour la portée `CLOUDFRONT` ;
2. elle ne s'associe pas par `aws_wafv2_web_acl_association` : c'est la
   distribution qui la référence, par son argument `web_acl_id`.

Le module refuse d'ailleurs la combinaison contraire — une précondition de
`aws_wafv2_web_acl` arrête l'`apply` si `scope = "CLOUDFRONT"` est composé avec
un `associated_resource_arns` non vide.

Les deux Web ACL coexistent alors sans se gêner : la régionale continue de
protéger l'ALB, qui reste joignable directement tant qu'aucune règle ne l'en
empêche.
