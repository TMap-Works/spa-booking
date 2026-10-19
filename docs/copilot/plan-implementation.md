# Plan d'implémentation — Copilot IA

- **Version** : 0.1 · 2026-10-08
- **Jalon GitHub** : `Copilot IA` (à créer)
- **Références** : [ADR 0018](../adr/0018-copilot-ia-dans-le-produit.md) ·
  [spécification](specification.md) · [inventaire](inventaire.md)

## Règles du plan

Ce plan suit le flux du dépôt ([project-flow](../../.claude/skills/project-flow/SKILL.md)) :

- **une issue par ligne**, avec son jalon et tous ses labels : workstream
  (`ws:`), module (`mod:`), type (`type:`), nature et priorité. Une issue sans
  label `nature:*` est écartée du plan ;
- tout le chantier est **`nature:projet`** : c'est du produit, pas de
  l'outillage Claude Code ;
- les modules du CDC n'ont pas de place pour le copilot. On crée le label
  **`mod:copilot`** pour ce qui lui est propre, et on garde le `mod:` du module
  métier quand un ticket touche son écran (le tunnel, par exemple) ;
- chaque ticket déclare son **empreinte de fichiers** : c'est ce qui permet à
  `/milestone` de mener de front les tickets disjoints ;
- Definition of Done inchangée : revu, testé (unitaire et intégration),
  recetté (phase 4bis), documenté.

Priorités : `P0` bloque le chantier, `P1` est requis pour la V1, `P2` est
souhaitable.

---

## Phase 0 — Cadrage

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P0-01 | ADR 0018, spécification, inventaire, plan : relecture et passage de l'ADR en « Accepté » | `type:docs` `mod:copilot` `ws:design` `P0` | `docs/adr/0018-*`, `docs/copilot/` | — |
| P0-02 | Inventaire : compléter les lignes *(à vérifier)* et relever l'endpoint de chaque action | `type:docs` `mod:copilot` `ws:backend` `P0` | `docs/copilot/inventaire.md` | P0-01 |
| P0-03 | Jalon `Copilot IA`, label `mod:copilot`, issues de ce plan | `type:chore` `ws:devops` `P0` | GitHub uniquement | P0-01 |

**Sortie de phase** : l'ADR est accepté et l'inventaire ne contient plus de
*(à vérifier)*.

## Phase 1 — Socle

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P1-01 | **Spike** : CopilotKit + Claude, sur `claude-haiku-5-5` **et** `claude-sonnet-5-5`, le modèle étant réglé par configuration. Vérifier le streaming, l'appel d'outil sans `tool_choice` forcé, le renvoi des blocs de réflexion sans réécriture, et la gestion des refus. **Trancher** entre l'adaptateur Anthropic et une boucle maison sur le SDK officiel exposée en AG-UI. Consigner le résultat dans l'ADR 0018. | `type:spike` `mod:copilot` `ws:frontend` `P0` | branche jetable + ADR 0018 | P0-01 |
| P1-02 | Registre d'actions et types de session dans `packages/shared`, avec test de cohérence (chaque action a un `exige` valide, chaque écriture est confirmée) | `type:feature` `mod:copilot` `ws:backend` `P1` | `packages/shared/src/copilot/` | P0-02 |
| P1-03 | Clé Anthropic : secret dans Secrets Manager (Terraform), variable d'environnement de la tâche ECS du web, `.env.local.example` | `type:chore` `mod:infra` `ws:devops` `P1` | `infra/terraform/` | P0-01 |
| P1-04 | Route `app/api/copilotkit` : runtime, branchement à Claude selon le spike, streaming, refus | `type:feature` `mod:copilot` `ws:frontend` `P1` | `apps/web/app/api/copilotkit/`, `apps/web/lib/copilot/runtime*` | P1-01, P1-03 |
| P1-05 | **Détection de session** (spéc. §5) : cookies et renouvellement, `GET /v1/auth/me` avec cache de 30 s, recoupement jeton/URL, `CopilotSession`, filtrage du registre | `type:feature` `mod:copilot` `mod:identity` `ws:frontend` `P1` | `apps/web/lib/copilot/session*` | P1-02 |
| P1-06 | Interface du chat aux jetons du design system : panneau (back-office), bulle (public), plein écran à 360 px, clair et sombre, accessibilité, libellés `fr` et `en` | `type:feature` `mod:copilot` `ws:frontend` `P1` | `apps/web/components/copilot/`, `apps/web/messages/*/copilot.json` | P1-01 |
| P1-07 | Orchestrateur : prompt système, garde-fou de contexte (EF-1), lectures directes (étage 1), appel des spécialistes comme outils et passe-plat (spéc. §6.2), suggestions par surface exécutées sans modèle (étage 0, EF-2), cache de prompt | `type:feature` `mod:copilot` `ws:frontend` `P1` | `apps/web/lib/copilot/agents/orchestrateur*`, `apps/web/lib/copilot/suggestions*` | P1-04, P1-05 |
| P1-08 | Quotas Redis (utilisateur, visiteur, salon), bornes de message, d'appels d'outils et de tours, traces OpenTelemetry, compteurs de tokens et répartition par étage (spéc. §9) | `type:feature` `mod:copilot` `ws:devops` `P1` | `apps/web/lib/copilot/quotas*`, `apps/web/lib/copilot/telemetry*` | P1-04 |

**Sortie de phase** : le chat répond aux couleurs du site, connaît la session,
décline le hors-sujet, et ne propose rien de ce que l'utilisateur ne peut pas
faire. Aucune action n'est encore branchée.

**P1-01 est fait (2026-10-08)** : le bilan est dans l'ADR 0018, à « Résultat
du spike ». Le banc d'essai `/copilot-spike` reste disponible en local jusqu'à
ce que P1-06 installe le chat dans les vrais écrans.

**Premier constat du spike (2026-10-08, CopilotKit 1.73.3)**, relevé dans le
code installé (`@copilotkit/runtime`, `v1-deprecated/service-adapters/anthropic`) :

- l'`AnthropicAdapter` appartient à l'**API v1, marquée dépréciée**, et n'a
  « pas de remplaçant 1:1 » en v2 (`@copilotkit/runtime/v2`) ;
- il **tronque l'historique** pour tenir dans un budget de tokens
  (`limitMessagesToTokenCount`) et **ne renvoie pas les blocs de réflexion** :
  les deux contreviennent à la règle d'historique en ajout seul (spéc. §6.4) ;
- il peut **forcer un outil** (`tool_choice: { type: "tool" }`), ce que Sonnet
  5.5 refuse ;
- il ne règle **ni l'effort ni la réflexion**, et plafonne la sortie à 4 096 tokens.

L'option de repli de l'ADR 0018 devient donc l'option de travail : **runtime v2
de CopilotKit et agent maison sur `@anthropic-ai/sdk`, exposé en AG-UI**. Le
spike la confirme de bout en bout, sans adopter l'adaptateur v1.

**Dépendances** : `@copilotkit/runtime` ajoute 18 alertes `npm audit`
(5 `high`, 8 `low`), dont `graphql-yoga`, `@graphql-tools/utils` (pollution de
prototype) et `@fastify/busboy`. La dernière version (1.77.1) a les mêmes
plages. Le spike mesure ce qui reste avec le runtime v2 et traite le reste par
`overrides`, comme #1338. Versions épinglées à plus de deux semaines :
`@copilotkit/*` 1.73.3, `@anthropic-ai/sdk` 0.128.0.

Tickets menables de front une fois P1-01 fini : P1-02, P1-03 et P1-06 ont des
empreintes disjointes.

## Phase 2 — Priorité 1 : la réservation

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P2-01 | Spécialiste **Réservation**, exposé comme outil `agent_reservation`, avec le contrat brief / résultat structuré (spéc. §6.2.3) : `salon.infos`, `catalogue.chercher`, `disponibilite.creneaux`, `reservation.ouvrir_tunnel` | `type:feature` `mod:copilot` `ws:frontend` `P1` | `apps/web/lib/copilot/agents/reservation*`, `apps/web/components/copilot/actions/reservation*` | P1-07 |
| P2-02 | Tunnel : paramètres `?jour=` et `?plage=` sur l'étape créneau, utilisables à la main comme par le chat (fuseau du salon, ADR 0006) | `type:feature` `mod:availability` `ws:frontend` `P1` | `apps/web/lib/booking/draft.ts`, `apps/web/components/booking/slot-step.tsx`, `date-band.tsx` | P0-02 |
| P2-03 | Animation des listes filtrées (créneaux, praticiens), `prefers-reduced-motion` respecté | `type:feature` `mod:availability` `ws:frontend` `P1` | `apps/web/components/booking/` (hors `slot-step.tsx` et `date-band.tsx` tant que P2-02 est ouvert) | — |
| P2-04 | Spécialiste **Guide** : `guide.mener`, `salon.politique_donnees` ; routes proposées selon les permissions | `type:feature` `mod:copilot` `ws:frontend` `P2` | `apps/web/lib/copilot/agents/guide*` | P1-07 |
| P2-05 | E2E : « je veux un massage demain après-midi » mène au tunnel filtré (CA-1), avec un modèle simulé | `type:feature` `mod:copilot` `ws:qa` `P1` | `apps/web/tests/e2e/copilot-*` | P2-01, P2-02 |

**Sortie de phase** : CA-1 est vert.

## Phase 3 — Priorité 1 : les rendez-vous

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P3-01 | Carte de confirmation générique dans le chat (récapitulatif, valider, refuser). L'écriture préparée est gardée côté serveur (Redis) et la validation l'exécute sans modèle (étage 0) ; restitution des refus de l'API | `type:feature` `mod:copilot` `ws:frontend` `P1` | `apps/web/components/copilot/confirmation*` | P1-06 |
| P3-02 | Spécialiste **Rendez-vous**, côté cliente : `mes_prochains`, `mon_historique`, `ouvrir_report`, `reporter` ✋, `annuler` ✋ | `type:feature` `mod:copilot` `mod:appointments` `ws:frontend` `P1` | `apps/web/lib/copilot/agents/rendez-vous*` | P3-01 |
| P3-03 | Côté praticien : `planning.ma_journee`, `marquer_honore` ✋, `marquer_absent` ✋ | `type:feature` `mod:copilot` `mod:appointments` `ws:frontend` `P1` | `apps/web/lib/copilot/agents/rendez-vous/praticien*` | P3-02 |
| P3-04 | Côté gérance : `planning.ouvrir`, `planning.creneaux_libres`, `rendez_vous.poser` ✋ | `type:feature` `mod:copilot` `mod:appointments` `ws:frontend` `P1` | `apps/web/lib/copilot/agents/rendez-vous/gerance*` | P3-02 |
| P3-05 | Tests de fuite entre salons et d'élévation de rôle sur chaque action (CA-3, CA-4) | `type:feature` `mod:copilot` `ws:qa` `P1` | `apps/web/tests/copilot/isolation*` | P3-02 |

**Sortie de phase** : CA-2, CA-3 et CA-4 sont verts.

## Phase 4 — Les autres domaines

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P4-01 | Spécialiste **Encaissement et reporting** : `encaissement.a_regler`, `encaissement.ouvrir`, `tableau_de_bord.resumer`, `reporting.lire`, `reporting.ouvrir` | `type:feature` `mod:copilot` `mod:payments` `mod:reporting` `ws:frontend` `P2` | `apps/web/lib/copilot/agents/encaissement*` | P3-01 |
| P4-02 | Spécialiste **Clients** : `clients.chercher`, `clients.ouvrir_fiche` (minimisation : pas de note interne dans le contexte) | `type:feature` `mod:copilot` `mod:crm` `ws:frontend` `P2` | `apps/web/lib/copilot/agents/clients*` | P3-01 |
| P4-03 | Curseur fantôme (EF-4, bonus) | `type:feature` `mod:copilot` `ws:frontend` `P2` | `apps/web/components/copilot/curseur*` | P2-01 |

## Phase 5 — Durcissement et mise en production

| # | Ticket | Labels | Empreinte | Dépend de |
|---|---|---|---|---|
| P5-01 | Jeu d'évaluation (hors-sujet, faits, choix d'action), lancé à la demande contre Claude, **qui compare Haiku 5.5 et Sonnet 5.5 par agent** et fonde la répartition des modèles (CA-6, spéc. §6.4.1). Il peut être avancé en phase 3 si les écritures de Haiku posent problème. | `type:feature` `mod:copilot` `ws:qa` `P1` | `apps/web/tests/copilot/eval/` | P3-04 |
| P5-02 | Campagne d'injection de prompt sur les données lues (CA-7) | `type:feature` `mod:copilot` `ws:qa` `P1` | `apps/web/tests/copilot/injection/` | P3-04 |
| P5-03 | `/design-audit` du chat sur les parcours public et back-office (CA-8) | `type:design` `mod:copilot` `ws:design` `P1` | — (ouvre des tickets `Design & UX`) | P3-04 |
| P5-04 | Registre des traitements : traitement « Assistant conversationnel » au §2, Anthropic au §5, retrait de l'assistant IA du §8 | `type:docs` `mod:copilot` `ws:backend` `P0` | `docs/registre-des-traitements.md` | P5-02 |
| P5-05 | Activation par salon (si le PO la retient, spéc. §12) et mise en production | `type:feature` `mod:copilot` `ws:devops` `P1` | à préciser | P5-04 |

**Sortie de phase** : tous les critères d'acceptation de la spécification (§10)
sont verts, et le registre décrit le traitement. **Rien ne part en production
avant P5-04.**

---

## Chemin critique

```
P0-01 → P1-01 (spike) → P1-04 → P1-07 → P2-01 → P2-05   ← premier parcours de bout en bout
          │                       ▲
          ├→ P1-02 → P1-05 ───────┘
          └→ P1-06 → P3-01 → P3-02 → P3-04 → P5-01/02 → P5-04 → P5-05
```

Le **spike P1-01** est le seul point qui peut remettre en cause l'architecture.
C'est pour cela qu'il passe en premier et qu'il est classé `P0`.

## Ce que chaque phase permet d'annoncer

| Phase | Annonce exacte |
|---|---|
| 0 | Cadrage du copilot IA : décision d'architecture, spécification, inventaire des écrans, plan |
| 1 | Socle du copilot : chat intégré aux couleurs du site, connecté à Claude, qui reconnaît la session et ne propose que ce que le rôle permet |
| 2 | Le copilot mène à la réservation : il trouve la prestation et les créneaux, et ouvre le tunnel déjà filtré |
| 3 | Le copilot gère les rendez-vous : report et annulation pour la cliente, journée du praticien, planning de la gérance, toujours avec confirmation |
| 4–5 | Encaissement, reporting et clients ; durcissement et mise en production |

Une release note n'annonce une phase que lorsque son critère de sortie est
vert. Les phases suivantes s'annoncent « en cours » ou « prévues ».
