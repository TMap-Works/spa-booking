---
description: Démarre le travail sur une issue — vérifie le contexte, crée la branche conforme et prépare le squelette
argument-hint: <numéro d'issue>
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob, Edit, Write
---

Démarre le travail sur l'issue **#$1** en suivant les conventions de
[.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md).

Étapes :

1. Lire l'issue : `gh issue view $1 --json number,title,body,labels,milestone,assignees`.
2. Vérifier qu'elle est exploitable. Signaler et **s'arrêter** si :
   - elle porte le label `post-mvp` (hors périmètre — CDC §1.4) ;
   - il manque un label `ws:*`, un label `mod:*` ou un milestone ;
   - le corps ne contient aucun critère d'acceptation vérifiable.
   Dans ce cas, proposer les corrections à appliquer à l'issue plutôt que de coder.
3. Vérifier que l'arbre de travail est propre, puis se placer sur `develop` à jour
   (`git checkout develop && git pull`). Pour un `hotfix/*`, partir de `main`.
4. Créer la branche `{type}/{$1}-{slug-du-titre}` où `type` découle du label
   `type:*` (`feature`, `bugfix`, `chore`, `docs`).
5. S'assigner l'issue si elle ne l'est pas — c'est ce qui bascule la carte du
   Project en `In progress`.
6. Charger les skills pertinentes selon les labels `mod:*` de l'issue :
   `booking-engine`, `tenant-isolation`, `api-module`, `payments-stripe`,
   `notifications`, `web-frontend`, `aws-infra`.
7. Localiser les fichiers concernés dans le dépôt et proposer un plan
   d'implémentation court, adossé aux critères d'acceptation de l'issue.

Ne pas commencer à écrire du code avant d'avoir présenté ce plan.
