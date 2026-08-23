---
description: Ouvre la pull request de la branche courante avec le titre, le corps et les vérifications attendus
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob
---

Ouvre la pull request de la branche courante en respectant
[.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md).

Étapes :

1. Déduire le numéro d'issue depuis le nom de la branche
   (`feature/42-...` → issue 42). Si le nom ne le contient pas, s'arrêter et le
   signaler : l'automatisation du Project en dépend.
2. Relire les commits (`git log develop..HEAD`) et le diff complet.
3. **Contrôles avant ouverture** — signaler tout manquement et demander quoi faire
   plutôt que d'ouvrir une PR incomplète :
   - un secret, une clé ou un `.env` dans le diff ;
   - un endpoint ajouté sans test d'isolation inter-tenant ;
   - une migration Prisma non réversible ou non additive ;
   - une entité Prisma renvoyée telle quelle par un contrôleur ;
   - un type d'API dupliqué dans `apps/web` au lieu de `packages/shared` ;
   - un message de commit qui ne respecte pas Conventional Commits.
4. Lancer les vérifications locales disponibles (lint, types, tests) et rapporter
   fidèlement les résultats, échecs compris.
5. Ouvrir la PR vers **`develop`** (ou `main` pour un `hotfix/*`) :
   - titre en Conventional Commits, portée = module concerné ;
   - corps : contexte, ce qui change, comment le vérifier, points d'attention pour
     la revue, et la ligne `Closes #<numéro>` ;
   - reprendre les critères d'acceptation de l'issue sous forme de cases cochées.
6. Afficher l'URL de la PR et l'état de la CI (`gh pr checks`).
