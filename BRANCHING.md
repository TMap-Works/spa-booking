# Modèle de branching — GitFlow simplifié

Identique aux autres dépôts TMap-Works.

## Branches permanentes

| Branche | Environnement | Rôle | Protection |
|---------|---------------|------|------------|
| `develop` | Development | Intégration continue du code | PR requise, 1 approbation |
| `staging` | Staging | Validation pré-production (UAT) | PR requise, 1 approbation |
| `main` | Production | Code stable déployé en production | PR requise, 2 approbations |

Flux unidirectionnel : `develop` → `staging` → `main`.
Aucun merge inverse sauf hotfix.

## Branches temporaires

| Type | Convention | Exemple | Base | Merge vers |
|------|-----------|---------|------|------------|
| feature | `feature/<issue>-<description>` | `feature/42-moteur-disponibilite` | `develop` | `develop` |
| bugfix | `bugfix/<issue>-<description>` | `bugfix/57-fuseau-horaire-rappel` | `develop` | `develop` |
| hotfix | `hotfix/<issue>-<description>` | `hotfix/61-webhook-stripe` | `main` | `main`, puis back-merge manuel |

Le **numéro d'issue dans le nom de branche est obligatoire** : c'est ce qui relie
la branche à sa carte du GitHub Project.

Durée de vie maximale recommandée : **5 jours ouvrés**. Sur un MVP de 4 semaines,
une branche plus longue diverge douloureusement.

## Workflow quotidien

```bash
git checkout develop
git pull origin develop
git checkout -b feature/42-moteur-disponibilite

# ... travail ...

git add .
git commit -m "feat(availability): calcul des créneaux avec buffers"
git push -u origin feature/42-moteur-disponibilite
# → PR vers develop, corps contenant "Closes #42"
# → 1 approbation requise avant merge
```

## Promotion develop → staging → main

```bash
# develop stable et validé localement :
# → PR develop → staging, 1 approbation (Tech Lead ou PO)
# → le merge déclenche deploy-staging.yml

# staging validé par le PO :
# → PR staging → main, 2 approbations (CPTO + Tech Lead)
# → le merge déclenche deploy-production.yml (avec approbation manuelle)
```

## Hotfix (correction urgente en production)

```bash
git checkout main
git pull origin main
git checkout -b hotfix/61-webhook-stripe

# ... correction ...

git push -u origin hotfix/61-webhook-stripe
# → PR vers main (1 approbation accélérée)

# Après merge dans main : back-merge MANUEL, dans cet ordre
git checkout staging && git merge main && git push origin staging
git checkout develop && git merge main && git push origin develop
```

Oublier le back-merge fait réapparaître le bug au déploiement suivant.
