# ADR 0014 — La bande de priorité passe avant le score d'importance dans un run de jalon

- **Statut** : Accepté
- **Date** : 2026-09-17
- **Décideurs** : équipe TMap-Works (#1020)
- **Contexte CDC** : §1.4 Rappel du périmètre MVP, §3.1 Méthodologie (définition
  de « terminé »), §1.3 Enseignements tirés de l'analyse de Booker

## Contexte

`scripts/milestone_plan.py` répond à deux questions et à elles seules : dans quel
ordre dérouler les issues d'un jalon, et lesquelles peuvent avancer en même
temps. L'ordre reposait depuis l'origine sur une **somme** :

```
score = PRIORITY_SCORE[priorité] + bonus risk/security + 4 × ce que l'issue débloque
        (P0 100 · P1 60 · P2 25)
```

Cette somme mélange deux choses de nature différente. « Ce ticket est
indispensable au MVP » est un jugement de valeur porté par un humain sur le
produit ; « ce ticket en débloque neuf autres » est une propriété du graphe. Les
additionner revient à dire qu'un ticket souhaitable qui ouvre la voie vaut un
ticket indispensable — et neuf dépendants suffisaient à le prouver :
25 + 9 × 4 = 61 contre 60.

Ce n'est pas une hypothèse. Le jalon **« Design & UX »** en donnait l'exemple :
sur 83 issues ouvertes, #970 (`P2`, 76 dépendants par la règle « l'écran consomme
les contrats partagés ») sortait en **vague 2 avec 345 points**, devant cinq des
six `P1` du jalon. Un run qui s'interrompt — coupure de quota, fin de nuit, démo
à tenir le soir même — avait alors livré le souhaitable avant l'indispensable, ce
qui est l'inverse de ce qu'on lui demande.

Le même jalon posait un second problème, symétrique du premier. Ses **76 `P2`
étaient à égalité parfaite** : 25 points chacun, départagés par leur numéro
d'issue, c'est-à-dire par leur ordre de création. L'ordre du plan y était donc
arbitraire, alors même que l'information manquante existait déjà : l'audit de
conception écrit en tête de chaque ticket l'impact qu'il a constaté — `moyen`
(« dégrade l'usage sans l'empêcher ») ou `faible` (« finition ») —, deux cases
que la grille de `.claude/skills/design-audit/SKILL.md` §4 distingue
explicitement et que le label `P2` écrase, faute d'une troisième valeur de
priorité. Sur ce jalon, 54 tickets `moyen` étaient rendus indiscernables de
19 tickets de finition.

## Options envisagées

### Option A — Rehausser `PRIORITY_SCORE` jusqu'à ce que la somme ne s'inverse plus

Porter `P1` à 1 000 et `P2` à 10 rend l'inversion improbable. C'est la correction
d'une ligne, et elle ne demande aucune relecture.

Elle ne tient pas : « improbable » n'est pas « impossible », et le seuil dépend du
nombre de dépendants, qui grandit avec le jalon. Surtout, elle laisse croire que
la priorité est commensurable au déblocage, alors que toute la question est
qu'elle ne l'est pas. Un lecteur du code ne peut pas savoir si 1 000 est un choix
ou un reste.

### Option B — Trier par bande de priorité, puis par score à l'intérieur de la bande

L'ordre devient lexicographique : `(bande, −score, numéro)`. Tous les `P0`, puis
tous les `P1`, puis tous les `P2`. Le score continue de faire ce qu'il fait bien
— ordonner des tickets comparables entre eux — et cesse de faire ce qu'il faisait
mal.

Coût : un `P2` qui débloque beaucoup est dispatché plus tard, donc ses dépendants
aussi. Sur « Design & UX », le retard est borné à deux vagues, parce que l'ordre
**topologique** prime toujours sur la bande : un `P1` qui dépend d'un `P2` reste
derrière lui, sans quoi le plan dispatcherait sur une base amputée (#155).

### Option C — Classer les `P2` à la main, ticket par ticket

Un jalon de 76 `P2` se relit en une heure, et l'humain sait ce que l'heuristique
ignore. Mais l'ordre serait à refaire à chaque campagne d'audit, et il ne
survivrait pas au `replan` que chaque leg d'un run exécute. Un classement qui ne
se recalcule pas n'est pas un classement, c'est une photo.

## Décision

**La priorité est une bande, pas un terme d'une somme.** `rank_key()` trie par
`(PRIORITY_BAND[priorité], −score, numéro)`. Aucun bonus, aucun déblocage, aucun
réglage ne fait franchir une bande. L'ordre topologique, lui, prime sur la bande.

**À l'intérieur d'une bande, le score répond à « qu'est-ce qui coûte le plus de
ne pas faire ? »**, et il agrège quatre sources, toutes adossées à un écrit du
dépôt :

| Terme | Poids | D'où il vient |
|---|---|---|
| ce que le ticket débloque | 4 par dépendant | le graphe du plan, inchangé |
| `risk` · `security` | 15 · 10 | `LABEL_BONUS`, inchangé |
| impact de l'audit | `fort` 20 · `moyen` 12 · `faible` 0 | l'en-tête écrite par `design_tickets.py`, grille `.claude/skills/design-audit/SKILL.md` §4 |
| étape de la boucle de valeur | 10 à 0 selon `mod:*` | « réserver → confirmer → honorer → encaisser → mesurer » (CLAUDE.md) |
| critère d'audit bloquant | 6 à 2 | `ds:parcours`, `ds:confiance`, `ds:etats`, `ds:mobile` — les quatre critères de la grille qui portent sur ce qui **empêche de décider ou d'avancer** |

Les six autres critères de la grille valent 0 : la pondération corrige une
égalité, elle ne hiérarchise pas dix critères qui n'ont pas d'ordre écrit.

**Une soupape manuelle, bornée.** `.claude/milestone-rules.json` gagne une section
`weights`, écrite par `python scripts/milestone_rules.py set-weight <issue>
<points> --why "<motif>"`, bornée à ±40 points. Elle remonte un ticket dans **sa**
bande — jamais au-delà. C'est ce qui permet de dire « cet écran-là passe en
premier, la démo est demain soir » sans toucher au code ni mentir sur la priorité
du ticket.

## Conséquences

**Ce que cela facilite.** Un run interrompu a livré l'indispensable avant le
souhaitable, quel que soit l'endroit où il s'arrête — c'est la seule propriété
qui compte quand un jalon ne va pas à son terme, et c'est le cas nominal
(coupure de quota, fenêtre de nuit, ADR 0004). Sur « Design & UX », les 19
tickets de finition descendent du milieu du plan à son dernier quart, où ils
étaient attendus.

**Ce que cela coûte.** Un `P2` qui ouvre la voie attend désormais les `P1`, et ses
dépendants avec lui. Le plan affiche donc parfois des vagues plus étroites que la
largeur demandée — c'est le prix assumé de la promesse.

**Ce que cela ferme.** On ne peut plus faire remonter un ticket en jouant sur ses
dépendances ou sur un label `risk` posé à la légère. Le seul levier qui franchit
une bande est la **priorité de l'issue**, qui se corrige sur GitHub, se relit dans
l'historique et engage celui qui la change.

**Ce que cela suppose, et qui peut se périmer.** La lecture de l'impact repose sur
le gabarit d'en-tête de `design_tickets.corps()`. Si ce gabarit change sans que
`AUDIT_HEADER` suive, les tickets d'audit perdent silencieusement 12 à 20 points
— tous, donc leur ordre relatif tient, mais ils passent derrière les tickets
d'autres provenances. `scripts/tests/test_milestone_plan.py::ImpactDeLAudit`
recopie le gabarit pour que ce soit le test qui rougisse, et pas le plan.

**Ce que cela ne corrige pas.** La règle heuristique « l'écran consomme les
contrats partagés » fait dépendre *tout* le frontend d'un jalon de n'importe quel
ticket touchant `contracts:shared`. C'est elle, et non le score, qui maintient
#970 en vague 2 du jalon « Design & UX ». Resserrer cette arête — au module, ou
aux tickets qui citent réellement le contrat — est une décision distincte, à
prendre en pesant le risque de conflit de fusion qu'elle rouvre.
