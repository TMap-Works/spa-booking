---
name: qa
description: Campagne de QA sur l'application — exercer le produit tel qu'un utilisateur s'en sert, le confronter à une grille de critères frontend (design, UX, espacement, positionnement, responsive, performance) et backend (sécurité, performance, latence), et ouvrir chaque anomalie comme ticket du jalon « Bug & correction ». À charger avant `/qa`, ou dès qu'une tâche parle de tester l'application, de qualité perçue, de campagne de test, de bug à relever ou du jalon de correction.
---

# Campagne de QA

## 1. Ce que la QA cherche, et ce que rien d'autre ne cherche

Le dépôt a déjà trois filets, et chacun attrape autre chose :

| Le filet | La question à laquelle il répond |
|---|---|
| `npm run verify` | est-ce que ça compile et est-ce que les tests passent |
| la recette MCP (`/ticket` phase 4bis) | est-ce que **ce que ce ticket vient d'écrire** répond quand on s'en sert |
| la CI | est-ce que le reste n'a pas cassé |

Aucun des trois ne pose la question de la QA : **est-ce que le produit est bon
quand on s'en sert pour de vrai**. Un formulaire peut se soumettre — la recette
est verte — et rester illisible à 360 px, mettre quatre secondes à répondre,
afficher « Error » là où il faut une phrase, ou exposer le champ `tenantId` dans
sa réponse JSON. Ce sont des défauts que seule une traversée du produit révèle.

Deux différences de nature avec la recette, dont tout le reste découle :

- **La recette est bornée au diff d'un ticket ; la campagne est bornée à un
  parcours.** Elle traverse le produit tel qu'un client ou un gérant s'en sert,
  sans se demander qui a écrit quoi.
- **La recette rend un verdict bloquant sur un ticket ; la campagne ouvre des
  tickets.** Elle n'arrête rien et ne corrige rien : elle alimente le jalon
  « Bug & correction », qu'un run déroulera.

## 2. La règle qui borne tout le reste

**Un constat qui ne se rattache à aucun critère de la grille n'est pas un
constat de QA.** C'est une opinion, et elle n'a pas à devenir un ticket que
quelqu'un devra corriger.

C'est la contrainte la plus utile de ce dispositif, et la plus facile à
relâcher. Une campagne sans grille produit trente tickets « le design pourrait
être meilleur » que personne ne sait clore. Une campagne avec grille produit dix
tickets dont chacun nomme le seuil franchi. `scripts/qa_bugs.py` **refuse** un
critère hors grille — ce n'est pas une politesse, c'est le garde-fou.

Corollaire : la grille est un contrat partagé. Les critères listés ici sont
exactement les clés de `CRITERES` dans `scripts/qa_bugs.py`, et un test
(`test_qa_bugs.Grille`) échoue si les deux listes divergent.

## 3. La grille frontend

Mesurée avec le serveur MCP `playwright`. Rappel : `browser_evaluate` et
`browser_run_code_unsafe` sont **refusés** par `.claude/settings.json` — on ne
peut donc pas interroger le DOM en JavaScript. Tout ce qui suit se mesure avec
ce qui reste : l'instantané d'accessibilité, les captures, le redimensionnement,
la console et le journal réseau. C'est moins précis qu'un audit Lighthouse, et
c'est assumé : ce qui compte est ce qu'un utilisateur voit.

| Critère | Ce qu'on regarde | Seuil qui fait ticket | L'outil |
|---|---|---|---|
| `fe:design` | palette, graisses, rayons, composants réutilisés | deux composants de même rôle rendus différemment sur deux pages ; une couleur hors palette du design system | `browser_take_screenshot`, comparaison page à page |
| `fe:espacement` | rythme vertical, gouttières, densité | des marges qui ne suivent pas l'échelle du design system, au point que deux blocs voisins se collent ou se perdent ; du texte au contact d'un bord | capture, lecture visuelle |
| `fe:positionnement` | alignement, chevauchement, coupure | un élément recouvre un autre ; un contenu sort de son conteneur ; un libellé et son champ désalignés à l'œil | capture |
| `fe:responsive` | **360, 768, 1280, 1920 px** | débordement horizontal de la page ; contenu coupé sans défilement ; cible tactile visiblement plus petite que le pouce à 360 px | `browser_resize` puis capture à chaque largeur |
| `fe:ux` | parcours, libellés, états | un état **vide**, **en chargement** ou **en erreur** non rendu ; un message d'erreur technique montré à l'utilisateur (`500`, `undefined`, une trace) ; une action destructive sans confirmation ; un bouton de soumission qui n'est pas désactivé au premier clic | `browser_snapshot`, `browser_click`, `browser_fill_form` |
| `fe:a11y` | contraste, focus, libellés, tabulation | un champ sans libellé accessible ; une image porteuse de sens sans alternative ; un focus invisible au clavier ; un ordre de tabulation qui saute le contenu principal ; une hiérarchie de titres trouée | `browser_snapshot` (arbre d'accessibilité), `browser_press_key` Tab |
| `fe:performance` | poids, requêtes, délai | **> 1,5 Mo** transférés sur une page ; **> 60** requêtes ; une image servie à plus du double de sa taille d'affichage ; un écran resté vide **> 3 s** après navigation | `browser_network_requests`, `browser_wait_for` |
| `fe:console` | propreté d'exécution | **toute** erreur de console ; toute requête en 4xx/5xx non voulue. Seule exception connue : le `404` de `favicon.ico` sur le serveur statique | `browser_console_messages`, `browser_network_requests` |

**Les quatre largeurs ne sont pas négociables.** 360 px est le téléphone réel des
clientes d'un salon ; 1920 le poste du comptoir. Un parcours de réservation qui
ne tient pas à 360 px ne sert pas le premier usage du produit (CDC §1.4).

## 4. La grille backend

Mesurée avec le serveur MCP `recette` — `api_demarrer`, `api_jeu_dessai`,
`api_openapi`, `api_appel`. `api_appel` rend `duree_ms` : c'est la mesure de
latence, il n'y a pas à en inventer une autre.

| Critère | Ce qu'on regarde | Seuil qui fait ticket | Comment |
|---|---|---|---|
| `be:securite` | garde, seuil de rôle, isolation, exposition | une route qui répond **200 sans jeton** alors qu'elle porte une donnée d'établissement ; **403 au lieu de 404** sur la ressource d'un voisin — un 403 confirme l'existence ; un `tenantId`, un `passwordHash` ou une note interne dans un corps de réponse ; un `tenantId` accepté depuis le corps ou l'URL | jeu d'essai + jeton du **voisin** ; `tenant-isolation` §4 |
| `be:validation` | DTO et forme d'erreur | un corps invalide qui rend **500** au lieu de **400** ; une erreur qui n'a pas la forme `{ code, message, details }` ; un champ inconnu accepté en silence | `api_appel` avec un corps fautif |
| `be:latence` | `duree_ms`, par classe de route | **lecture simple > 300 ms** · **recherche de créneaux > 800 ms** · **écriture > 1 000 ms**, sur une base de jeu d'essai et hors premier appel (le JIT et la connexion faussent le premier) | trois appels, retenir la **médiane** — un pic isolé n'est pas un ticket |
| `be:performance` | coût serveur | une liste sans pagination ; une réponse dont la durée croît visiblement avec le nombre d'objets créés (signature d'un N+1) ; un export qui charge tout en mémoire | créer 3 puis 30 objets, comparer `duree_ms` |
| `be:fiabilite` | idempotence, concurrence, cohérence | deux `POST` identiques qui créent deux ressources là où l'un suffit ; deux réservations concurrentes acceptées sur le même créneau ; un webhook rejoué qui encaisse deux fois | `booking-engine`, `payments-stripe` |
| `be:donnees` | justesse | une date rendue autrement qu'en UTC ; un montant en flottant ou sans code devise ; un rendez-vous affiché dans le mauvais fuseau | lire les corps de réponse |

**La latence se mesure sur la médiane de trois appels, jamais sur un seul.** Le
premier appel d'une route porte la connexion à la base et la compilation à la
volée : en faire un ticket, c'est ouvrir un bug qui n'existe pas.

## 5. Le déroulé d'une campagne

Cinq temps. `/qa` les orchestre ; cette section dit ce qu'ils valent.

1. **Le périmètre.** Une campagne complète du produit ne tient pas dans une
   session : on choisit un **parcours** (réservation client, back-office,
   comptoir, notifications…) ou un module. Un périmètre non écrit est un
   périmètre qui dérive.
2. **Le terrain.** `api_demarrer` + `api_jeu_dessai` + `web_demarrer`, avec la
   racine du dépôt principal (`racine`, puisqu'une campagne ne porte pas sur un
   ticket). Le jeu d'essai pose l'établissement, les quatre rôles et le
   **voisin** — sans lui, aucun critère `be:securite` ne s'exerce.
3. **La traversée.** Les deux agents, `qa-frontend` et `qa-backend`, en
   parallèle : ils n'ont ni les mêmes outils ni les mêmes seuils, et rien ne les
   fait dépendre l'un de l'autre.
4. **Le tri.** Chaque constat est confronté à la grille : critère, gravité,
   seuil franchi. Ce qui n'entre dans aucune case est **écarté**, et le dire
   fait partie du compte rendu.
5. **Les tickets.** Un appel à `qa_bugs.py open` par constat retenu.

## 6. La capture — un constat sans image n'est pas un constat

**Chaque test produit une capture, et chaque ticket en porte une.** Ce n'est pas
une exigence de présentation : c'est ce qui rend le ticket corrigible six jours
plus tard, par quelqu'un qui n'a pas vu l'écran.

- `browser_take_screenshot` **sans `filename`** — un nom passé est résolu depuis
  le répertoire courant et la capture atterrit à la racine du dépôt. Sans lui,
  elle va dans `.claude/.recette/playwright/`, qui est ignoré par git.
- La **légende dit ce qu'il faut regarder** : « la colonne du samedi coupée à
  droite », pas « capture de la page ». Un relecteur qui doit deviner ce qu'on
  lui montre ne regarde rien.
- Pour un constat **backend**, la capture légitime est la page qui exerce
  l'endroit fautif pendant que le défaut se manifeste — l'écran qui attend
  quatre secondes, la liste qui rend une erreur brute. Quand aucune page ne
  l'expose, `--sans-capture "<raison>"` : mieux vaut une absence motivée qu'une
  image de complaisance qui n'illustre rien.

Les captures partent sur la branche `qa-captures`, qui ne merge jamais et ne
porte aucun code — le script s'en charge en plomberie git, sans matérialiser
d'arbre sur le disque.

## 7. Ouvrir le ticket

Un seul point d'écriture : `scripts/qa_bugs.py`. Ne pas ouvrir d'issue de QA à
la main — un `gh issue create` libre perd un label, et un ticket sans `ws:*`,
`mod:*` ou `nature:*` est **écarté du plan** par `milestone_plan.py` sans que
rien ne le signale.

```bash
python scripts/qa_bugs.py open \
  --titre "Le calendrier des créneaux déborde de la fenêtre à 360 px" \
  --critere fe:responsive --module appointments --workstream Frontend \
  --gravite majeur --url "/reserver/creneaux" \
  --attendu "À 360 px, la grille des créneaux tient dans la fenêtre." \
  --constate "La colonne du samedi est coupée, sans défilement horizontal." \
  --preuve "browser_resize 360x800 ; débordement visible sur la capture" \
  --mesure "84 px de débordement à droite" \
  --reproduire "1. /reserver 2. choisir « Massage 60 min » 3. réduire à 360 px" \
  --capture .claude/.recette/playwright/creneaux-360.png:"La colonne du samedi coupée"
```

Ce que le script garantit, et qu'il ne faut donc pas refaire :

- le **classement complet** — `type:bug`, `nature:projet`, `ws:*`, `mod:*`, la
  priorité déduite de la gravité, et le jalon ;
- la **déduplication** — même critère, même endroit, même clé ⇒ même empreinte.
  Un ticket ouvert est commenté au lieu d'être doublé ; un ticket **fermé**
  rouvre un ticket de **régression** qui cite l'ancien ;
- la **preuve visuelle** — refus d'ouvrir sans `--capture` ni `--sans-capture`,
  et refus d'une capture introuvable ou trop lourde, `--dry-run` compris ;
- la **carte de Project** — posée après l'ouverture, sans quoi l'anomalie
  n'apparaîtrait dans aucune vue de suivi (`PROJECT_TOKEN` est absent du dépôt,
  le workflow ne peut donc rien faire) ; un échec de carte ne bloque pas le
  ticket, il se lit dans le champ `project` du JSON rendu ;
- le **jalon** — créé s'il manque, rouvert s'il a été fermé, sans échéance.

### La gravité, en trois cases

| Gravité | Priorité | Ce que ça veut dire |
|---|---|---|
| `bloquant` | `P0` | empêche d'accomplir la tâche, ou expose une donnée d'un autre établissement |
| `majeur` | `P1` | dégrade nettement l'usage, se contourne mal |
| `mineur` | `P2` | visible, sans conséquence sur la tâche |

Une fuite inter-tenant est **toujours** `bloquant`, quelle que soit la facilité
de l'exploiter : c'est l'incident le plus grave que ce produit puisse produire
(CDC §5.1).

### Un titre qui dit le défaut

« Bug sur la page de réservation » n'est pas un titre : il ne dit ni ce qui ne
va pas, ni où. « Le calendrier des créneaux déborde de la fenêtre à 360 px »
tient dans une ligne de plan et se corrige sans ouvrir le ticket.

## 8. Ce qui n'est pas un constat de QA

À écarter, et à dire dans le compte rendu plutôt qu'à ouvrir :

- **Une fonctionnalité absente du MVP.** Le périmètre est figé (CDC §1.4) ; son
  absence n'est pas un bug. En cas de doute, charger l'agent `mvp-scope-guard`.
- **Un goût personnel** sans seuil franchi — « je mettrais plutôt du bleu ».
- **Ce que la CI couvre déjà** : une régression de test unitaire, une erreur de
  typage. Le ticket serait rouge avant d'être lu.
- **Un défaut de l'environnement local** : Postgres éteint, `dist/` périmé,
  navigateur non installé. Appliquer le remède (§9) et poursuivre.
- **Une dette d'architecture** — elle mérite une issue, mais pas dans ce jalon :
  le jalon « Bug & correction » sert ce qui se corrige, pas ce qui se
  reconçoit.

## 9. Ce qui n'est pas un échec de campagne

| Symptôme | Cause | Remède |
|---|---|---|
| `PostgreSQL injoignable` | dépendances éteintes | `docker compose up -d` |
| authentification refusée, conteneur sain | un PostgreSQL natif tient le port ; le dépôt publie le sien sur **5433** | `netstat -ano \| grep :5433`, corriger `DATABASE_URL` |
| `Client Prisma indisponible` | schéma généré en retard | `npm run db:generate` |
| Playwright sans navigateur | binaire jamais installé | `npx playwright install chromium` |
| la page de test n'existe pas encore | `apps/web` sert alors `apps/web/mockups/` | recetter la maquette, et le dire dans le compte rendu |

Appliquer, relancer, poursuivre. Une campagne qui s'arrête sur une dépendance
éteinte n'a rien mesuré.

## 10. Les limites du dispositif, à savoir avant de s'y fier

- **Aucune mesure du DOM.** `browser_evaluate` est refusé : l'espacement, le
  contraste et les tailles se jugent **à l'œil sur une capture**. C'est un juge
  faillible — un ticket `fe:espacement` doit donc montrer un écart visible, pas
  un écart supposé de deux pixels.
- **Aucune métrique de performance web standard.** Ni LCP, ni CLS, ni INP : les
  seuils de `fe:performance` portent sur le poids, le nombre de requêtes et le
  délai perçu, qui s'observent depuis le journal réseau.
- **La latence est mesurée en local**, sur une base de jeu d'essai, sur la
  machine qui fait tourner l'API. Elle dit la tendance et attrape les gros
  écarts ; elle ne remplace pas une mesure en recette déployée.
- **L'arbre d'accessibilité ne montre pas tout** : un canvas, une animation pure
  ou un élément masqué en `aria-hidden` n'y figurent pas.
- **La campagne ne juge rien à la place de l'agent.** Les outils rendent des
  statuts, des corps, des captures. C'est la lecture qui fait le constat — et
  c'est pourquoi la grille existe.
