# Backlog post-MVP — priorisé

**À quoi sert ce document.** Le périmètre MVP est figé (CDC §1.4, contrainte non
négociable n°1 du [CLAUDE.md](../CLAUDE.md)). Tout ce qui en sort a été écarté au
fil des quatre semaines — parfois d'une phrase dans une revue, parfois d'une
issue fermée sans être traitée. Ce document rassemble ces écarts en un seul
endroit, **rangés par valeur**, pour que la rétrospective du MVP ait un dossier à
lire plutôt qu'une mémoire à solliciter.

**Ce qu'il n'est pas.** Ni un engagement, ni un plan de charge, ni un
remplacement du tri d'issues. Une ligne d'ici ne devient une issue que lorsqu'un
humain décide de la faire — ouvrir une issue par ligne noierait le backlog du
produit sous des intentions.

> **Comment le lire.** Quatre rangs, dans l'ordre où ils devraient être servis :
> **A** ce qui protège le service en production · **B** les lacunes
> fonctionnelles du périmètre livré · **C** la dette technique qui coûte à être
> gardée · **D** la trajectoire de croissance du CDC §7.3, hors périmètre par
> construction.
>
> Les rangs A à C se servent **avant** le rang D : une plateforme qui ajouterait
> les cartes cadeaux avant de fermer un CSRF vendrait de la fonctionnalité sur un
> socle qui fuit.

---

## Rang A — Ce qui protège le service en production

Ces points ont un effet direct sur la sécurité, la disponibilité ou la capacité à
diagnostiquer une panne. **Ils devraient être servis dans les semaines qui suivent
le lancement**, pas au trimestre suivant.

| # | Sujet | Pourquoi c'est ici |
|---|---|---|
| **#347** | La déconnexion subie de l'espace client est déclenchable par un tiers (CSRF) | Une faille exploitable depuis n'importe quelle page tierce. Coût de correction faible, coût d'exposition non |
| **#331** | Les quotas `ThrottlerGuard` comptent l'IP de l'ALB — « trust proxy » n'est pas activé | **Tous** les quotas de débit du produit comptent aujourd'hui une seule adresse : celle de l'équilibreur. Les 10 réservations/min/IP et les 120 disponibilités/min/IP ne protègent donc personne en déployé, et peuvent au contraire couper tout le monde d'un coup |
| **#228** | Limiter le débit sur l'espace de réservation public — énumération de slugs | La page publique répond 404 sur un slug inconnu, mais rien n'empêche de les énumérer pour découvrir la clientèle de la plateforme |
| **#407** | Refuser un établissement désactivé sur `refresh`, `acceptInvitation` et `JwtAuthGuard` | Un établissement désactivé garde des sessions vivantes : la désactivation ne coupe rien tant que les jetons courent |
| **#340** | Forcer `postcss ≥ 8.5.18` — deux CVE HIGH épinglées par Next 15 | Deux vulnérabilités connues dans la chaîne de construction du front |
| **#162** | Journaux d'accès de l'ALB — bucket S3, politique et rétention | Sans eux, aucune reconstitution possible d'un incident de bord : ni l'adresse d'origine, ni la latence par requête |
| **#166** | Chiffrer les journaux CloudWatch du niveau données avec la clé KMS du module | Les journaux applicatifs portent des identifiants de rendez-vous et de fiches ; ils sont aujourd'hui chiffrés par la clé de service, pas par celle du compte |
| **#501**, **#502** | Instrumenter l'API au SDK X-Ray ; durcir la supervision (miroir ECR du sidecar, calcul du taux de 5xx) | Les alarmes existent en Terraform ; ce qui manque est la **trace** qui dit *où* une requête lente a passé son temps |
| **#586** | Exercer les fumigations Lambda du module notifications sur le majeur Node du runtime déployé | Les trois Lambda ont basculé sur `nodejs22.x` ; la fumigation, elle, tourne encore sur le majeur du poste |

## Rang B — Lacunes fonctionnelles du périmètre livré

Ces points sont **dans** le périmètre MVP au sens du CDC, et ne sont pas servis.
Ils ne bloquent pas le lancement — le [cahier de recette](recette/cahier-de-recette-mvp.md#10-ce-que-ce-cahier-ne-couvre-pas-et-pourquoi)
les recense pour qu'ils ne passent pas pour des régressions — mais chacun se voit
depuis un écran.

| Sujet | Ce qui manque, exactement | Valeur |
|---|---|---|
| **Règle d'annulation** | Ni délai minimal, ni fenêtre de franchise, ni pénalité. L'annulation est possible **à tout moment** tant que le rendez-vous est à confirmer ou confirmé ; ce qui la borne est la seule table des transitions. Le code renvoie à une issue **#48 qui est fermée et portait un autre sujet** — aucune issue ouverte ne porte donc ce besoin aujourd'hui | **Haute.** C'est la première demande d'un salon qui perd des créneaux le samedi matin |
| **Lien durable d'annulation par e-mail** | Le tunnel n'annule que depuis son écran de confirmation, qui ne survit ni à un changement d'onglet ni à un autre appareil. Une invitée sans compte n'a donc plus aucun moyen d'annuler | **Haute.** Sans lui, l'annulation d'une invitée passe par un appel au salon — c'est-à-dire par un no-show |
| **Écran de caisse multi-lignes** | `lib/admin/checkout-summary.ts` et `POST /api/v1/sales` portent déjà les lignes prestation, produit et pourboire, la taxe recalculée serveur et le ticket. **Aucun écran ne les expose** : seul l'encaissement rattaché à un rendez-vous est servi | **Haute.** Le POS « services + produits retail » est explicitement au MVP (CDC §1.4) ; il est écrit mais pas vendable |
| **Passage automatique en « honoré » après encaissement** | L'écran de reçu le dit lui-même : le rendez-vous reste dans son statut après règlement | Moyenne. Un geste manuel de plus par cliente |
| **#406** — Expédier l'invitation de personnel par e-mail | L'invitation rend son jeton **dans la réponse HTTP**, à recopier à la main. Le jeton transite donc par le presse-papier de l'administrateur | Moyenne, et **partiellement de sécurité** |
| **Création d'une fiche praticien** | On invite un **compte** ; la fiche qui porte l'agenda et la vitrine n'est créée par aucune route. L'écran l'annonce | Moyenne |
| **Écran des jours de fermeture** | `GET`/`PUT /api/v1/closing-days` existent et fonctionnent ; aucun écran ne les sert | Faible — contournable par un appel |
| **#333** — Déduplication des réservations d'une même cliente sur un créneau chevauchant | Rien n'empêche une cliente de réserver deux prestations qui se chevauchent chez deux praticiens différents | Faible au MVP, gênante à l'échelle |
| **#488** — Libellé accessible des créneaux de report | Le tunnel annonce « 14 h 00 », l'écran de report non : deux libellés pour le même objet | Faible |

## Rang C — Dette technique qui coûte à être gardée

Rangée par ce qu'elle coûte si on la laisse, pas par sa difficulté.

**Correction et cohérence du domaine**

| # | Sujet | Ce que ça coûte de le garder |
|---|---|---|
| **#412** | `payments` lit et écrit `appointments` sans passer par son service | Deux modules écrivent la même table : la prochaine règle de cycle de vie devra être posée à deux endroits, ou sera oubliée à l'un des deux |
| **#321** | `appointment.cancelled` publie un `previousStatus` lu **avant** l'écriture | L'événement peut annoncer un état que la base n'a jamais eu ; les consommateurs en dépendent |
| **#207** | Raccorder `apps/api` à `@spa/shared` — les rôles ne sont pas écrits dans la même casse des deux côtés | La casse des énumérations diverge déjà entre requêtes et réponses ; la source de vérité est censée être unique |
| **#338** | Résorber les trois copies de la frontière « date-heure à offset » vers `@spa/shared` | Trois implémentations d'une conversion de fuseau, donc trois occasions de dériver — et un rendez-vous mal fuseau-horairé est un bug de sévérité haute |
| **#230** | Retirer la colonne héritée `services.category` | Second déploiement d'un retrait entamé ; la colonne survit sans lecteur |

**Preuve et outillage de test**

| # | Sujet | Ce que ça coûte de le garder |
|---|---|---|
| **#336** | `ProbeDouble` n'implémente pas les verrous : le verrou de créneau est **inerte** dans toutes les suites HTTP | Le verrou consultatif d'agenda n'est exercé que par les suites de concurrence et de charge. Toute suite HTTP qui croirait le prouver ne prouve rien |
| **#499** | Exercer le SQL brut de `reporting` et `crm` contre un vrai PostgreSQL | Les agrégats du reporting sont écrits en SQL brut et vérifiés contre des doubles : une erreur de `GROUP BY` passerait |
| **#282** | La base jetable des tests de fuite n'est pas encore un conteneur Testcontainers | Une suite d'isolation dépend encore de la machine |
| **#240** | Rattacher les suites du design system à `npm run test:unit` | 47 assertions écrites, jouées par personne |

**Performance et exploitation**

| # | Sujet | Ce que ça coûte de le garder |
|---|---|---|
| **#329** | Cache de disponibilité : espace de clés versionné par tenant plutôt qu'invalidation par balayage | Chaque écriture d'agenda balaie les clés Redis du tenant. À une centaine de salons, le balayage devient le coût dominant |
| **#330** | Un seul client Redis : exposer les commandes de cache sur `CacheConnection` | Deux connexions Redis là où une suffit |
| **#506** | Index `(tenant_id, created_at)` pour le journal d'envois | Le journal de notifications est lu « plus récent d'abord » sans index qui le serve |
| **#205** | `modules/ecs-service` : découpler la clé KMS journaux/secrets, absorber la tâche de migration, sortir l'étiquette d'image de l'état | L'étiquette d'image dans l'état Terraform fait dériver tout `plan` après chaque déploiement |
| **#204** | `deploy-staging.yml` et `deploy-production.yml` portent encore des défauts corrigés sur `dev` | Deux workflows de déploiement divergents du seul qui a été éprouvé |

## Rang D — Trajectoire de croissance (CDC §7.3)

**Hors périmètre MVP par construction.** Le CDC les range explicitement « par
ordre de valeur » ; cet ordre est repris tel quel, avec ce que chacun suppose
d'acquis.

| Rang | Sujet | Ce qu'il suppose d'être déjà en place |
|---:|---|---|
| 1 | **Abonnements et forfaits** | Un POS complet (rang B) et un rapprochement de paiement éprouvé ; c'est de la facturation récurrente, donc du cycle de vie d'abonnement Stripe |
| 2 | **Cartes cadeaux** | Un solde porté par une entité propre, et une règle d'imputation sur le ticket — donc le POS multi-lignes |
| 3 | **Campagnes marketing et e-mailing** | Le consentement marketing **existe déjà** en base (`marketing_consent`, sa date, et la suppression list de délivrabilité). Ce qui manque est la segmentation et l'envoi de masse — et une frontière nette avec le transactionnel, qui ne doit jamais partager sa réputation d'expéditeur |
| 4 | **Gestion d'inventaire (back bar)** | Le catalogue produit du POS (`products`, `sales`) est posé ; l'inventaire y ajoute un stock, ses mouvements et ses seuils |
| 5 | **Pourboires multi-staff** | Le pourboire existe au ticket (`TIP`) mais n'est **pas réparti** : la ventilation par praticien suppose de savoir qui a réalisé quelle ligne |
| 6 | **Support multi-établissement** | Le modèle est multi-tenant depuis le premier jour et le sélecteur d'établissement du back-office est déjà là, inerte faute de second salon à proposer. Ce qui manque est une **identité qui traverse** deux établissements, ce que le modèle actuel interdit délibérément |
| 7 | **Assistant de messagerie IA** | Une chaîne de notifications éprouvée dans les deux sens — le MVP n'émet que sortant |
| 8 | **Application mobile native (React Native)** | Une API stable et versionnée : elle l'est (`/api/v1`), et c'est ce qui rend ce point tardif plutôt que bloqué |

**Explicitement hors périmètre et non repris ici** : la paie (payroll) et le
référencement sur une place de marché tierce. Le CDC les cite comme hors
périmètre sans les inscrire à la trajectoire ; les y ajouter serait une décision
produit, pas une lecture du cahier des charges.

---

## Ce qui n'est pas dans ce document

- **Les tickets d'outillage** (`nature:outillage`) — `scripts/`, `.claude/`, la
  CI de collaboration. Ils vivent dans leur propre file et se déroulent
  séparément, en séquentiel (`/milestone <jalon> --nature outillage`).
- **Le reste du lancement lui-même** — appliquer `envs/staging` et `envs/prod`,
  éprouver les alarmes, jouer le runbook de restauration, faire valider la
  recette par le PO. Ce sont des gestes qui exigent un compte AWS et une session
  humaine : **#588** (recette), **#590** (production), **#526** et **#82**
  (restauration RDS), **#200** (validation de `envs/dev`).
- **Les régressions trouvées en recette** — elles deviennent des issues `type:bug`
  au fil de la campagne, pas des lignes de backlog.

---

*Dernière revue : 2026-09-09, à la clôture du jalon S4. Ce document se relit à
chaque rétrospective : une ligne servie en sort, une ligne née d'un incident y
entre.*
