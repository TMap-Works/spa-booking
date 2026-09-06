# Registre des activités de traitement

Quatrième critère de l'issue #81, et mesure d'atténuation nommée par le CDC §6
en regard du risque « non-conformité RGPD » : *privacy by design, **registre des
traitements**, gestion des droits, région adaptée*.

Ce registre décrit **ce que le système fait aujourd'hui**, pas ce qu'il devrait
faire. Là où une obligation n'est pas encore outillée, la ligne le dit
explicitement plutôt que de l'omettre — un registre qui décrit un système
imaginaire est pire qu'une absence de registre, parce qu'il donne à croire que
la question a été traitée.

Version : 1.0 · Établi le 6 septembre 2026 · À revoir à chaque ajout de table
portant une donnée personnelle.

---

## 1. Qui est qui

| Rôle | Qui | Ce que cela implique |
|---|---|---|
| **Responsable de traitement** | l'établissement (le salon), pour la clientèle qu'il enregistre | il décide des finalités : qui il inscrit, ce qu'il note, ce qu'il conserve |
| **Sous-traitant** | l'éditeur de la plateforme | il traite ces données sur instruction, et n'en fait aucun usage propre |
| **Sous-traitants ultérieurs** | AWS, Stripe | voir §5 |

Le produit est **multi-tenant** : chaque établissement est un responsable de
traitement distinct, et l'isolation logique décrite au §4 est ce qui rend cette
séparation effective plutôt que déclarative.

## 2. Les traitements

### 2.1 Gestion des rendez-vous

| | |
|---|---|
| **Finalité** | permettre à une personne de réserver une prestation, et à l'établissement de l'honorer |
| **Base légale** | exécution d'un contrat (art. 6.1.b) |
| **Personnes concernées** | clientèle de l'établissement |
| **Catégories de données** | identité (nom, prénom), coordonnées (e-mail, téléphone), créneau, prestation, praticien, prix, statut, notes libres de la cliente et du salon |
| **Où** | `users`, `appointments` — modules `crm` et `appointments` |
| **Destinataires** | le personnel de l'établissement, selon son rang |
| **Conservation** | tant que la fiche cliente existe (voir §3) |

### 2.2 Fichier client et notes internes

| | |
|---|---|
| **Finalité** | tenir la relation client : retrouver une fiche, corriger un numéro, noter une contre-indication |
| **Base légale** | intérêt légitime de l'établissement (art. 6.1.f) — tenir le dossier de sa propre clientèle |
| **Catégories de données** | identité, coordonnées, **note interne** en texte libre, historique agrégé des visites |
| **Où** | `users` (dont `internal_note`) — module `crm` |
| **Destinataires** | rang `STAFF` et au-dessus. Le fichier client n'a **aucune surface publique ni aucune route ouverte au rôle `CLIENT`** |
| **Point d'attention** | la note interne est un texte libre saisi par un humain. Elle est incluse dans l'export du droit d'accès (§3), et vidée par l'anonymisation |

### 2.3 Comptes et authentification

| | |
|---|---|
| **Finalité** | ouvrir une session au personnel et aux clientes qui se créent un compte |
| **Base légale** | exécution d'un contrat (art. 6.1.b) et intérêt légitime pour la sécurité |
| **Catégories de données** | adresse e-mail, empreinte de mot de passe (**jamais le mot de passe**), rôle, date de dernière connexion, sessions actives |
| **Où** | `users`, `refresh_tokens` — module `identity` |
| **Note** | `refresh_tokens` ne stocke pas le jeton mais l'empreinte SHA-256 de son identifiant : une fuite de cette table ne donne aucune session |

### 2.4 Notifications transactionnelles

| | |
|---|---|
| **Finalité** | confirmer un rendez-vous, rappeler la veille, prévenir d'une annulation |
| **Base légale** | exécution du contrat (art. 6.1.b) — **pas le consentement** |
| **Catégories de données** | destinataire (par référence au compte), canal, type, statut d'envoi, identifiant de message du prestataire |
| **Où** | `notifications` — module `notifications` |
| **Propriété notable** | la table **ne recopie pas l'adresse ni le numéro** du destinataire : elle porte une référence au compte, et la destination se relit au moment de l'envoi. Une fiche anonymisée cesse donc d'être joignable sans qu'aucune ligne de notification n'ait à être réécrite |
| **Pourquoi pas le consentement** | subordonner un rappel de rendez-vous à un consentement retirable romprait le service demandé par la cliente elle-même. C'est le marketing, et lui seul, qui repose sur le consentement (§2.6) |

### 2.5 Encaissement

| | |
|---|---|
| **Finalité** | encaisser une prestation ou une vente au comptoir, rembourser |
| **Base légale** | exécution du contrat, et **obligation légale** pour la conservation comptable (art. 6.1.c) |
| **Catégories de données** | montant, devise, méthode, statut, références opaques du prestataire, auteur du geste |
| **Où** | `payments`, `payment_refunds`, `sales`, `sale_items` — module `payments` |
| **Aucune donnée de carte** | la tokenisation se fait côté client vers Stripe. Le serveur ne conserve que des références opaques : pas de PAN, pas de cryptogramme, pas de date d'expiration. C'est ce qui maintient le périmètre PCI en SAQ A (CDC §5.2), et `prisma-schema.spec.ts` interdit qu'une colonne de ce genre apparaisse |
| **Conséquence sur l'effacement** | ces lignes ne se suppriment pas : c'est la raison pour laquelle le droit à l'oubli est servi par **anonymisation** (§3) |

### 2.6 Consentement au démarchage commercial

| | |
|---|---|
| **Finalité** | savoir qui accepte d'être démarché, le jour où une fonctionnalité de marketing existera |
| **Base légale** | consentement (art. 6.1.a) |
| **Catégories de données** | un booléen et sa date |
| **Où** | `users.marketing_consent`, `users.marketing_consent_at` — module `crm` |
| **État** | la colonne existe et se recueille ; **aucun traitement de marketing n'est implémenté**, le CDC §1.4 le plaçant hors périmètre MVP. Elle est posée maintenant parce qu'un consentement ne se recueille pas rétroactivement |
| **Règles** | le défaut est le refus (le consentement est un acte positif, art. 4.11) ; toute prise de position est datée, y compris un refus (la preuve exigée par l'art. 7.1) ; la date ne bouge que sur un changement de valeur |

## 3. Les droits des personnes, et comment ils s'exercent

Le CDC §5.1 exige des « mécanismes d'accès, de rectification, d'export et de
suppression ». Ils passent tous par le back-office : c'est l'établissement qui
reçoit la demande et l'exécute pour la personne.

| Droit | Ce qui le sert | Rang |
|---|---|---|
| **Accès** (art. 15) | `GET /api/v1/customers/:id/export` | `MANAGER` |
| **Portabilité** (art. 20) | la même route — JSON, « structuré, couramment utilisé et lisible par machine » | `MANAGER` |
| **Rectification** (art. 16) | `PATCH /api/v1/customers/:id` | `STAFF` |
| **Effacement** (art. 17) | `POST /api/v1/customers/:id/anonymize` | `ADMIN` |
| **Opposition au démarchage** (art. 21) | `PATCH /api/v1/customers/:id` avec `marketingConsent: false` | `STAFF` |

### Ce que l'export contient

Identité, coordonnées, consentements avec leur date, la note interne du salon,
et **la totalité** des rendez-vous — textes libres compris : ce que la cliente a
écrit en réservant, ce que le salon a noté sur elle, le motif d'une annulation.
Le document est daté et non paginé : un export tronqué a l'apparence d'une
réponse au titre de l'art. 15 sans en être une.

Il ne porte **aucun identifiant d'établissement** : le destinataire est la
personne, pas le salon.

### Pourquoi l'effacement est une anonymisation

`appointments.client_id` référence `users` en `RESTRICT`, et les encaissements
comme les tickets de comptoir s'accrochent à ces rendez-vous. Supprimer la ligne
emporterait l'historique comptable des ventes passées, que l'établissement est
tenu de conserver — c'est le conflit classique entre l'art. 17 et l'obligation
comptable, et l'anonymisation est la sortie que le CDC §5.1 nomme lui-même en
écrivant « suppression **ou** anonymisation ».

Ce qui part : nom, prénom, adresse e-mail, téléphone, note interne, empreinte de
mot de passe, et les trois textes libres de chacun de ses rendez-vous. Ce qui
reste : des montants, des dates et un identifiant opaque, que plus rien ne
rattache à une personne.

Le geste **refuse** tant qu'un rendez-vous à venir occupe l'agenda (422) : le
traitement reste alors nécessaire à l'exécution du contrat (art. 17.1.b), et un
salon ne peut ni préparer ni décommander une visite dont la cliente n'a plus de
nom. Le refus est temporaire — honorer, ou annuler.

### Ce qui n'est pas encore outillé

- **la demande de la personne elle-même.** Une cliente connectée lit et corrige
  son profil (`GET /auth/me`, `PATCH /users/me`) mais ne déclenche ni export ni
  effacement depuis son espace : elle en fait la demande au salon. Ouvrir ces
  routes au rôle `CLIENT` est une décision de produit à part entière ;
- **la révocation des sessions ouvertes à l'anonymisation.** L'empreinte de mot
  de passe est effacée — aucune nouvelle connexion n'est possible — mais les
  `refresh_tokens` déjà émis ne sont pas purgés par ce geste : la table
  appartient au module `identity`. Une issue de suivi le porte ;
- **la purge automatique des données arrivées à échéance** (§6).

## 4. Mesures de sécurité

| Mesure | Comment elle est tenue |
|---|---|
| **Cloisonnement multi-tenant** | `tenant_id` non nullable sur toute table métier, scoping automatique par extension Prisma, filtre injecté hors de portée du développeur. Une ressource d'un autre établissement rend **404**, jamais 403 — un 403 confirmerait son existence |
| **Chiffrement au repos** | RDS et ElastiCache chiffrés par clé KMS (`storage_encrypted = true`, `kms_key_id`) |
| **Chiffrement en transit** | TLS |
| **Aucune donnée de carte** | tokenisation côté client vers Stripe, périmètre PCI en SAQ A |
| **Aucune donnée personnelle dans les journaux** | le module `crm` ne journalise rien du tout — vérifié par un test qui relit ses sources — et la rédaction de `common/logging/redaction.ts` masquerait de toute façon nom, prénom, adresse, téléphone et notes par nom de champ |
| **Minimisation des projections** | la liste du fichier client ne lit même pas la note interne ; l'export ne lit les rendez-vous qu'après avoir trouvé la fiche |
| **Secrets** | AWS Secrets Manager en déployé, jamais dans le code ni dans un `.env` versionné |
| **Sauvegardes** | RDS, rétention d'au moins 30 jours en production (contrainte vérifiée par la validation Terraform) |

Les tests d'isolation inter-tenant sont **obligatoires pour tout endpoint
nouveau ou modifié** : ils créent une ressource chez A, s'authentifient comme B,
et exigent 404 sur lecture, écriture et suppression.

## 5. Sous-traitants ultérieurs et transferts

| Prestataire | Ce qu'il traite | Où |
|---|---|---|
| **AWS** | hébergement, base de données, cache, stockage, e-mail (SES), SMS (SNS) | `eu-west-3` (Paris) — voir §6 |
| **Stripe** | données de paiement, y compris les données de carte que notre code ne voit jamais | selon les conditions du prestataire, qui est certifié PCI-DSS niveau 1 |

Aucun autre destinataire. Les données ne sont ni revendues, ni mutualisées entre
établissements, ni utilisées pour entraîner quoi que ce soit.

## 6. Résidence des données

Cinquième critère de l'issue #81, et exigence du CDC §5.1 (« choix de la région
AWS en cohérence avec les obligations de localisation ») et §4.2 (« ex.
eu-west-1/eu-west-3 pour l'Europe/Afrique »).

**Les trois environnements sont en `eu-west-3` (Paris)** — dev, staging et
production. La valeur est posée à deux endroits, et les deux sont vérifiables :

- `infra/terraform/envs/{dev,staging,prod}/backend.tf` — la région du bucket
  d'état Terraform ;
- `infra/terraform/envs/{dev,staging,prod}/variables.tf` et `providers.tf` — la
  région du fournisseur AWS, dont **toutes** les ressources héritent : réseau,
  ECS, RDS, ElastiCache, et le module `notifications` (SES/SNS), qui ne déclare
  aucun fournisseur avec un alias de région distincte.

Aucune ressource n'est créée à la main (contrainte non négociable n° 5 du
projet) : la région déclarée est donc la région réelle, et un changement se
verrait en revue de code.

Ce que cela ne couvre pas : les traitements opérés par Stripe, dont la
localisation relève de ses propres conditions. C'est le prix assumé de
l'externalisation de la conformité PCI-DSS (CDC §5.2).

## 7. Durées de conservation

| Donnée | Durée retenue | État |
|---|---|---|
| Fiche cliente et rendez-vous | tant que la relation commerciale dure, puis anonymisation à la demande | **manuel** — aucun balayage automatique n'existe |
| Pièces comptables (encaissements, ventes) | durée légale de conservation applicable à l'établissement | conservées, jamais supprimées par l'application |
| Sessions (`refresh_tokens`) | jusqu'à expiration ou déconnexion | automatique |
| Journaux applicatifs | selon la rétention CloudWatch configurée | infrastructure |

**L'écart à assumer, nommé ici plutôt que passé sous silence :** le MVP ne comporte
aucune purge planifiée des fiches clientes inactives. L'anonymisation est
disponible à la demande, elle n'est pas déclenchée d'elle-même au bout de N
années d'inactivité. Un balayage périodique — qui est un traitement à part
entière, avec sa décision produit sur le seuil et sa notification préalable —
fait l'objet d'une issue de suivi.

## 8. Ce que ce registre n'a pas encore à couvrir

Le périmètre MVP est figé à six domaines (CDC §1.4). Les traitements suivants
n'existent pas, et ce registre sera à reprendre le jour où l'un d'eux sera
livré : campagnes marketing, programme de fidélité, cartes cadeaux, avis
clients, assistant IA, marketplace.

C'est aussi pourquoi `marketing_consent` est une **colonne sans traitement** :
elle recueille aujourd'hui la base légale d'un traitement qui n'existera que
demain.
