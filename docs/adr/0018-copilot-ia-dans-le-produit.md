# ADR 0018 — Copilot IA dans le produit : CopilotKit, session héritée, agents par domaine

- **Statut** : Accepté
- **Date** : 2026-10-08
- **Décideurs** : PO, équipe produit
- **Contexte CDC** : §1.4 (périmètre MVP — « assistant de messagerie IA » hors
  périmètre), §2.3 (découpage en modules), §5.1 (données personnelles) ·
  [ADR 0013](0013-matrice-de-permissions-par-role.md) (permissions par rôle) ·
  spécification : [docs/copilot/specification.md](../copilot/specification.md)

## Contexte

Le CDC classe l'assistant IA **hors du périmètre MVP** (§1.4) et le renvoie « en
phase ultérieure ». Le PO ouvre ce chantier le 2026-10-08 : un chat intégré au
produit, branché sur un LLM, qui répond aux questions de l'utilisateur sur le
salon et le site, lui propose les actions utiles selon sa session, et **agit
dans l'interface** à sa place (rediriger, filtrer, préremplir), avec en priorité
la réservation et les rendez-vous, c'est-à-dire ce qui fait entrer le chiffre
d'affaires.

Ce chantier **n'élargit pas le MVP**. Il s'ouvre à côté, dans son propre jalon,
et ne doit rien retirer aux garanties existantes. Quatre contraintes le cadrent,
et aucune n'est négociable :

1. **Aucune frontière de tenant ne peut être traversée**, ni par une requête, ni
   par ce que le modèle lit ou écrit (contrainte n°2 du CLAUDE.md).
2. **Le modèle n'est pas une source d'autorisation.** Une phrase du type « je suis
   la gérante » dans le chat ne doit rien ouvrir. L'autorisation reste celle de
   l'ADR 0013, vérifiée par l'API.
3. **Aucune donnée de carte ne transite par le copilot** (SAQ A, contrainte n°3).
   Le paiement reste le parcours Stripe existant.
4. **La session vit dans deux cookies `httpOnly`** (`lib/session-refresh.ts`). Le
   JavaScript du navigateur ne peut pas les lire, et le jeton ne doit pas sortir
   du serveur.

## Options envisagées

### Option A — Piloter le navigateur de l'extérieur (Playwright, computer-use)

Un agent ouvre un navigateur sans tête, lit le DOM et clique.

- Il ne voit pas l'écran de l'utilisateur. L'utilisateur ne voit donc rien
  s'animer, alors que c'est l'effet recherché.
- Il faut un navigateur serveur par conversation : c'est lent, coûteux, et la
  session doit lui être confiée, ce qui contredit la contrainte 4.
- Il est fragile au moindre changement de libellé ou de mise en page.

**Écartée.** Playwright reste l'outil de test et de recette (ADR 0005). Il servira
à tester le copilot, pas à le faire fonctionner.

### Option B — CopilotKit, actions déclarées par l'application

L'application **déclare** au modèle ce qu'il peut lire (`useCopilotReadable`) et
ce qu'il peut faire (actions front et actions serveur). Le runtime tourne dans
une route Next.js de même origine.

- Les actions front s'exécutent dans le navigateur de l'utilisateur et changent
  l'état de la page : l'écran s'anime réellement, avec les mêmes transitions
  qu'au clic.
- Les actions serveur appellent l'API avec le jeton lu côté serveur, sur le
  modèle de `lib/appointment-feed-relay.ts`. Les gardes de l'ADR 0013 et le
  scoping tenant s'appliquent d'office.
- Il faut déclarer chaque capacité une par une. C'est plus de travail qu'un
  pilotage générique, mais c'est ce qui rend le comportement prévisible et
  testable.

### Option C — Chat développé à la main

On contrôle tout, mais il faut réécrire le streaming, l'appel d'outils, l'UI
générative et l'attente d'une confirmation humaine, que CopilotKit fournit déjà.
**Écartée** pour le coût, sans gain sur les contraintes.

### Sous-option — un agent unique ou des agents spécialisés

Un agent par **page** ou par **fonctionnalité** produirait plusieurs dizaines
d'agents, chacun ajoutant un appel au modèle et une frontière à maintenir.
Un agent unique qui porterait toutes les actions verrait sa précision baisser
avec le nombre d'outils exposés. Le compromis retenu : **un orchestrateur et des
spécialistes par domaine métier**, calqués sur les modules du CDC §2.3.

Restait à dire comment l'orchestrateur passe la main. Deux formes ont été
pesées :

- **un vrai serveur MCP par domaine**. C'est un protocole standard, mais il faut
  y faire passer le jeton de session, il ajoute un transport, et un serveur MCP
  ne peut de toute façon pas agir dans le navigateur de l'utilisateur ;
- **la philosophie de MCP sans son transport** : chaque spécialiste est un
  **outil** de l'orchestrateur, décrit dans le registre typé, et rend un
  résultat structuré. C'est cette forme qui est retenue. Le registre étant
  décrit en Zod, il pourra être exposé plus tard comme un vrai serveur MCP.

## Décision

1. **CopilotKit (option B) côté interface, Claude côté modèle.** Le runtime vit
   dans une route serveur Next.js `app/api/copilotkit`. Le modèle est **Claude,
   appelé par le SDK officiel `@anthropic-ai/sdk`**, avec la clé API Anthropic
   rangée dans AWS Secrets Manager en déployé et dans `.env.local` en local,
   jamais dans le code (règle « aucun secret » du CLAUDE.md). **Le modèle par
   défaut est `claude-haiku-5-5`**, rapide et peu coûteux, adapté à un chat dont
   la plupart des tours sont une lecture ou une navigation.
   **`claude-sonnet-5-5` sert d'appoint**, agent par agent, quand le jeu
   d'évaluation montre que Haiku ne suffit pas. Le modèle se règle par agent, en
   configuration, et l'effort est toujours explicite. Le passage par
   l'adaptateur Anthropic de CopilotKit ou par un agent maison exposé en AG-UI se
   tranche dans le spike P1-01 (voir « Conséquences »).
2. **La session est héritée, jamais transmise.** La route lit le cookie d'accès
   côté serveur et le renouvelle comme le font les actions existantes. Le jeton
   n'est jamais envoyé au modèle ni au navigateur.
3. **Les actions disponibles sont filtrées par les permissions de l'ADR 0013.**
   Chaque action du catalogue déclare la permission qu'elle exige, et la route
   n'expose au modèle que celles que l'utilisateur connecté possède. L'API
   revérifie à chaque appel.
4. **Toute écriture est confirmée par l'utilisateur** (human-in-the-loop) :
   réserver, reporter, annuler, poser un rendez-vous, marquer honoré. Le modèle
   prépare, l'utilisateur valide.
5. **Le catalogue d'actions est un registre typé** dans `packages/shared`. Il sert
   à la fois de source de vérité pour le code et pour la documentation, et un
   test vérifie que chaque action porte une permission de l'ADR 0013.
6. **Architecture d'agents, sur le modèle de MCP** : un orchestrateur qui ne
   sait rien faire lui-même, et des spécialistes par domaine (Réservation,
   Rendez-vous et planning, Clients, Encaissement et reporting, Guide du site)
   que l'orchestrateur **appelle comme des outils**. Un spécialiste reçoit un
   brief, jamais la conversation. Il rend un résultat structuré : la réponse
   déjà rédigée, les navigations à exécuter dans le navigateur, et l'écriture
   éventuelle à faire confirmer. Il ne navigue pas et n'écrit pas lui-même. La
   V1 livre l'orchestrateur avec les spécialistes Réservation et Guide, et les
   autres suivent dans l'ordre de priorité de la spécification.
7. **Le moindre coût est une règle d'architecture**, pas un réglage. Chaque
   message est servi par l'étage le plus bas qui suffit :
   - **étage 0, sans modèle** : suggestions, boutons et confirmations appellent
     l'action directement ;
   - **étage 1, un appel** : l'orchestrateur répond seul, avec trois lectures
     directes ;
   - **étage 2, deux appels** : l'orchestrateur, puis un spécialiste.

   La réponse du spécialiste est affichée telle quelle, sans troisième appel
   pour la reformuler. Détail et leviers : spécification §6.2 et §9.
8. **Le copilot ne sort pas du contexte du site.** Il répond sur le salon, ses
   prestations, les données de l'utilisateur et l'usage du produit. Les faits
   (prix, horaires, créneaux) viennent **des outils**, jamais de la mémoire du
   modèle. Le reste est décliné poliment, avec une redirection.

## Conséquences

- **Ce que cela facilite.** Aucun nouveau mécanisme d'accès : le copilot ne peut
  rien faire que l'utilisateur ne puisse faire à la main. Les animations du
  front servent au clic comme au chat.
- **Ce que cela coûte.** Chaque capacité doit être déclarée, testée et recettée.
  Un coût LLM variable apparaît : il faut des quotas par tenant et par
  utilisateur, et un suivi.
- **Données personnelles.** Le fournisseur LLM devient un **sous-traitant
  ultérieur** au sens du RGPD : Anthropic rejoint AWS et Stripe au §5 du
  [registre des traitements](../registre-des-traitements.md). Ce registre décrit
  ce que le système fait et non ce qu'il fera : l'« assistant IA » figure déjà
  dans son §8, parmi ce qu'il reste à couvrir. Le traitement « Assistant
  conversationnel » (finalité, données, durée de conservation des conversations,
  résidence) y entre **dans le ticket qui le met en production**, pas avant. On minimise ce qu'on transmet : pas de note interne, pas de
  coordonnées d'un client dans le contexte sauf si l'action l'exige.
- **Nouvelle surface d'attaque : l'injection de prompt.** Une note client ou un
  nom de prestation peut contenir des instructions. Les données lues par les
  outils sont traitées comme des données, la confirmation humaine protège les
  écritures, et une campagne d'injection fait partie des critères de sortie.
- **Ce que cela ferme.** Pas de pilotage générique du DOM et pas d'action non
  cataloguée. Une capacité absente du registre n'existe pas pour le modèle.
- **Contraintes propres à Claude, à vérifier dans le spike P1-01 sur les deux
  modèles.** Sur `claude-sonnet-5-5`, le choix d'outil forcé (`tool_choice`
  `any`/`tool`) renvoie une erreur 400, et on ne s'en sert donc nulle part :
  changer de modèle ne doit pas demander de code. Les blocs de réflexion doivent
  être renvoyés **tels quels** d'un tour à l'autre, et un historique réécrit peut
  être refusé (preserved thinking). Un bloc ne se relit que sur le modèle qui l'a
  produit : passer une conversation de Haiku à Sonnet en cours de route coûte la
  réflexion des tours précédents, ce qui plaide pour un modèle fixe **par
  agent** plutôt que par message. Si l'adaptateur de
  CopilotKit force un outil ou réécrit l'historique, l'agent passe par une
  boucle maison sur le SDK officiel, exposée à CopilotKit par le protocole AG-UI.
  C'est l'option de repli, et c'est le spike qui la déclenche ou non.
- **Résultat du spike P1-01 (2026-10-08).** L'option de repli est **retenue** :
  l'`AnthropicAdapter` (API v1 de CopilotKit, dépréciée) tronque l'historique,
  ne rend pas les blocs de réflexion, peut forcer un outil et ne règle pas
  l'effort. Le copilot passe par le **runtime v2** de CopilotKit et un agent
  maison sur `@anthropic-ai/sdk`, exposé en AG-UI
  (`apps/web/lib/copilot/claude-agent.ts`), qui garde l'historique côté
  serveur en ajout seul. Vérifié de bout en bout sur `claude-haiku-5-5` :
  streaming, appel d'un outil du navigateur sans `tool_choice` forcé (la page
  se filtre sous les yeux de l'utilisateur), conversation sur plusieurs tours,
  refus de prétendre à une action dont il n'a pas l'outil. Les règles
  d'historique, d'effort et de refus sont couvertes par des tests sans réseau.
  **Sonnet 5.5 n'a pas été essayé** : le PO retient Haiku, et la comparaison
  par agent reste celle du jeu d'évaluation P5-01.
- **Dépendances.** CopilotKit apporte environ 690 paquets et 19 alertes
  `npm audit` (6 `high`). Versions épinglées, installation faite avec
  `--before` à deux semaines, et `@ag-ui/mcp-apps-middleware` forcé en 0.1.1
  par `overrides` : la 0.1.2, publiée le jour même, cassait le runtime.
- **Refus du modèle.** Une réponse `stop_reason: "refusal"` est un cas prévu, et
  l'écran affiche un message neutre, jamais une erreur technique. Haiku 5.5 n'a
  pas de repli côté serveur : le tour peut être rejoué sur Sonnet 5.5, qui
  accepte `fallbacks: "default"`.
- **Périmètre.** Ce chantier vit dans le jalon `Copilot IA` (`nature:projet`) et
  n'entre pas dans le calcul de la Definition of Done du MVP.
