---
name: design-audit
description: Audit de conception UI/UX du produit — traverser chaque écran et chaque parcours, les confronter au cahier des charges, aux ADR, au design system et au standard du marché (benchmark Booker, Fresha, Planity…), et ouvrir chaque écart comme ticket d'amélioration du jalon « Design & UX ». À charger avant `/design-audit`, ou dès qu'une tâche parle de conception, d'ergonomie, de parcours utilisateur, de design system, de cohérence entre écrans ou du jalon de reprise design.
---

# Audit de conception

## 1. Ce que l'audit cherche, et ce que rien d'autre ne cherche

Le dépôt a quatre filets avant celui-ci, et chacun attrape autre chose :

| Le filet | La question à laquelle il répond |
|---|---|
| `npm run verify` | est-ce que ça compile et est-ce que les tests passent |
| la recette MCP (`/ticket` phase 4bis) | est-ce que **ce que ce ticket vient d'écrire** répond quand on s'en sert |
| la CI | est-ce que le reste n'a pas cassé |
| la campagne de QA (`/qa`) | est-ce qu'un **seuil** est franchi quand on s'en sert |

Aucun des quatre ne pose la question de l'audit : **est-ce que ce produit est
bien conçu**. Un écran peut compiler, répondre en 80 ms, tenir à 360 px, ne rien
écrire dans la console — et rester une mauvaise conception : trois écrans qui
appellent la même chose de trois noms différents, un tunnel de réservation qui
perd la progression au rafraîchissement, un prix qu'on ne voit qu'après avoir
choisi, un bouton « Valider » sur une suppression.

Deux différences de nature avec la QA, dont tout le reste découle :

- **La QA mesure un seuil ; l'audit compare à une référence.** La QA dit « 84 px
  de débordement ». L'audit dit « le CDC §1.4 prescrit ce parcours, l'écran en
  fait un autre ». Là où la QA a besoin d'un chiffre, l'audit a besoin d'un
  **document**.
- **La QA ouvre des bugs ; l'audit ouvre des améliorations.** Un bug empêche ;
  un écart de conception coûte. Les deux vont dans deux jalons distincts, et un
  même symptôme ne s'ouvre jamais des deux côtés (§6).

## 2. La règle qui borne tout le reste

**Un constat qui ne s'appuie sur aucune référence écrite n'est pas un constat
d'audit.** C'est un goût personnel, et un goût personnel n'a pas à devenir un
ticket que quelqu'un devra corriger.

C'est la contrainte la plus utile de ce dispositif, et la plus facile à
relâcher — plus encore qu'en QA, parce qu'un jugement de conception se formule
toujours avec aplomb. Un audit sans référence produit trente tickets « ce serait
plus clair autrement » que personne ne sait clore. Un audit avec référence
produit dix tickets dont chacun cite le document qu'il fait respecter.

`scripts/design_tickets.py` **refuse** une référence qui ne pointe rien : une
section du cahier des charges, un ADR, une norme d'accessibilité, un fichier
du dépôt — et le fichier doit exister —, ou un **motif du benchmark du
marché**, cité par son identifiant (`BM-CRENEAU-01`) — et le motif doit exister.
Ce n'est pas une politesse de format, c'est le garde-fou.

« Comme chez Booker » n'est pas une référence. Un motif écrit, sourcé chez deux
plateformes au moins, en est une (§5.1). La différence entre les deux est
exactement celle qui sépare un constat d'un goût.

Corollaire : la grille est un contrat partagé. Les critères listés ici sont
exactement les clés de `CRITERES` dans `scripts/design_tickets.py`, et un test
(`test_design_tickets.Grille`) échoue si les deux listes divergent.

## 3. La grille

| Critère | Ce qu'on regarde | Ce qui fait ticket | La référence qui fait foi |
|---|---|---|---|
| `ds:parcours` | l'enchaînement des étapes, le retour en arrière, la reprise, les sorties | une étape du parcours prescrit absente ou dans un autre ordre ; un retour en arrière qui perd les saisies ; une progression non reprise au rafraîchissement ; un écran d'où l'on ne peut ni avancer ni revenir | CDC §1.4, `.claude/skills/web-frontend/SKILL.md` §3 |
| `ds:hierarchie` | ce que l'œil voit d'abord, l'action principale | l'action principale de l'écran n'est pas identifiable en une seconde sur la capture ; deux actions concurrentes de même poids visuel ; l'information dont dépend la décision (prix, durée, créneau retenu) placée après un défilement à 360 px | `docs/design/*/wireframes.md`, CDC §1.4 |
| `ds:systeme` | la conformité au design system | une valeur littérale de couleur, d'espacement ou de rayon hors de `tokens.css` ; un composant redessiné localement là où `components/ui/` en fournit un ; une primitive `--spa-palette-*` employée directement dans une page au lieu du rôle sémantique | `apps/web/styles/tokens.css`, `apps/web/components/ui/`, `.claude/skills/web-frontend/SKILL.md` §6 |
| `ds:coherence` | le même modèle mental d'un écran à l'autre | le même objet nommé de deux façons sur deux écrans ; la même action placée à deux endroits différents ; deux listes de même rôle qui ne se parcourent pas pareil ; un geste qui marche ici et pas là | comparaison écran à écran, CDC §2.4 (noms des entités) |
| `ds:libelles` | la microcopie | un terme qui n'est pas celui du métier tel que le CDC le nomme ; un message d'erreur qui ne dit pas quoi faire ensuite ; un bouton dont le libellé ne dit pas ce qui va se passer (« OK », « Valider » sur une action destructive) ; de l'anglais dans une interface française ; du texte de remplacement resté en place | CDC §2.3 et §2.4 |
| `ds:etats` | les cinq états d'un écran | une liste sans état vide qui dise quoi faire ensuite ; un état d'erreur sans reprise possible ; une **première utilisation** (établissement sans service, sans praticien, sans rendez-vous) qui montre un écran vide sans amorce ; un succès qui ne se voit pas | `.claude/skills/web-frontend/SKILL.md` §6, `docs/design/appointments/states.md` |
| `ds:mobile` | la conception mobile d'abord du parcours client | à 360 px, l'action principale hors du premier écran ; un tableau à défilement horizontal là où une liste ferait ; une densité de bureau simplement rétrécie ; un formulaire dont le bouton de soumission ne s'atteint qu'en repliant le clavier | CDC §1.4, `.claude/skills/web-frontend/SKILL.md` §7 |
| `ds:a11y` | ce qu'un choix de conception exclut | une information portée par la seule couleur ; un contrôle qui n'est atteignable qu'à la souris **par construction** (glisser-déposer sans équivalent clavier) ; un contraste de palette sous 4,5:1 sur du texte ; un ordre de lecture qui ne suit pas l'ordre visuel | WCAG 2.2 AA, `apps/web/tests/contrast.test.mjs` |
| `ds:confiance` | ce qui permet de décider, avant de réserver ou de payer | prix ou durée absents au moment de choisir ; politique d'annulation invisible avant de confirmer ; identité et coordonnées du salon absentes de la page publique ; aucune trace visible de la réservation après confirmation | CDC §1.3 (enseignements de l'analyse de Booker), CDC §1.4 |
| `ds:standard` | l'écran face à ce que les plateformes de référence font **à la même étape** | un motif du benchmark qui relève de cette étape est absent de l'écran ; ou il y est, mais rendu nettement en deçà — une information qu'il porte manque, un geste qu'il épargne est exigé, une finition qu'il montre fait défaut au point de se voir sur la capture | un motif `BM-…` de [docs/design/benchmark/](../../../docs/design/benchmark/README.md), cité par son identifiant — **seule** référence recevable pour ce critère |

**`ds:standard` est le critère qui répond à la question « est-ce que ça
tient la comparaison ? ».** Les neuf autres jugent le produit contre ce que le
projet a écrit ; celui-ci le juge contre ce qu'une cliente a déjà vu ailleurs —
chez Booker, Fresha, Planity — et qui fixe son attente avant même d'ouvrir
l'écran. Il ne rend pas un écran « moderne » par décret : il fait respecter,
motif par motif, ce que le marché a établi.

**Le parcours client se juge à 360 px d'abord.** C'est le téléphone réel des
clientes d'un salon, et c'est la surface qui génère le revenu (CDC §1.4). Un
écran d'administration se juge à 1280 et 1920 px, qui sont le poste du comptoir.
Juger le premier au format du second est la façon la plus sûre de passer à côté.

## 4. L'impact, en trois cases — et jamais de `P0`

| Impact | Priorité | Ce que ça veut dire |
|---|---|---|
| `fort` | `P1` | **contredit une référence écrite** sur un parcours du MVP |
| `moyen` | `P2` | dégrade l'usage sans l'empêcher |
| `faible` | `P2` | finition — à regrouper par écran plutôt qu'à ouvrir seul |

`P0` n'existe pas ici, et c'est délibéré : `P0` veut dire « empêche d'accomplir
la tâche ». Ce qui empêche est un **bug**, et c'est `/qa` qui l'ouvre, dans son
jalon. Un audit qui rendrait des `P0` ferait passer une question de conception
avant une fuite de données dans l'ordre du run.

`fort` se mérite. La borne est explicite : il faut pouvoir **citer la phrase**
du document que l'écran contredit. Sans cette borne, tout écart de conception
finit en `P1` et l'ordre du run ne veut plus rien dire.

Les constats `faible` se **regroupent** : cinq écarts de finition sur le même
écran font un ticket, pas cinq. Un jalon de reprise ne vaut que par ce qu'on a
refusé d'y mettre.

## 5. Le référentiel — les documents qui font foi

Un audit qui ne lit pas ces documents avant de regarder les écrans n'audite
rien : il donne un avis.

| Document | Ce qu'on y cherche |
|---|---|
| [docs/specs/cdc-fr.txt](../../../docs/specs/cdc-fr.txt) | §1.3 les enseignements de l'analyse de Booker — ce que le produit doit faire **mieux** ; §1.4 le périmètre figé et les parcours ; §2.3 les modules ; §2.4 le nom des entités, qui est le vocabulaire de l'interface |
| [docs/adr/](../../../docs/adr/) | les décisions figées et leur raison — notamment 0002 (double réservation), 0006 (fuseaux horaires du tenant) : un écran qui les contredit n'est pas un débat de conception |
| [docs/design/](../../../docs/design/) | les maquettes et les états déjà spécifiés — un écran qui s'en écarte se compare à ce qui était prévu |
| [docs/design/benchmark/](../../../docs/design/benchmark/README.md) | **le standard du marché, étape par étape** — ce que Booker et ses concurrents montrent sur la vitrine, le choix du créneau, le paiement, l'espace client, le tableau de bord, le planning, les listes et leurs filtres, l'encaissement, le reporting. Lire le `README.md` (la carte écran → motifs), puis le fichier de chaque étape du périmètre (§5.1) |
| [.claude/skills/web-frontend/SKILL.md](../web-frontend/SKILL.md) | les conventions du front : §3 le parcours de réservation, §4 les formulaires, §5 le calendrier admin, §6 le design system, §7 l'accessibilité |
| [apps/web/styles/tokens.css](../../../apps/web/styles/tokens.css) | les deux couches de jetons — primitives et rôles sémantiques. Une couleur littérale hors de ce fichier est un écart, pas un choix |
| [apps/web/components/ui/](../../../apps/web/components/ui/) | ce qui existe déjà et qu'on n'a pas à redessiner |
| [apps/web/tests/](../../../apps/web/tests/) | ce qui est **déjà vérifié mécaniquement** — contraste, jetons, rythme des écrans admin. Inutile d'ouvrir un ticket sur ce qu'une suite garde déjà |

Cette dernière ligne est une économie réelle : `tokens.test.mjs`,
`contrast.test.mjs`, `admin-screen-rhythm.test.mjs` et leurs voisines passent en
CI. Ce qu'elles couvrent est tenu. Ce qu'elles ne couvrent pas est exactement ce
que l'audit doit regarder — et quand un écart relevé **est** mécaniquement
vérifiable, la recommandation du ticket dit d'étendre la suite qui l'aurait
attrapé.

### 5.1 Le benchmark du marché — se mesurer à Booker sans le copier

Le CDC nomme Booker comme « le standard du marché » (§1.2) et bâtit ses
priorités sur son analyse (§1.3). Le benchmark de `docs/design/benchmark/` est
la forme **opposable** de cette comparaison : pour chaque étape de l'app, les
motifs que les plateformes de référence — Booker d'abord, puis Fresha, Planity,
Treatwell, Vagaro, Boulevard, Square, Mindbody — ont en commun.

Ce qui rend un motif citable, et que `test_design_tickets.Benchmark` vérifie :

- il porte un **identifiant stable** — `BM-<ÉTAPE>-<nn>` ;
- il est vu chez **deux plateformes au moins**, dont une au moins **observée**
  (vue à l'écran) ou **documentée** (centre d'aide) — une page marketing seule
  annonce, elle ne montre pas ;
- chaque source est **datée** : un site évolue, et un motif sans date ne dit
  pas s'il est encore vrai ;
- il **relève du MVP** — un motif de cartes cadeaux, d'avis ou de fidélité n'a
  pas d'identifiant, parce que son absence chez nous n'est pas un écart
  (CDC §1.4).

Comment s'en servir :

1. **Avant chaque écran**, lire dans la carte du `README.md` les motifs de son
   étape. Ce sont les questions à poser à cet écran — chaque motif porte une
   ligne « À vérifier chez nous ».
2. **Un motif absent ou rendu en deçà** fait un constat `ds:standard`, qui cite
   l'identifiant. Un motif peut aussi appuyer un constat d'un autre critère — un
   récapitulatif collant absent est `ds:hierarchie` autant que `ds:standard` :
   choisir le critère qui dit le mieux **où va la main**, et citer le motif en
   référence dans les deux cas.
3. **La comparaison en direct est permise, et bornée.** Le `README.md` liste
   des pages **publiques** de référence par étape. L'auditeur peut les ouvrir à
   la même largeur que l'écran audité et joindre la capture comme seconde
   preuve (« chez la référence »). Jamais de compte, jamais de connexion,
   jamais de donnée personnelle saisie, jamais au-delà de l'étape qui précède
   les coordonnées : on ne réserve pas chez un vrai salon pour auditer le
   nôtre. Une bannière de cookies se **refuse**.
4. **Ce que la page en direct montre et que le benchmark ne dit pas** n'est pas
   un constat : c'est une ligne « benchmark à compléter » du compte rendu. Le
   benchmark se complète dans un ticket dédié, jamais pendant l'audit — un
   référentiel qu'on réécrit en jugeant ne juge plus rien.
5. **Un motif que la page en direct contredit** — le site a changé — se
   signale « benchmark à rafraîchir ». Le motif reste citable tant qu'une
   autre de ses sources le porte encore.

**S'inspirer du motif, jamais de l'identité.** La recommandation d'un ticket
`ds:standard` décrit la **structure** à atteindre — ce qui s'affiche, dans quel
ordre, avec quel geste — et la réalise avec les jetons de `tokens.css` et les
composants de `components/ui/`. Elle ne reprend ni logo, ni illustration, ni
palette, ni texte d'une marque tierce : un écran qui ressemble à Fresha n'est
pas un écran qui tient la comparaison, c'est une contrefaçon.

## 6. La frontière avec `/qa`

Les deux dispositifs traversent les mêmes écrans. Sans règle, ils ouvrent deux
tickets pour le même symptôme, dans deux jalons, et deux agents les corrigent en
même temps dans les mêmes fichiers.

La règle tient en une ligne : **un seuil franchi est un bug ; un écart à une
référence est une amélioration.**

| Ce qu'on voit | Qui l'ouvre | Où |
|---|---|---|
| la grille des créneaux déborde de 84 px à 360 px | `/qa` — `fe:responsive` | Bug & correction |
| le parcours client est conçu pour le bureau puis rétréci | `/design-audit` — `ds:mobile` | Design & UX |
| une erreur de console sur `/reservation` | `/qa` — `fe:console` | Bug & correction |
| l'écran d'erreur ne propose aucune reprise | `/design-audit` — `ds:etats` | Design & UX |
| deux boutons de même rôle rendus avec deux styles | `/qa` — `fe:design` | Bug & correction |
| deux écrans qui nomment le même objet de deux façons | `/design-audit` — `ds:coherence` | Design & UX |
| la liste des clients n'a ni recherche ni filtre, quand les références en ont | `/design-audit` — `ds:standard`, motif cité | Design & UX |
| l'écran « fait daté », sans motif du benchmark à citer | personne | écarté, dit dans le compte rendu |

En cas de doute, la question qui tranche : **puis-je citer un seuil chiffré ?**
Si oui, c'est un bug. Sinon, puis-je citer un document ? Si oui, c'est un écart.
Si ni l'un ni l'autre, ce n'est rien — et ça se dit dans le compte rendu.

Avant d'ouvrir, la vérification se fait en une commande :

```bash
python scripts/design_tickets.py voisins --url "/le-spa/reservation"
```

Elle liste ce qui est **déjà ouvert** sur cet écran, dans les deux jalons. Un
bug de QA ouvert qui dit la même chose ferme le débat : l'audit le signale dans
son compte rendu et n'ouvre rien.

## 7. Le déroulé d'un audit

Six temps. `/design-audit` les orchestre ; cette section dit ce qu'ils valent.

1. **Le référentiel, avant les écrans.** Lire §5 — au minimum le CDC §1.3 et
   §1.4, la skill `web-frontend`, et **les fichiers du benchmark des étapes du
   périmètre** (§5.1). Un audit qui regarde d'abord et lit ensuite trouve ce
   qu'il avait déjà en tête.
2. **Le périmètre.** Un parcours (réservation client, back-office, comptoir,
   compte client) ou un module. Un périmètre non écrit est un périmètre qui
   dérive, et un audit « complet » finit par ne rien ouvrir d'exploitable.
3. **Le terrain.** `api_demarrer` + `api_jeu_dessai` + `web_demarrer`, avec la
   **racine du dépôt principal**. Le jeu d'essai est ce qui permet de voir les
   écrans pleins ; le **premier écran d'un établissement neuf**, lui, se regarde
   avant de le poser, parce que c'est ce que le gérant voit le premier jour.
4. **La traversée.** Un agent `design-auditor` par parcours, lancés **l'un après
   l'autre**. Contrairement à `/qa`, qui fait tourner `qa-frontend` et
   `qa-backend` de front, les agents d'audit se partagent **un seul navigateur
   Playwright** : deux agents lancés ensemble se volent la page en pleine
   traversée. Découper le périmètre en trois ou quatre parcours et les enchaîner
   coûte du temps, pas de la qualité. Chaque agent reçoit la liste des motifs
   `BM-…` des écrans qu'il traverse, et peut ouvrir les pages publiques de
   référence de ces étapes (§5.1, point 3) — dans le même navigateur, donc
   toujours dans son propre tour. Ils rendent des **constats**, pas des
   tickets.
5. **Le tri.** Chaque constat est confronté à la grille, à la référence, et aux
   voisins déjà ouverts. Ce qui n'entre dans aucune case est **écarté**, et le
   dire fait partie du compte rendu.
6. **Les tickets.** Un appel à `design_tickets.py open` par constat retenu.

## 8. La capture — un constat de conception sans image n'existe pas

Plus encore qu'en QA : un écart de conception se **montre**. « La hiérarchie est
confuse » ne se vérifie pas six jours plus tard ; une capture où l'action
principale se perd, si.

- `browser_take_screenshot` **sans `filename`** — un nom passé est résolu depuis
  le répertoire courant et la capture atterrit à la racine du dépôt. Sans lui,
  elle va dans `.claude/.recette/playwright/`, ignoré par git.
- La **légende dit ce qu'il faut regarder** : « les deux boutons de même poids,
  aucun ne ressort », jamais « capture de la page ».
- Pour un constat `ds:coherence`, il faut **deux** captures — l'écart n'est
  visible que par comparaison. `--capture` est répétable.
- Pour un constat `ds:standard`, la capture de notre écran est obligatoire ; la
  **capture de référence** — la page publique d'une plateforme du benchmark, à
  la même largeur — est recommandée, et sa légende nomme la plateforme et la
  date : « Fresha, 16/09/2026, 390 px — le récapitulatif reste sous le pouce ».
  Elle sert de preuve interne et de direction, jamais de maquette à reproduire.
- Les captures partent sur la branche `qa-captures`, sous
  `docs/design/captures/`, séparées de celles de la QA. La branche ne merge
  jamais et ne porte aucun code.

## 9. Ouvrir le ticket

Un seul point d'écriture : `scripts/design_tickets.py`. Ne pas ouvrir d'issue
d'audit à la main — un `gh issue create` libre perd un label, et un ticket sans
`ws:*`, `mod:*` ou `nature:*` est **écarté du plan** par `milestone_plan.py`
sans que rien ne le signale.

```bash
python scripts/design_tickets.py open \
  --titre "Le tunnel de réservation perd l'étape choisie au rafraîchissement" \
  --critere ds:parcours --module appointments --workstream Frontend \
  --impact fort --url "/le-spa/reservation" \
  --reference ".claude/skills/web-frontend/SKILL.md §3" \
  --attendu "L'état de l'étape en cours survit à un rafraîchissement de page (URL ou stockage de session)." \
  --constate "F5 à l'étape « créneau » ramène à l'étape « service », toutes saisies perdues." \
  --recommandation "Porter l'étape courante et le créneau retenu dans l'URL, et rendre l'étape reprenable au montage." \
  --preuve "1280 px, tunnel à l'étape 3, F5 ; retour à l'étape 1" \
  --capture .claude/.recette/playwright/tunnel-avant.png:"L'étape 3 renseignée" \
  --capture .claude/.recette/playwright/tunnel-apres.png:"Après F5, retour à l'étape 1" \
  --campagne d20260916-1
```

> **Sous Git Bash, préfixer par `MSYS_NO_PATHCONV=1`.** MSYS convertit toute
> valeur d'argument commençant par `/` en chemin d'installation :
> `--url /reservation` arrive en `C:/Program Files/Git/reservation`. Le script
> le rattrape, mais le remède à la source reste le bon.

Les deux champs qui n'existent pas en QA, et qui portent tout le dispositif :

- **`--reference`** — le document qui dit ce qui est attendu. C'est ce qui
  distingue le constat de l'opinion, et le script refuse ce qui ne pointe rien.
- **`--recommandation`** — la direction proposée, pas le code. Un ticket qui dit
  ce qui ne va pas sans dire vers quoi aller renvoie la conception à l'agent de
  correction, c'est-à-dire au moins qualifié pour la faire.

Ce que le script garantit, et qu'il ne faut donc pas refaire :

- le **classement complet** — `type:design`, `nature:projet`, `ws:*`, `mod:*`,
  la priorité déduite de l'impact, et le jalon, créé s'il manque ;
- le **workstream par défaut `Frontend`** — la correction d'un écart vit dans
  `apps/web`, et c'est ce label qui donne au plan la bonne empreinte de
  fichiers. `Design` ne se justifie que si le livrable est une maquette ou une
  spécification de `docs/design/`. Et **`Backend` quand l'écart est servi par
  l'API** : deux écrans qui affichent deux heures pour le même rendez-vous se
  corrigent dans le repository, pas dans la page — le label doit dire où va la
  main, sinon le plan envoie l'agent au mauvais endroit ;
- la **déduplication** — même critère, même écran, même clé, donc même
  empreinte. Un écart déjà ouvert est commenté, pas doublé ; un écart déjà
  **corrigé** rouvre un ticket qui cite l'ancien ;
- la **preuve visuelle** — refus d'ouvrir sans `--capture` ni `--sans-capture` ;
- la **carte de Project** — posée après l'ouverture ; un échec se lit dans le
  champ `project` du JSON rendu et ne bloque pas le ticket.

Codes de sortie : `0` fait · `1` panne d'environnement (gh, git, réseau) ·
`4` appel fautif — dans ce dernier cas, c'est l'appel qu'il faut corriger.

### Un titre qui dit l'écart

« Améliorer la page de réservation » n'est pas un titre : il ne dit ni ce qui
cloche, ni où. « Le tunnel de réservation perd l'étape choisie au
rafraîchissement » tient dans une ligne de plan et se corrige sans ouvrir le
ticket.

## 10. Ce qui n'est pas un constat d'audit

À écarter, et à dire dans le compte rendu plutôt qu'à ouvrir :

- **Une fonctionnalité absente du MVP.** Le périmètre est figé (CDC §1.4) ; son
  absence n'est pas un écart de conception. En cas de doute, charger l'agent
  `mvp-scope-guard`.
- **Une refonte.** « Repenser le tableau de bord » n'est pas un ticket : c'est
  un projet. Un ticket d'audit se corrige en une branche.
- **Un goût sans référence** — « je mettrais plutôt du bleu », « ce serait plus
  moderne en cartes ». C'est la règle du §2, et c'est celle qui se relâche.
- **« Comme chez Booker », sans motif.** Ce qu'une plateforme fait et que le
  benchmark n'a pas écrit — ou n'a vu que chez elle — n'est pas un standard.
  Le dire sous « benchmark à compléter », avec l'URL et ce qui a été vu.
- **Une fonctionnalité du concurrent hors MVP** — avis, cartes cadeaux,
  fidélité, place de marché. Le benchmark ne leur donne pas d'identifiant, et
  c'est voulu (CDC §1.4).
- **Une ressemblance recherchée pour elle-même.** « Reprendre la mise en page de
  Fresha » n'est pas une recommandation : la recommandation décrit la structure
  à atteindre avec notre design system (§5.1).
- **Un seuil franchi** — c'est un bug (§6).
- **Ce qu'une suite de `apps/web/tests/` garde déjà.** Le ticket serait rouge
  avant d'être lu.
- **Une dette d'architecture.** Elle mérite une issue, pas ce jalon : « Design
  & UX » sert ce qui se reprend à l'écran, pas ce qui se reconçoit dessous.

## 11. Ce qui n'est pas un échec d'audit

| Symptôme | Cause | Remède |
|---|---|---|
| `PostgreSQL injoignable` | dépendances éteintes | `docker compose up -d` |
| authentification refusée, conteneur sain | un PostgreSQL natif tient le port ; le dépôt publie le sien sur **5433** | `netstat -ano \| grep :5433`, corriger `DATABASE_URL` |
| `Client Prisma indisponible` | schéma généré en retard | `npm run db:generate` |
| Playwright sans navigateur | binaire jamais installé | `npx playwright install chromium` |
| l'écran visé n'existe pas encore | `apps/web` sert alors `apps/web/mockups/` | auditer la maquette, et **le dire** dans le constat — un écart de maquette n'a pas la même valeur qu'un écart d'application |
| `référence irrecevable` | le chemin cité n'existe pas | vérifier le chemin, ou citer le CDC — la garde a fait son travail |
| `Motif(s) absent(s) du benchmark` | identifiant mal recopié, ou motif inventé | `grep -rn '^### BM-' docs/design/benchmark` ; si le motif n'existe vraiment pas, le constat va sous « benchmark à compléter » |
| `référence irrecevable pour ds:standard` | un constat `ds:standard` qui cite le CDC ou un fichier | citer le motif ; s'il n'y en a pas, changer de critère ou écarter |
| la page de référence exige un compte, ou bloque le robot | les back-offices des références sont privés | s'en tenir au benchmark écrit, qui s'appuie pour eux sur les centres d'aide — ne jamais créer de compte |

Appliquer, relancer, poursuivre. Un audit qui s'arrête sur une dépendance
éteinte n'a rien regardé.

## 12. Les limites du dispositif, à savoir avant de s'y fier

- **Aucune mesure du DOM.** `browser_evaluate` et `browser_run_code_unsafe` sont
  refusés par les réglages du dépôt : l'espacement, le contraste et les tailles
  se jugent **à l'œil sur une capture**. Un constat doit donc montrer un écart
  visible, jamais un écart supposé de deux pixels.
- **Le jugement est le juge.** Aucune de ces dix lignes ne se mesure : elles se
  constatent, et c'est pourquoi la référence est obligatoire. La grille ne
  remplace pas le jugement, elle l'oblige à se justifier.
- **Le benchmark vieillit.** Chaque source est datée, mais personne ne la relit
  d'office : ce sont les lignes « benchmark à rafraîchir » des comptes rendus
  qui disent quand le reprendre. Et les back-offices des références ne sont
  **pas observés** — ils sont documentés par leurs centres d'aide, qui décrivent
  ce qu'un écran fait mieux que ce à quoi il ressemble.
- **L'audit ne voit que ce qui est rendu.** Un écran derrière un état que le jeu
  d'essai ne produit pas — un établissement sans praticien, un paiement refusé —
  n'est pas audité tant qu'on n'a pas su l'atteindre. Le dire.
- **L'empreinte porte le slug de l'établissement visité.** `--url
  "/spa-lumiere/admin/clients"` et `--url "/autre-salon/admin/clients"` sont deux
  empreintes différentes pour le même écart : `normaliser_url` sait ramener un
  identifiant à `:id`, pas un slug de tenant à `:tenant`. Conséquence pratique :
  **auditer toujours le même établissement d'une campagne à l'autre**, faute de
  quoi la déduplication ne reconnaîtra rien. Le jeu d'essai de
  `apps/api/prisma/seed.ts` sert exactement à cela — `spa-lumiere` est
  l'établissement de référence.
- **L'audit ne corrige rien.** Il ouvre des tickets.
  `/milestone "Design & UX"` déroule les reprises, et c'est un run séparé : on
  ne reprend pas pendant qu'on juge.
