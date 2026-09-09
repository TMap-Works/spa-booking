# Runbooks d'exploitation

Procédures d'incident. Elles se lisent **avant** d'en avoir besoin : un runbook
découvert pendant une panne est une documentation, pas une procédure.

| Runbook | Quand l'ouvrir |
|---|---|
| [pra-restauration-rds.md](pra-restauration-rds.md) | La donnée est perdue, corrompue, ou l'instance a disparu |
| [pra-bascule-az.md](pra-bascule-az.md) | Une zone de disponibilité est tombée, la donnée est intacte |
| [recette-staging.md](recette-staging.md) | Monter l'environnement de recette, y charger ses données, comprendre son arrêt hors heures ouvrées |
| [mise-en-production.md](mise-en-production.md) | Appliquer la production pour la première fois, comprendre un déploiement rouge, revenir en arrière |

Entre les deux premiers, le réflexe est de savoir **lequel** : restaurer une base
saine parce qu'une zone est tombée coûte des heures pour rien, et attendre une
bascule qui n'aura pas lieu — la base est mono-AZ hors production — coûte
davantage. `terraform output rds_multi_az` tranche en une commande.

Les deux derniers ne sont pas des runbooks d'incident. `recette-staging.md` se
déroule avant une campagne de recette ; `mise-en-production.md` couvre le premier
`apply` de la production, la lecture d'un déploiement rouge et le retour en
arrière. Tous deux portent la liste des gestes que seule une session humaine avec
des identifiants AWS peut poser.

Le retour en arrière se lit **avant** d'en avoir besoin, comme les deux premiers :
sa section 6.2 dit ce que le rollback automatique ne défait pas — les migrations
de schéma — et la contrainte qui en découle sur la manière de les écrire.

## Objectifs de continuité (CDC §4.14)

| Mesure | Cible |
|---|---|
| **RPO** — perte de données maximale tolérée | ≤ 1 heure |
| **RTO** — temps de reprise visé | ≤ 4 heures |

Ces cibles ne sont tenues par aucune configuration à elle seule. Ce qui les
tient, dans ce dépôt :

- les **sauvegardes automatiques RDS** (`backup_retention_period`, module
  `database`) — la restauration à un instant donné, à cinq minutes près ;
- la **sauvegarde continue d'AWS Backup** (`continuous_backup_retention_days`,
  module `backup`) — la même chose depuis le coffre, sous une autre clé. Une
  précondition interdit de la désactiver en production, parce qu'un plan
  seulement quotidien plafonne le RPO à 24 h ;
- le **Multi-AZ** en production — RPO nul sur une panne de zone, la réplication
  étant synchrone ;
- ces deux runbooks, **exercés**. Une procédure jamais jouée ne prouve aucun RTO.

## État : procédures écrites, pas encore exercées

Le critère « restauration effectivement testée » du CDC §4.14 et de l'issue #82
**n'est pas tenu**. Ce dépôt n'a accès à aucun compte AWS, et ni une
restauration ni une bascule ne se simulent : ce qu'elles apprennent — la durée
réelle de création d'une instance, le comportement des métadonnées d'AWS Backup,
le délai de rétablissement applicatif après une bascule — ne s'obtient qu'en les
jouant.

Chaque runbook porte en dernière section la liste précise de ce qui reste à
exercer, et un tableau de relevé de temps à remplir. La cadence des exercices est
au §7 de [pra-restauration-rds.md](pra-restauration-rds.md) : au-delà de six mois
sans exercice, le runbook cesse d'être une procédure testée.
