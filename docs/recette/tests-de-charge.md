# Tests de charge — moteur de disponibilité et tunnel de réservation

**Le risque n°1 du projet est une course** (CDC §6), et la contrainte non
négociable n°4 du [CLAUDE.md](../../CLAUDE.md) en tire la conséquence : zéro
double réservation, garantie par une contrainte d'exclusion en base, jamais par
une vérification applicative.

Ce document dit comment lancer les tirs, ce qu'ils établissent, ce qu'ils
n'établissent pas, et quels chiffres ont été relevés.

---

## 1. Deux cibles, deux propos

| Cible | Ce qu'elle prouve | Quand elle tourne |
|---|---|---|
| `npm run test:concurrency --workspace @spa/api` | une **propriété** : N écritures parallèles sur un créneau produisent exactement un rendez-vous | à chaque pull request, par la CI |
| `npm run test:load --workspace @spa/api` | une **mesure** : débit, latences, taux de conflit, sous charge soutenue | délibérément, avant une mise en production |

La distinction n'est pas cosmétique. Un moteur qui rendrait le bon résultat en
huit secondes tiendrait `test:concurrency` et ne tiendrait pas un samedi matin.
Inversement, une mesure de débit qui aurait perdu l'invariant en route ne
mesurerait plus rien — c'est pourquoi chaque scénario de charge **revérifie
l'absence de chevauchement en base** avant de conclure.

Les suites de charge sont **hors de `npm run verify`** et hors de la CI,
délibérément : elles écrivent des centaines de rendez-vous, leurs chiffres varient
avec la machine, et les mêler à la barrière de chaque PR reviendrait à faire
dépendre le merge du débit de l'exécuteur du jour.

## 2. Lancer les tirs

```bash
# prérequis : un démon Docker joignable, et rien d'autre
npm run test:load --workspace @spa/api

# campagne : le facteur multiplie les volumes, jamais la concurrence
SPA_LOAD_FACTOR=5 npm run test:load --workspace @spa/api
```

Chaque suite démarre son **propre PostgreSQL 16** (Testcontainers), y crée une
base migrée, sème un salon complet, mesure, puis détruit tout. `DATABASE_URL`
n'est pas lue : rien de ce que la machine héberge n'entre dans le résultat, et
plusieurs agents peuvent tirer de front sans se marcher dessus.

La concurrence est fixée à **16** et n'est pas réglable par l'environnement. Ce
n'est pas une timidité : le pool de connexions de la base jetable vaut vingt, et
une concurrence supérieure au pool mesurerait l'attente **dans le pool** plutôt
que le moteur.

## 3. Ce qui est chargé, et ce qui ne l'est pas

| Dans la mesure | Hors de la mesure |
|---|---|
| le calcul de créneaux et ses six lectures | la couche HTTP et sa sérialisation |
| la transaction d'insertion et son verrou d'agenda | l'ALB, le réseau, la latence de bout en bout |
| la contrainte d'exclusion `appointments_no_overlap` | le cache Redis d'`AvailabilityQueryService` |
| la résolution de la fiche cliente dans la transaction (#313) | le quota de débit et le WAF |

Aucun outil de charge externe — ni k6, ni Artillery — n'est utilisé, pour une
raison simple : ils tirent sur une **application servie**, donc sur un
environnement déployé, et ce dépôt n'en a aucun à sa disposition (#588). Ce
qu'ils mesureraient en local serait surtout le coût de la boucle HTTP du poste de
développement.

Les tirs de bout en bout sur l'environnement déployé restent donc à jouer, et
sont décrits au [§8.2 du cahier de recette](cahier-de-recette-mvp.md).

## 4. Les six scénarios

### 4.1 Moteur de disponibilité — `test/availability-engine.load-spec.ts`

Salon de quatre praticiens, sept journées, **agenda garni** de 48 rendez-vous —
sans quoi la soustraction des occupations ne coûterait rien et la mesure porterait
sur le cas qui n'arrive jamais.

| Scénario | Ce qu'il établit |
|---|---|
| **Semaine complète** — 200 calculs sur 7 jours | le cas de la page publique : aucune erreur, et **200 réponses identiques** — le déterminisme est la propriété qui compte, une seule réponse divergente voudrait dire que le moteur lit un état partiel |
| **Journée seule** — 400 calculs sur 1 jour | le cas du calendrier de back-office, plus fréquent et plus étroit |
| **Lecture sous écriture** — 200 lectures entrelacées de 24 réservations | qu'une lecture concurrente d'une écriture ne casse ni ne ment : zéro erreur, le compte de créneaux **décroît**, et deux lectures consécutives après l'arrêt des écritures rendent exactement la même chose |

### 4.2 Tunnel de réservation — `test/booking-tunnel.load-spec.ts`

Les trois scénarios **prédisent** leur taux de conflit et l'assèrent à l'unité
près. Un taux observé inférieur voudrait dire qu'un créneau a été vendu deux
fois ; un taux supérieur, qu'une réservation légitime a été refusée.

| Scénario | Forme | Conflits prédits |
|---|---|---|
| **Débit nominal** | 96 créneaux distincts, une tentative chacun | **0 %** |
| **Contention ordinaire** | 24 créneaux, 8 candidates chacun, ordre mélangé | **87,5 %** — 24 succès sur 192 |
| **Contention maximale** | 1 créneau, 32 candidates | **96,88 %** — 1 succès sur 32 |

Chaque candidate d'un scénario de contention porte **sa propre adresse e-mail** :
sans cela les huit tentatives partageraient la fiche cliente semée, et la course
sur `users` — celle de #313 — sortirait de la mesure alors qu'elle est là en
production, à chaque réservation d'invitée.

Tous les refus sont vérifiés `SlotNoLongerAvailableError` : un seul qui remonterait
brut rendrait un 500 à la cliente là où le tunnel affiche « ce créneau n'est plus
disponible » et la ramène à la grille.

## 5. Relevé de référence

**2026-09-09** · poste de développement Windows 11, Docker 29.6.1, PostgreSQL 16
en conteneur, `SPA_LOAD_FACTOR=1` · durée totale **73 s**.

### Moteur de disponibilité

| Scénario | Tentatives | Abouties | Refusées | Débit (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Conflits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Semaine complète (7 j × 4 praticiens) | 200 | 200 | 0 | 87,8 | 178,4 | 195,2 | 240,7 | 0 % |
| Journée seule (1 j × 4 praticiens) | 400 | 400 | 0 | 376,7 | 40,2 | 51,7 | 53,6 | 0 % |
| Lecture sous écriture | 224 | 224 | 0 | 103,6 | 144,4 | 227,2 | 258,7 | 0 % |

### Tunnel de réservation

| Scénario | Tentatives | Abouties | Refusées | Débit (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Conflits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Débit nominal (créneaux distincts) | 96 | 96 | 0 | 471,1 | 28,1 | 62,4 | 80,9 | **0 %** |
| Contention ordinaire (8 × 24 créneaux) | 192 | 24 | 168 | 62,9 | 26,0 | 61,4 | 69,1 | **87,5 %** |
| Contention maximale (32 × 1 créneau) | 32 | 1 | 31 | 10,2 | 44,3 | 51,4 | 54,5 | **96,88 %** |

**Zéro paire de rendez-vous actifs chevauchants en base** à l'issue de chacun des
six scénarios — relu par une jointure directe sur `appointments`, sans passer par
le code qui venait d'écrire.

### Ce que ces chiffres disent

- Le calcul d'une **journée** — ce que demande le calendrier de back-office —
  tient à près de **380 par seconde**, p95 sous 50 ms. C'est l'ordre de grandeur
  du cas fréquent.
- Le calcul d'une **semaine entière** coûte quatre fois plus par appel. C'est
  attendu : sept journées à découper, et une fenêtre d'occupation sept fois plus
  large. C'est aussi celui que le cache Redis de 60 s protège en production, et
  qui n'est **pas** dans cette mesure.
- Le tunnel **sans contention** soutient près de **470 réservations par seconde**
  sur quatre praticiens. Sous contention, le débit *utile* s'effondre — c'est le
  propre d'une contention — mais la **latence ne s'envole pas** : p99 sous 70 ms
  même quand trente-deux candidates se disputent un créneau. Le verrou d'agenda
  sérialise, il ne bloque pas.
- Les trois taux de conflit prédits sont observés **exactement**.

D'une exécution à l'autre sur la même machine, les débits varient de l'ordre de
10 à 20 % et les latences de quelques millisecondes. C'est la marge dans laquelle
un relevé ne dit rien ; ce qui se lit, ce sont les **ordres de grandeur** et les
taux de conflit, qui eux ne varient pas d'un iota.

### Ce que ces chiffres ne disent pas

Ils sont ceux d'**une machine**, un jour donné. Ils ne valent pas objectif de
service et ne doivent pas être transposés à la production : l'instance RDS, la
latence réseau et le nombre de tâches ECS n'y sont pas. Leur usage est la
**comparaison** — d'une campagne à la suivante, une dérive d'ordre de grandeur se
voit ici avant de se voir chez une cliente.

C'est pour la même raison que les assertions des suites portent sur les
**invariants** — un succès par créneau, zéro chevauchement, zéro erreur de
lecture — et sur des plafonds de latence délibérément larges, qui ne se
déclenchent que sur une régression structurelle.

## 6. Où le relevé se consigne

Dans la [feuille de verdict du cahier de recette](cahier-de-recette-mvp.md#11-feuille-de-verdict),
au moment de la campagne. Le tableau imprimé par `test:load` est en markdown et se
recopie tel quel — dans la feuille, dans le corps d'une pull request, ou dans le
journal d'exploitation.
