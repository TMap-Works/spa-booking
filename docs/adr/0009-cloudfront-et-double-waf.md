# ADR 0009 — CloudFront devant l'ALB, et deux Web ACL plutôt qu'une

- **Statut** : Accepté
- **Date** : 2026-09-09
- **Décideurs** : équipe plateforme TMap-Works
- **Contexte CDC** : §4.4 (CloudFront), §4.9 (certificats ACM), §4.10 (sécurité de
  l'infrastructure), §4.16 (budget)

## Contexte

Jusqu'à l'issue #77, la seule frontière publique des trois environnements était
l'ALB du module `ecs-service`, couvert par une Web ACL de portée `REGIONAL`. Le
CDC demande davantage pour la production : une distribution CloudFront (§4.4) et
un pare-feu applicatif « en amont de CloudFront/ALB » (§4.10).

Poser CloudFront devant un ALB déplace la frontière publique — et c'est
précisément ce qui rend la décision moins évidente qu'elle n'en a l'air. Trois
contraintes techniques la cadrent, dont deux ne sont pas contournables :

1. **CloudFront ne rend pas l'ALB privé.** L'ALB reste joignable par son nom
   `*.elb.amazonaws.com`. Fermer ce chemin demanderait un en-tête partagé posé
   par la distribution et vérifié par une règle d'écoute de l'ALB, que le module
   `ecs-service` n'expose pas.
2. **CloudFront vérifie le certificat de son origine.** Aucun certificat public
   n'existe pour un nom `*.elb.amazonaws.com` : l'origine doit être jointe par un
   nom du domaine du projet, couvert par le certificat du listener 443.
3. **WAF et ACM sont régionaux d'une manière asymétrique.** Une Web ACL de portée
   `CLOUDFRONT` et le certificat d'une distribution n'existent que dans
   `us-east-1` ; une Web ACL de portée `REGIONAL` et le certificat d'un ALB
   doivent être dans la région de la ressource qu'ils couvrent.

## Options envisagées

### Option A — Une seule Web ACL, régionale, sur l'ALB

C'est l'existant de `envs/dev` et `envs/staging`, conservé tel quel derrière la
distribution.

Le filtrage a lieu **après** la traversée du réseau jusqu'à `eu-west-3`, et sur
une adresse source qui n'est plus celle de la cliente : derrière un CDN, l'ALB
voit l'adresse du point de présence. La limitation de débit par IP, en
particulier, cesse de vouloir dire quelque chose — elle compterait le trafic
agrégé d'un point de présence entier. Cette option ne satisfait pas « en amont de
CloudFront » et **dégrade** la protection existante.

### Option B — Une seule Web ACL, de bord, sur la distribution

Le filtrage retrouve l'adresse réelle et bloque avant la région. Mais l'ALB
redevient une porte non filtrée : il suffit de connaître son nom DNS — que rien
ne cache — pour contourner l'intégralité des règles.

Poser un CDN aurait alors **affaibli** la sécurité en déplaçant le filtrage à un
endroit qu'on peut éviter. C'est le pire des trois résultats, et le plus
difficile à voir : les métriques de bord montreraient un pare-feu qui travaille.

### Option C — Deux Web ACL, une à chaque frontière

Le bord porte le jeu complet, y compris Bot Control ; la région porte les quatre
groupes gratuits et la limitation de débit, sans Bot Control — le trafic nominal
est déjà classé au bord, et le classer deux fois coûterait deux fois sans rien
apprendre.

Coût : environ 25 USD par mois au total, contre une douzaine pour une seule.

### Option D — Rendre l'ALB privé

Un en-tête partagé posé par CloudFront, vérifié par une règle d'écoute de l'ALB
qui rejette tout le reste. C'est la fermeture complète, et c'est la bonne réponse
sur le fond.

Elle demande d'ouvrir le module `ecs-service` à une règle d'écoute conditionnelle
et de gérer la rotation d'un secret partagé entre deux ressources qu'aucun module
commun ne relie. Écartée **pour l'instant**, pas sur le principe : c'est du
travail dans un module que six environnements-services traversent, et le faire
sous la pression d'un jalon de lancement est le meilleur moyen de casser dev et
staging.

## Décision

**Option C.** La production compose deux Web ACL :

- `module "waf_edge"`, portée `CLOUDFRONT`, dans `us-east-1`, associée à la
  distribution par son `web_acl_id` — jamais par `aws_wafv2_web_acl_association`,
  que WAF refuse pour cette portée ;
- `module "waf"`, portée `REGIONAL`, associée à l'ALB, sans Bot Control.

L'origine est jointe par `origin.<domaine>`, un alias Route 53 vers l'ALB, couvert
par le certificat du listener 443.

Les **deux certificats ACM sont validés par DNS**, sur une zone Route 53 confiée
au code. C'est la seule voie qui rende le renouvellement automatique du CDC §4.9
réellement automatique : ACM réémet soixante jours avant l'échéance tant que les
CNAME de validation restent publiés. La validation par courriel aurait demandé un
clic humain tous les treize mois — une panne de production programmée à date
connue.

La distribution ne se compose **que** si un nom de domaine et une zone existent
(`count`), comme le module `notifications` ne se compose que si un domaine
d'envoi existe. Sans domaine, il n'y a rien à mettre devant l'ALB : seulement un
`502`.

## Conséquences

**Ce que cela facilite.** Le filtrage a lieu au plus près de la cliente et sur
son adresse réelle ; le chemin de contournement reste couvert ; la terminaison
TLS et HTTP/3 se rapprochent des visiteuses ; les fichiers empreintés de Next.js
sont servis depuis le cache de bord.

**Ce que cela coûte.** Environ 25 USD par mois de Web ACL au lieu de 12, plus le
coût de CloudFront lui-même. Le budget de la production reste à 800 USD, dans la
fourchette du CDC §4.16, mais la marge est entamée.

**Ce que cela complique, et qu'il faut savoir avant d'y toucher :**

- **Deux régions dans un même état.** Trois ressources vivent dans `us-east-1` —
  certificat de bord, Web ACL de bord, et un **second topic SNS**, parce qu'une
  alarme CloudWatch ne notifie qu'un topic de sa propre région. Ce dernier a deux
  conséquences pratiques : un abonnement de plus à confirmer, et des journaux de
  WAF de bord à chercher dans `us-east-1` — la première fausse piste d'un
  incident de bord. C'est aussi pourquoi la Web ACL de bord est nommée
  `spa-prod-edge-waf` et non `spa-prod-waf` : sans ce suffixe, les deux Web ACL,
  leurs deux groupes de journaux et leurs deux jeux d'alarmes porteraient des noms
  rigoureusement identiques, que seule la région distinguerait.
- **Une panne difficile à diagnostiquer.** Si le certificat de l'ALB cesse de
  couvrir `origin.<domaine>`, CloudFront rend un `502`, l'ALB est parfaitement
  sain et ses journaux d'accès sont vides. Rien ne nomme le certificat. C'est dit
  dans `modules/cdn/README.md`, dans le message d'erreur de la sonde de santé de
  `deploy-production.yml`, et dans une validation du module qui refuse un
  `origin_domain_name` en `*.elb.amazonaws.com`.
- **Presque rien n'est mis en cache.** Le comportement par défaut est
  `CachingDisabled`, et ce n'est pas de la frilosité : mettre en cache une page
  de disponibilités ou une réponse d'API la livrerait à la visiteuse suivante,
  établissement compris. L'isolation multi-tenant que tout le reste du produit
  défend s'effondrerait à l'endroit le plus difficile à observer. Élargir
  `cached_path_patterns` est donc une décision à instruire route par route, pas
  un réglage de performance.
- **Bot Control est en comptage, pas en blocage.** Un faux positif sur un tunnel
  de réservation coûte une réservation. Le passer en blocage se décide après
  lecture de sa métrique `CountedRequests`, ce qui suppose du trafic réel — donc
  après le lancement.

**Ce que cela ferme.** Rien définitivement. L'option D reste ouverte et
souhaitable : le jour où `ecs-service` saura poser une règle d'écoute qui rejette
ce qui ne vient pas de la distribution, la Web ACL régionale deviendra une
seconde ligne au lieu d'une nécessité.
