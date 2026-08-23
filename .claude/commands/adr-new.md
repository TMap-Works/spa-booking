---
description: Rédige un Architecture Decision Record dans docs/adr
argument-hint: <titre de la décision>
allowed-tools: Read, Write, Glob, Grep, Bash(git *)
---

Rédige un ADR pour la décision : **$1**

1. Déterminer le prochain numéro en listant `docs/adr/`.
2. Créer `docs/adr/{NNNN}-{slug}.md` à partir de
   [docs/adr/template.md](docs/adr/template.md).
3. Remplir les sections :
   - **Contexte** — le problème, les contraintes du CDC qui s'appliquent, ce qui
     rend la décision nécessaire maintenant.
   - **Options envisagées** — au moins deux, avec leurs compromis réels. Une
     option écartée sans raison lisible ne sert à rien.
   - **Décision** — ce qui est retenu, à l'affirmatif.
   - **Conséquences** — ce que cela facilite, ce que cela coûte, ce que cela
     ferme. Inclure les conséquences désagréables : c'est leur absence qui rend
     un ADR inutile six mois plus tard.
   - **Statut** — `Proposé` par défaut.
4. Si la décision contredit ou précise une skill de `.claude/skills/`, le signaler
   et proposer la mise à jour de la skill correspondante.
