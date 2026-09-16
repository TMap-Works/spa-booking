# ADR 0011 — Le standard du marché devient une référence de l'audit de conception

- **Statut** : Accepté
- **Date** : 2026-09-16
- **Décideurs** : équipe TMap-Works (#805)
- **Contexte CDC** : §1.2 Vision produit (Booker, « le standard du marché »),
  §1.3 Enseignements tirés de l'analyse de Booker, §1.4 Rappel du périmètre MVP
- **Complète** : [ADR 0010](0010-audit-de-conception-distinct-de-la-qa.md)

## Contexte

L'ADR 0010 a fondé l'audit de conception sur une règle : un constat cite une
**référence écrite** — CDC, ADR, norme d'accessibilité, fichier du dépôt — ou
n'est qu'un goût personnel. Le premier audit (d20260916-1) a montré ce que cette
règle attrape, et ce qu'elle laisse passer.

Elle attrape ce que le projet a écrit : un tunnel qui perd sa progression, un
état vide sans amorce, un libellé qui n'est pas celui du CDC. Elle laisse passer
tout ce que le projet n'a pas écrit parce que le marché l'a déjà établi : une
grille d'horaires sans rangée de jours, une liste de clients sans recherche, un
tableau de bord qui n'annonce pas la journée, un récapitulatif de réservation
qui disparaît en défilant. Aucun document du dépôt ne les prescrit ; la cliente
qui a réservé chez Planity la veille, elle, les attend. Le produit peut ainsi
franchir toutes les barrières et rester en deçà de ce que le CDC lui-même
appelle « le standard du marché » (§1.2).

Le porteur du produit l'a demandé explicitement : que l'audit se mesure, étape
par étape — tableaux de bord, réservation, paiement, historique, filtres —, à
une application moderne et professionnelle, Booker en tête.

La contrainte de l'ADR 0010 reste entière : « ce serait plus moderne comme chez
Booker » est le jugement le plus facile à formuler et le plus difficile à clore.
Ouvrir la porte au marché sans garde ferait revenir exactement les tickets
d'opinion que la règle de la référence a éliminés.

## Options envisagées

### Option A — Laisser l'agent naviguer chez les concurrents à chaque audit

L'agent ouvre booker.com, fresha.com, planity.com pendant la traversée et
compare à vue.

C'est le plus direct, et le seul qui montre l'état du jour. Mais la référence
n'est alors écrite nulle part : un relecteur qui ouvre le ticket six jours plus
tard ne voit qu'une affirmation, que le site a peut-être changé depuis. Deux
audits successifs compareraient à deux choses différentes, et la
déduplication perdrait son sens. Les back-offices des références sont derrière
un compte : l'agent n'en verrait rien, et serait tenté d'en créer un. Enfin,
chaque audit recommencerait une recherche déjà faite.

### Option B — Un critère « modernité » laissé au jugement

Ajouter `ds:modernite` à la grille, sans référence imposée.

C'est exactement ce que l'ADR 0010 a refusé : un critère sans référence est une
porte ouverte à l'opinion, et c'est le premier qui se relâche.

### Option C — Un benchmark écrit, citable motif par motif

Relever une fois, dans `docs/design/benchmark/`, ce que les plateformes de
référence font à chaque étape, sous forme de **motifs** identifiés, sourcés et
datés. Ajouter un critère `ds:standard` dont la seule référence recevable est un
motif. Autoriser la comparaison en direct comme preuve complémentaire, jamais
comme référence.

Un document de plus à tenir, qui vieillit avec les sites qu'il décrit.

## Décision

**Option C.**

1. **Le benchmark vit dans le dépôt**, découpé par étape de l'application, avec
   une carte écran → motifs. Chaque motif porte un identifiant stable
   (`BM-<ÉTAPE>-<nn>`), ce que voit l'utilisateur, pourquoi, la question à
   poser à notre écran, et ses sources — plateforme, mode d'établissement
   (`observé`, `documenté`, `annoncé`), date et URL.

2. **Un motif n'est un standard que s'il est vu chez deux plateformes au
   moins**, dont une au moins observée ou documentée, et s'il relève du MVP.
   Ce qu'une seule plateforme fait est une particularité, pas un standard ; ce
   qui sort du périmètre (avis, cartes cadeaux, fidélité, place de marché) n'a
   pas d'identifiant, parce que son absence chez nous est voulue.
   `test_design_tickets.Benchmark` vérifie la forme de chaque motif.

3. **Le critère `ds:standard` rejoint la grille**, et n'accepte qu'un motif en
   référence. Les autres critères peuvent aussi s'appuyer sur un motif.

4. **La garde est outillée.** `design_tickets.py` refuse un identifiant de
   motif qui n'existe pas, refuse le benchmark cité en entier (un recueil n'est
   pas une prescription), refuse un `ds:standard` sans motif, et recopie le
   motif cité dans le ticket pour que l'agent de correction le lise sans
   quitter l'issue.

5. **La comparaison en direct est permise, et bornée** : pages publiques
   seulement, aucun compte, aucune donnée saisie, jamais au-delà de l'étape qui
   précède les coordonnées — on ne réserve pas chez un vrai salon pour auditer
   le nôtre. Ce qu'elle montre et que le benchmark ne dit pas se range en
   « benchmark à compléter », jamais en constat.

6. **On s'inspire du motif, jamais de l'identité.** Une recommandation
   `ds:standard` décrit la structure à atteindre avec nos jetons et nos
   composants. Ni logo, ni illustration, ni palette, ni texte d'une marque
   tierce.

## Conséquences

**Ce que cela facilite.**

- L'audit juge enfin ce que le CDC appelle le standard du marché, sur chaque
  étape du MVP, avec une référence qu'un relecteur peut ouvrir.
- La recherche est faite une fois et se relit : un agent de correction voit
  dans son ticket ce que font Booker et ses concurrents, sans refaire
  l'enquête.
- Les comptes rendus disent, écran par écran, quels motifs sont tenus — une
  mesure de l'écart au marché qui n'existait pas.

**Ce que cela coûte.**

- Un document de plus, qui **vieillit**. Chaque source est datée, mais
  personne ne la relit d'office : ce sont les lignes « benchmark à rafraîchir »
  des comptes rendus qui déclenchent sa reprise, dans un ticket dédié.
- Les back-offices des références ne sont **pas observés** : leurs motifs
  reposent sur les centres d'aide, qui décrivent ce qu'un écran fait mieux que
  ce à quoi il ressemble. Un motif de back-office dit une structure, rarement
  une finition.
- Un critère de plus, et un risque de recouvrement avec les neuf autres : un
  récapitulatif absent est `ds:hierarchie` autant que `ds:standard`. La skill
  tranche — choisir le critère qui dit où va la main —, mais c'est une
  convention.
- Des captures de pages tierces partent sur la branche d'images du dépôt privé,
  comme preuves internes. Elles ne sont ni publiées, ni reproduites.

**Ce que cela ferme.**

- « Comme chez Booker » cesse d'être un argument : sans motif, le constat est
  écarté.
- Le benchmark ne se modifie pas pendant un audit : un référentiel qu'on réécrit
  en jugeant ne juge plus rien.
- Le périmètre MVP reste le filtre : le marché ne fait pas entrer par la porte
  de la conception ce que le CDC §1.4 a laissé dehors.
