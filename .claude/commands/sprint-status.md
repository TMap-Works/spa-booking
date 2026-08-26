---
description: Fait le point sur le sprint en cours — avancement, blocages, risques sur le jalon
argument-hint: [S1|S2|S3|S4] (défaut : sprint en cours)
allowed-tools: Bash(gh *), Bash(git *), Read
---

Fais le point sur le sprint **$1** (à défaut, le milestone ouvert dont l'échéance
est la plus proche).

Rassemble les données :

- `gh issue list --milestone "<milestone>" --state all --json number,title,state,labels,assignees`
- `gh pr list --state open --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup`
- `gh project item-list 2 --owner TMap-Works --format json`

Puis produis un point court et factuel :

1. **Avancement** — nombre d'issues fermées / total, réparti par workstream
   (`ws:*`). Signaler tout workstream nettement en retard sur les autres : le
   calendrier d'un mois du CDC repose sur leur parallélisme.
2. **Produit contre outillage** — la même répartition selon `nature:*`. C'est le
   chiffre que le décompte par workstream cache : un sprint où l'outillage pèse
   plus que le produit avance sur son dispositif, pas sur son MVP. Le dire
   franchement, avec les deux nombres, sans le commenter en bien ou en mal —
   l'arbitrage appartient à l'humain.
3. **En cours** — qui travaille sur quoi, et depuis combien de temps. Signaler
   toute branche ouverte depuis plus de 5 jours ouvrés.
4. **Bloqué** — PR en attente de revue, CI rouge, issues `P0` non commencées.
5. **Risque sur le jalon** — au vu du reste à faire, le critère de franchissement
   du jalon de fin de semaine est-il atteignable ? Dire oui ou non clairement,
   avec ce qu'il faudrait décaler le cas échéant.
6. **Périmètre** — issues créées cette semaine sans milestone ou labellisées
   `post-mvp` : c'est l'indicateur avancé du scope creep (CDC §6).

Rester factuel. Ne pas enjoliver un retard : le CDC identifie le glissement du
calendrier comme le risque n°1.
