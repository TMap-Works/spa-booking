# ADR 0010 — L'audit de conception est un dispositif distinct de la campagne de QA

- **Statut** : Accepté
- **Date** : 2026-09-16
- **Décideurs** : équipe TMap-Works (#730)
- **Contexte CDC** : §1.3 Enseignements tirés de l'analyse de Booker, §1.4 Rappel
  du périmètre MVP, §3.1 Méthodologie (définition de « terminé »)

## Contexte

Le dépôt dispose de quatre barrières, et chacune répond à une question
différente : `npm run verify` dit si ça compile et si les tests passent, la
recette MCP (ADR 0005) dit si ce qu'un ticket vient d'écrire répond quand on s'en
sert, la CI dit si le reste n'a pas cassé, et la campagne de QA dit si un
**seuil** est franchi quand on s'en sert.

Aucune ne pose la question de la conception. Un écran peut franchir les quatre —
compiler, répondre en 80 ms, tenir à 360 px, ne rien écrire dans la console — et
rester mal conçu :

- trois écrans qui nomment le même objet de trois façons différentes ;
- un tunnel de réservation qui perd la progression au rafraîchissement, ce que la
  skill `web-frontend` §3 interdit explicitement — sans qu'aucun test ne le voie ;
- un gérant qui ouvre son tableau de bord le premier jour et trouve un écran vide
  sans amorce, parce que tous les tests tournent sur un jeu d'essai peuplé ;
- un prix qu'on ne découvre qu'après avoir choisi son créneau, alors que le CDC
  §1.3 range précisément ce genre de friction parmi les défauts de Booker que ce
  produit doit corriger.

Ces écarts se corrigent en une branche, et personne ne les relève : ils ne sont
ni des bugs, ni des fonctionnalités manquantes.

Deux contraintes encadrent la réponse. Un jugement de conception se formule
toujours avec aplomb — « ce serait plus clair autrement » ne se réfute pas, et
trente tickets de cette eau rendraient un jalon que personne ne sait clore. Et le
produit a déjà un dispositif qui traverse les mêmes écrans : sans frontière
écrite, les deux ouvriraient deux tickets pour le même symptôme, dans deux
jalons, que deux agents corrigeraient en même temps dans les mêmes fichiers.

## Options envisagées

### Option A — Élargir la grille de `/qa`

Ajouter des critères de conception (`fe:hierarchie`, `fe:parcours`…) à la grille
existante, et laisser la campagne de QA les remonter dans « Bug & correction ».

Le dispositif existe déjà, tout le monde le connaît, et rien n'est à écrire.
Mais les deux natures de constat ne se gouvernent pas pareil. Un critère de QA
porte un **seuil** — « 1,5 Mo », « 300 ms », « 360 px » — et c'est ce seuil qui
rend le tri décidable. Un critère de conception n'en a pas : il se compare à une
intention écrite. Les mélanger revient à supprimer la seule chose qui empêche la
grille de QA de dériver vers l'opinion, et à noyer les bugs — qui empêchent —
sous des améliorations — qui coûtent — dans un jalon ordonné par priorité.

### Option B — Un agent designer sans dispositif

Un agent que l'on lance à la demande, qui rend un rapport de conception dans la
conversation, à charge pour l'humain d'en faire ce qu'il veut.

C'est la réponse la plus légère, et elle échoue au même endroit que les rapports
de QA d'avant `/qa` : un constat qui ne devient pas un ticket classé n'est jamais
corrigé. Il vit dans un transcript, et il meurt avec lui. Le dépôt a déjà tranché
cette question pour la QA — un point d'écriture unique, un classement validé
avant l'appel à `gh`, une déduplication d'une campagne à l'autre.

### Option C — Un dispositif jumeau, à référentiel au lieu de seuil

Reprendre l'architecture de `/qa` — skill de doctrine, agents de traversée,
script unique d'écriture, jalon dédié — en remplaçant le seuil par une
**référence écrite** comme condition d'ouverture.

Plus de surface à maintenir, et une frontière à tenir entre deux dispositifs qui
traversent les mêmes écrans.

## Décision

**Option C.** L'audit de conception est un dispositif distinct : la commande
`/design-audit`, la skill `design-audit`, l'agent `design-auditor`, le script
`scripts/design_tickets.py` et le jalon « Design & UX ».

Quatre choix en découlent, et ce sont eux qui font le dispositif :

1. **La référence remplace le seuil.** Un constat d'audit cite un document que
   le relecteur peut ouvrir — une section du CDC, un ADR, une norme
   d'accessibilité, ou un fichier du dépôt. `design_tickets.py` **refuse** une
   référence qui ne pointe rien, et vérifie l'existence des chemins cités. C'est
   l'équivalent exact du seuil de la QA : ce qui rend le tri décidable par
   quelqu'un d'autre que son auteur.

2. **La recommandation est obligatoire.** Un ticket qui dit ce qui ne va pas
   sans dire vers quoi aller renvoie la conception à l'agent de correction,
   c'est-à-dire au moins qualifié pour la faire.

3. **Un audit ne rend jamais de `P0`.** `P0` veut dire « empêche d'accomplir la
   tâche » ; ce qui empêche est un bug, et c'est `/qa` qui l'ouvre. L'échelle
   d'impact de l'audit s'arrête à `P1`, réservé à ce qui contredit une référence
   écrite sur un parcours du MVP.

4. **La frontière est outillée, pas seulement écrite.** L'agent `design-auditor`
   n'a ni `browser_console_messages`, ni `browser_network_requests` : il ne
   *peut* pas produire un constat qui relève de la QA. Et avant d'ouvrir,
   `design_tickets.py voisins --url <écran>` liste ce qui est déjà ouvert sur cet
   écran **dans les deux jalons**.

La plomberie, elle, n'est pas dupliquée : `design_tickets.py` importe
`qa_bugs.py` et réemploie la poussée des captures sur la branche orpheline, la
déduplication par empreinte, la carte de Project et la garde du jalon fermé. Ce
qui a été écrit une fois et testé une fois n'a rien de propre à la QA.

## Conséquences

**Ce que cela facilite.**

- Un écart de conception devient un ticket classé, dédupliqué et corrigible par
  un agent de vague, au même titre qu'un bug. `/milestone "Design & UX"` déroule
  les reprises comme n'importe quel lot produit.
- Le CDC redevient opposable à l'interface. Les enseignements du §1.3, jusqu'ici
  sans aucune barrière, sont désormais un critère (`ds:confiance`).
- Le design system cesse de dépendre de la vigilance de chaque ticket : une
  couleur littérale hors de `tokens.css`, un composant redessiné là où
  `components/ui/` en fournit un, se relèvent (`ds:systeme`).

**Ce que cela coûte.**

- Une surface d'outillage de plus à maintenir, et une frontière à tenir. Elle est
  écrite (skill §6), outillée (`voisins`, outils retirés à l'agent) et testée
  (`test_design_tickets.Grille` vérifie qu'aucun critère ne recoupe la grille de
  QA) — mais elle reste une convention, et une convention se relâche.
- `qa_bugs.py` a gagné trois coutures pour être réemployable : `titre` et
  `description` sur `ensure_milestone`, `titre` sur `issues_du_jalon`, `famille`
  sur les fonctions de capture. Toutes rétro-compatibles, toutes couvertes par la
  suite existante — mais c'est un fichier qui sert maintenant deux dispositifs.
- Un label `type:design` s'ajoute à la taxonomie du dépôt (project-flow §2).

**Ce que cela ferme.**

- L'audit ne redessine rien. Il rend des écarts et des directions, pas des
  maquettes : une refonte n'est pas un ticket, et « repenser le tableau de bord »
  est explicitement hors dispositif.
- L'audit ne mesure rien. Sans `browser_evaluate`, l'espacement et le contraste
  se jugent à l'œil sur une capture — ce qui interdit les constats de deux
  pixels, et c'est assumé : ce qui compte est ce qu'un utilisateur voit.
- Le jugement reste le juge. Aucun des neuf critères ne se mesure ; la grille ne
  remplace pas le jugement, elle l'oblige à se justifier. C'est plus fragile
  qu'un seuil, et c'est la nature du sujet.
