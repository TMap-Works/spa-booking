# Spécification — Copilot IA

- **Version** : 0.1 (brouillon de cadrage) · 2026-10-08
- **Décision d'architecture** : [ADR 0018](../adr/0018-copilot-ia-dans-le-produit.md)
- **Références** : CDC §1.4, §2.3, §5.1 · [ADR 0013](../adr/0013-matrice-de-permissions-par-role.md)
  (permissions) · [ADR 0015](../adr/0015-carte-au-comptoir-par-tpe.md) (comptoir)
  · [ADR 0012](../adr/0012-operateur-plateforme-hors-tenant.md) (console)
- **Inventaire des écrans** : [inventaire.md](inventaire.md)
- **Plan** : [plan-implementation.md](plan-implementation.md)

---

## 1. Objet

Donner à chaque utilisateur du produit un assistant qui :

1. **répond** à ses questions sur le salon, ses prestations, ses propres données
   et l'usage du site, sans jamais en sortir ;
2. **propose** les actions utiles selon sa session et la page où il se trouve,
   la réservation et les rendez-vous d'abord ;
3. **agit** dans l'interface à sa place : il redirige, filtre, préremplit, et
   l'écran s'anime comme si l'utilisateur avait cliqué lui-même ;
4. **ne fait jamais rien** que l'utilisateur ne pourrait pas faire à la main.

## 2. Principes non négociables

| # | Principe | Ce qu'il interdit |
|---|---|---|
| P1 | **La session est héritée, jamais transmise.** Le jeton reste côté serveur. | Envoyer le jeton au modèle ou au navigateur ; laisser le modèle choisir l'identité. |
| P2 | **Le modèle n'autorise rien.** L'autorisation est celle de l'ADR 0013, revérifiée par l'API à chaque appel. | Une action exposée sans permission ; « je suis la gérante » qui ouvre quoi que ce soit. |
| P3 | **Les faits viennent des outils.** Prix, horaires, créneaux, rendez-vous, chiffres : toujours lus par une action. | Un prix ou un créneau « de mémoire ». |
| P4 | **Toute écriture est confirmée** par l'utilisateur dans le chat avant de partir. | Réserver, reporter, annuler, poser ou clôturer un rendez-vous sans clic de validation. |
| P5 | **Aucune donnée de carte** ne passe par le copilot (SAQ A). | Toute action de paiement : le copilot mène au parcours Stripe ou à l'écran d'encaissement, et s'arrête là. |
| P6 | **Une frontière de tenant ne se traverse pas**, ni dans une requête, ni dans un contexte, ni dans une conversation. | Une conversation qui survit à un changement de salon ; un contexte qui mêle deux salons. |
| P7 | **Ce qui n'est pas au registre n'existe pas** pour le modèle. | Le pilotage générique du DOM ; une action improvisée. |

## 3. Utilisateurs et surfaces

| Surface | Qui | Détectée par | Priorité | Ce que le copilot apporte |
|---|---|---|---|---|
| **Visiteur** | public, sur la vitrine ou le tunnel | aucun cookie de session valide pour ce salon | **P1** | Prestations, prix, créneaux libres, démarrer une réservation préremplie |
| **Client** | `CLIENT` | `GET /v1/auth/me` | **P1** | Réserver, voir ses rendez-vous, reporter, annuler, reprendre une prestation passée |
| **Praticien** | `STAFF` | `agenda:read:own` | **P1** | Sa journée, le prochain client, marquer honoré ou absent |
| **Gérance** | `MANAGER`, `ADMIN` | `agenda:read:all`, `appointment:write:all`, `checkout:collect`, `reporting:read`… | **P1** sur le planning et l'encaissement, **P2** ailleurs | Remplir les trous du planning, poser un rendez-vous, ouvrir le bon encaissement, lire le tableau de bord et le reporting |
| **Opérateur plateforme** | console `/plateforme` | hors tenant (ADR 0012) | — | **Pas de copilot en V1** |

## 4. Exigences fonctionnelles

### EF-1 — Converser sans sortir du contexte

- Le copilot répond sur : le salon (adresse, horaires, prestations, prix,
  politique d'annulation, politique de données), les données de l'utilisateur
  que sa session lui ouvre, et l'usage du site (« comment je reporte ? »).
- Tout autre sujet est **décliné en une phrase**, suivie d'une proposition de ce
  qu'il sait faire. Pas de sermon, pas d'explication de règles.
- Il répond **dans la langue de l'interface** (ADR 0017 : `fr` ou `en`).
- Il **ne devine pas** : quand un outil ne renvoie rien, il le dit.

### EF-2 — Proposer selon la session

- À l'ouverture du chat, **3 suggestions au plus**, calculées par le serveur à
  partir de la surface (§3) et de la page en cours. Elles ne sont pas générées
  par le modèle, ce qui les rend instantanées et gratuites.
- Ordre des suggestions : ce qui fait entrer le chiffre d'affaires d'abord
  (réserver, remplir un créneau libre, encaisser), puis le reste.
- Exemples :

| Surface et page | Suggestions |
|---|---|
| Visiteur, vitrine | « Réserver un soin » · « Quels sont vos créneaux demain ? » · « Vos tarifs » |
| Client, `/compte` | « Reprendre mon dernier soin » · « Reporter mon prochain rendez-vous » |
| Praticien, `/admin/mon-planning` | « Ma journée » · « Mon prochain client » |
| Gérance, `/admin/calendrier` | « Créneaux libres aujourd'hui » · « Poser un rendez-vous » · « Qui reste à encaisser ? » |

### EF-3 — Agir

Trois natures d'action, déclarées au registre (§6.3) :

| Nature | S'exécute | Exemple | Confirmation |
|---|---|---|---|
| **Navigation** | navigateur | ouvrir le tunnel filtré sur « massage », demain après-midi | non |
| **Lecture** | serveur, via l'API, avec le jeton | lister les créneaux libres ; « mes rendez-vous » | non |
| **Écriture** | serveur, via l'API, avec le jeton | reporter, annuler, poser un rendez-vous, marquer honoré | **oui** (P4) : une carte dans le chat récapitule l'action, l'utilisateur valide ou refuse |

Une écriture refusée par l'API (409 créneau pris, 403, 404) est **restituée en
clair** et suivie d'une alternative. Pour un 409 par exemple : « Ce créneau
vient d'être pris, voici les deux plus proches ».

### EF-4 — L'écran s'anime

- Une action de navigation change **l'état de la page** (URL, filtres). C'est la
  page qui s'anime, avec les **mêmes transitions** qu'au clic : un filtre posé
  par le chat et un filtre posé à la main sont indiscernables.
- Les listes filtrées (praticiens, créneaux, rendez-vous) gagnent une animation
  d'entrée et de sortie et de réorganisation.
- **Bonus, phase 4 :** un « curseur fantôme » montre l'élément visé avant d'agir.
- Toute animation respecte `prefers-reduced-motion`.

### EF-5 — Suivre le design du site

- Le chat est stylé avec les **jetons du design system** existant (couleurs,
  rayons, typographie, thème clair et sombre), jamais avec le thème par défaut
  de CopilotKit.
- Il est en panneau latéral sur le back-office et en bulle sur le parcours
  public. À 360 px, il passe en plein écran.
- Accessibilité : rôle `log` et `aria-live` sur le fil, focus géré à
  l'ouverture et à la fermeture, tout est utilisable au clavier.

## 5. Détection de la session

**À chaque message**, côté serveur, dans `app/api/copilotkit` :

1. **Lire les cookies `httpOnly`** et renouveler le jeton s'il a expiré, avec
   les helpers existants (`lib/session-refresh.ts`, sur le modèle de
   `lib/appointment-feed-relay.ts`).
2. **Identifier** l'utilisateur par `GET /v1/auth/me`, qui rend le compte, son
   rôle, son salon et **ses permissions effectives**. Cette route est limitée à
   60 appels par minute **par compte**, et le back-office l'appelle à chaque
   rendu : la réponse est mise en **cache 30 s**, avec pour clé une empreinte du
   jeton, jamais le jeton lui-même.
3. **Recouper** le salon du jeton avec celui de l'URL (en-tête
   `x-spa-tenant-slug` posé par le middleware). S'ils diffèrent, la requête est
   traitée en **visiteur** de ce salon.
4. **Construire le contexte de session** :
   ```ts
   type CopilotSession = {
     surface: 'visiteur' | 'client' | 'praticien' | 'gerance';
     permissions: readonly Permission[]; // ADR 0013, vide pour un visiteur
     tenant: { slug: string; timezone: string; currency: string };
     locale: 'fr' | 'en';
   };
   ```
5. **Filtrer le registre** (§6.3) selon les permissions : seules les actions
   permises sont décrites au modèle.
6. **Ne rien garder en mémoire d'un message à l'autre.** Déconnexion, changement
   de rôle ou expiration valent dès le message suivant. Un 401 fait répondre
   « Votre session a expiré », avec le lien de reconnexion de la surface.

Le **contexte de page** (route, filtres en cours, élément sélectionné) est
fourni par le front avec `useCopilotReadable`. Il est **indicatif** : il sert à
la pertinence des réponses, jamais à l'autorisation.

**Isolation des conversations** : une conversation est liée au couple
(utilisateur, salon). Elle est vidée à la déconnexion et au changement de salon.
Celles des visiteurs ne sont pas conservées.

## 6. Architecture technique

### 6.1 Vue d'ensemble

```
Navigateur
  <CopilotKit runtimeUrl="/api/copilotkit">  — panneau ou bulle, jetons du DS
  useCopilotReadable(page, filtres)           — contexte indicatif
  useCopilotAction(navigation…)               — actions front : router.push, filtres
        │ même origine → cookies httpOnly
        ▼
Next.js  app/api/copilotkit/route.ts
  1. session (§5)  2. registre filtré  3. étage 0 · 1 · 2 (§6.2.1)
        │                                   │
        │ Bearer <jeton>                    │ @anthropic-ai/sdk
        ▼                                   ▼
API NestJS (inchangée en V1)            Claude Haiku 5.5 (Sonnet 5.5 par agent)
  gardes ADR 0013 + scoping tenant
```

### 6.2 Agents : des spécialistes exposés comme outils

Le copilot suit la philosophie de MCP : **l'orchestrateur ne sait rien faire
lui-même**. Il voit des outils, décide lequel appeler, et chaque spécialiste est
**un de ces outils**, comme un serveur MCP expose les siens à un client.
Ajouter un domaine revient à déclarer un outil de plus, sans toucher aux autres.

L'unité de découpage est le **domaine**, pas la page : un agent par
fonctionnalité en ferait plus de cinquante.

| Agent | Exposé à l'orchestrateur comme | Modules CDC | Ses outils (cf. inventaire) | Phase |
|---|---|---|---|---|
| **Orchestrateur** | — | — | les agents ci-dessous, et les lectures directes (§6.2.2) | 1 |
| **Réservation** | `agent_reservation(brief)` | catalog, availability | `catalogue.chercher`, `disponibilite.creneaux`, `reservation.ouvrir_tunnel` | 2 |
| **Guide** | `agent_guide(brief)` | — | `guide.mener`, `salon.politique_donnees` | 2 |
| **Rendez-vous et planning** | `agent_rendez_vous(brief)` | appointments | `rendez_vous.*`, `planning.*` | 3 |
| **Clients** | `agent_clients(brief)` | crm | `clients.*` | 4 |
| **Encaissement et reporting** | `agent_encaissement(brief)` | payments, reporting | `encaissement.*`, `tableau_de_bord.*`, `reporting.*` | 4 |

**Le filtrage par permissions s'applique aux deux niveaux.** Un agent dont aucun
outil n'est permis à la session n'est pas exposé à l'orchestrateur : un
praticien ne voit pas `agent_encaissement`. Un agent exposé ne reçoit que ses
outils permis.

#### 6.2.1 Trois étages, du moins cher au plus cher

Chaque message est servi par **l'étage le plus bas qui suffit**.

| Étage | Appels au modèle | Quand | Exemples |
|---|---|---|---|
| **0 — Sans modèle** | **0** | L'utilisateur clique une suggestion (EF-2), un bouton d'une carte (valider, refuser, voir plus) ou un lien rendu par le chat | « Réserver un soin » ouvre le tunnel ; « Valider » envoie le report |
| **1 — Orchestrateur seul** | **1** | Question simple que couvre une lecture directe, ou hors-sujet à décliner | « Vos horaires ? », « Combien coûte un soin visage ? » |
| **2 — Orchestrateur, puis spécialiste** | **2** | Plusieurs lectures enchaînées, une navigation filtrée, toute écriture | « Un massage demain après-midi avec Léa », « Reporte mon rendez-vous à jeudi » |

Une suggestion ou un bouton porte **l'action et ses paramètres** : son clic
appelle l'action directement, sans passer par le modèle. C'est l'étage le plus
fréquent sur un parcours guidé, et il ne coûte rien.

#### 6.2.2 Lectures directes de l'orchestrateur

Pour éviter un second appel sur les questions triviales, l'orchestrateur porte
lui-même **trois lectures publiques et bon marché** : `salon.infos`,
`catalogue.chercher` et `guide.mener`. Tout le reste passe par un spécialiste.
La liste est volontairement courte : chaque outil ajouté allonge le prompt de
tous les messages.

#### 6.2.3 Le contrat d'un spécialiste

**L'appel.** L'orchestrateur transmet un **brief**, jamais la conversation :

```ts
type SpecialistBrief = {
  demande: string;              // la demande, reformulée et complète
  faits: Record<string, string>; // ce qui est déjà établi : { jour: '2026-10-09', prestation: '…' }
};
```

Les dates relatives (« demain », « jeudi ») sont **résolues en dates** dans le
fuseau du salon avant le brief (ADR 0006). Le spécialiste n'a pas à deviner.

**Le retour.** Un résultat structuré, validé par un schéma Zod, sans texte libre
autour :

```ts
type SpecialistResult = {
  reponse: string;                      // ce que lit l'utilisateur, déjà rédigé
  actions_front: FrontAction[];         // navigations à exécuter dans le navigateur
  confirmation: PendingWrite | null;    // écriture préparée, en attente du clic (P4)
  suggestions: SuggestedAction[];       // prochains pas, cliquables (étage 0)
};
```

- **Le spécialiste ne navigue pas lui-même.** Il tourne côté serveur et ne voit
  pas l'écran : il **demande** la navigation dans `actions_front`, et CopilotKit
  l'exécute dans la page, qui s'anime (EF-4).
- **Il n'écrit pas lui-même.** Une écriture revient en `confirmation`, affichée
  comme carte. Le clic « Valider » l'exécute à l'étage 0, sans repasser par le
  modèle. L'écriture préparée est **gardée côté serveur** (Redis, quelques
  minutes), sous un identifiant lié à l'utilisateur et au salon. Le clic n'envoie
  que cet identifiant : le navigateur ne peut pas modifier ce qui a été affiché,
  et l'écriture part avec le jeton de la session courante, que l'API revérifie
  (P2).
- **Il est sans mémoire.** Chaque appel part du brief seul. Il n'a pas
  d'historique, donc rien à resservir ni à réécrire d'un tour à l'autre.

**Le passe-plat.** La `reponse` du spécialiste est **affichée telle quelle**.
L'orchestrateur ne la reformule pas, ce qui évite un troisième appel. Son tour
s'arrête sur l'appel d'outil. Le résultat de l'outil et le message suivant de
l'utilisateur partent ensemble dans le même message du tour suivant :
l'historique reste en ajout seul, comme l'exige Claude (§6.4).

#### 6.2.4 Un spécialiste exposé comme outil n'est pas un serveur MCP

Le registre adopte la forme de MCP (catalogue découvrable, contrats typés,
outils par domaine), **pas son transport**. Un vrai serveur MCP compliquerait
le passage du jeton de session sans rien apporter au chat, et ne peut de toute
façon pas agir dans le navigateur. Comme le registre est décrit en Zod, il
pourra être exposé plus tard comme un vrai serveur MCP, par exemple pour qu'une
gérante pilote son salon depuis un client MCP. C'est une piste post-V1 (§11).

### 6.3 Le registre d'actions

La source de vérité du code et de l'inventaire est
`packages/shared/src/copilot/actions.ts` :

```ts
export const COPILOT_ACTIONS = {
  'reservation.ouvrir_tunnel': {
    domaine: 'reservation',
    nature: 'navigation',
    exige: 'public',                       // 'public' | 'session' | Permission (ADR 0013)
    description: 'Ouvre le tunnel de réservation, préfiltré.',
    // Les clés sont celles de l'adresse du tunnel (lib/booking/draft.ts) ;
    // `jour` et `plage` n'existent pas encore : ticket P2-02.
    parametres: z.object({
      prestation: z.string().optional(),   // ?prestation=<id>
      praticien: z.string().optional(),    // ?praticien=<id>
      jour: z.string().date().optional(),  // ?jour=AAAA-MM-JJ, fuseau du salon
      plage: z.enum(['matin', 'apres-midi', 'soir']).optional(),
    }),
    confirmation: false,
  },
  'rendez_vous.reporter': {
    domaine: 'rendez_vous',
    nature: 'ecriture',
    exige: 'session',                      // la cliente, sur ses propres rendez-vous
    confirmation: true,
    // …
  },
} as const satisfies Record<string, CopilotActionDefinition>;
```

- Le schéma Zod valide **l'appel du modèle** avant toute exécution (ADR 0008).
- Un test vérifie que chaque action porte un `exige` valide, et que chaque
  écriture a `confirmation: true`.
- L'inventaire liste les actions par écran avec ces mêmes identifiants.

### 6.4 Claude

| Réglage | Valeur | Raison |
|---|---|---|
| Accès | SDK officiel `@anthropic-ai/sdk` | Pas de shim tiers |
| Clé | Secrets Manager (déployé), `.env.local` (local) | Règle « aucun secret » |
| Modèle par défaut | **`claude-haiku-5-5`** | Décision du PO (2026-10-08) : un chat doit être rapide et peu coûteux ; la plupart des tours sont une lecture ou une navigation |
| Modèle d'appoint | **`claude-sonnet-5-5`**, par agent et sur mesure | Pour les agents dont le jeu d'évaluation montre que Haiku ne suffit pas (§6.4.1) |
| Choix du modèle | **par agent**, en configuration (`COPILOT_MODEL_<AGENT>`), jamais en dur | Changer un modèle ne doit pas demander de code |
| Effort | `low` pour la conversation, `medium` pour composer une action en plusieurs étapes, toujours **explicite** | Haiku 5.5 est à `medium` par défaut, Sonnet 5.5 à `high` |
| Réflexion | adaptative | Désactivable sur Haiku 5.5 (effort `high` ou moins) ; sur Sonnet 5.5, seul `between_tools` la coupe |
| Streaming | oui | Affichage progressif |
| Choix d'outil | `auto` uniquement, avec `strict: true` sur les outils | Le `tool_choice` forcé renvoie une erreur 400 sur Sonnet 5.5 ; on ne s'en sert pas non plus sur Haiku, pour pouvoir changer de modèle sans changer de code |
| Historique | renvoyé **tel quel**, blocs de réflexion compris, sans réécriture | Preserved thinking ; un bloc ne se relit que sur le modèle qui l'a produit |
| Cache de prompt | prompt système et outils stables en tête, contexte de page en fin | Coût ; un cache par modèle et par surface |
| Refus | `stop_reason: "refusal"` traité ; message neutre à l'écran | Haiku 5.5 n'a pas de repli côté serveur : on peut rejouer le tour sur Sonnet 5.5 (`fallbacks: "default"` côté Sonnet) |

Les cinq dernières lignes sont **à valider dans le spike P1-01**, avec
l'adaptateur Anthropic de CopilotKit et **sur les deux modèles**. Si
l'adaptateur force un outil ou réécrit l'historique, l'agent passe par une
boucle maison sur le SDK officiel, exposée à CopilotKit par AG-UI (ADR 0018).

#### 6.4.1 Répartition de départ

| Agent | Modèle de départ | Pourquoi |
|---|---|---|
| Orchestrateur | Haiku 5.5 | Classer l'intention et passer la main |
| Réservation | Haiku 5.5 | Lectures et une navigation |
| Guide | Haiku 5.5 | Mener à une route connue |
| Rendez-vous | Haiku 5.5, **Sonnet 5.5 si l'évaluation l'exige** | Les écritures (poser, reporter) enchaînent plusieurs lectures avant de proposer |
| Clients, Encaissement et reporting | Haiku 5.5 | Lectures et résumés |

**Une montée de Haiku à Sonnet se décide sur mesure**, jamais par principe. Le
jeu d'évaluation (P5-01, avancé au besoin en phase 3) compare les deux modèles
sur les tâches de l'agent. On monte quand Haiku échoue sur le choix d'action
ou sur les paramètres d'une écriture. Coût indicatif par million de tokens
(entrée / sortie) : Haiku 5.5 à 0,10 $ / 0,50 $, Sonnet 5.5 à 2 $ / 10 $.

### 6.5 Fichiers

| Où | Quoi |
|---|---|
| `packages/shared/src/copilot/` | registre d'actions, types de session, schémas |
| `apps/web/app/api/copilotkit/route.ts` | runtime, session, filtrage, agents |
| `apps/web/lib/copilot/` | session (§5), suggestions (EF-2), exécution des actions serveur |
| `apps/web/components/copilot/` | panneau, bulle, cartes de confirmation, curseur fantôme |
| `apps/web/messages/{fr,en}/copilot.json` | libellés, par convention (ADR 0017) |

**L'API NestJS n'est pas modifiée en V1.** Le copilot n'utilise que des
endpoints existants. S'il en manque un, c'est un ticket du module concerné, pas
un raccourci.

## 7. Sécurité

| Menace | Parade |
|---|---|
| **Injection de prompt** par une donnée lue (note client, nom de prestation, message) | Les résultats d'outils sont balisés comme données ; aucune écriture sans confirmation (P4) ; campagne d'injection en phase 5 |
| **Élévation de privilège** (« je suis admin ») | Actions filtrées par `GET /v1/auth/me` ; API revérifie (P2) |
| **Fuite entre salons** | Recoupement jeton/URL (§5.3) ; conversation liée au salon ; tests de fuite sur chaque action (skill tenant-isolation) |
| **Fuite du jeton** | Jamais hors de la route serveur (P1) ; jamais journalisé |
| **Abus et coût** | Quotas Redis par utilisateur, par visiteur (IP + salon) et par salon ; taille de message bornée ; nombre d'appels d'outils par tour borné |
| **Données de carte** | Aucune action de paiement (P5) |

## 8. Données personnelles

- **Anthropic devient sous-traitant ultérieur** : il rejoint le §5 du
  [registre des traitements](../registre-des-traitements.md), et le traitement
  « Assistant conversationnel » entre au §2 **dans le ticket de mise en
  production** (le registre décrit ce qui existe, son §8 annonce déjà
  l'assistant IA).
- **Minimisation** : le contexte transmis au modèle ne contient ni note interne,
  ni coordonnées d'un client, sauf quand l'action en cours les exige.
- **Conservation** : les conversations ne sont pas stockées en V1. Si elles le
  deviennent, ce sera par un module API dédié, avec une durée déclarée au
  registre.
- **Transparence** : le chat se présente comme un assistant IA dès le premier
  message et renvoie à la politique de données du salon.

## 9. Coût et observabilité

### 9.1 Les leviers, dans l'ordre où ils jouent

| # | Levier | Effet |
|---|---|---|
| 1 | **Étage 0** : suggestions et boutons appellent l'action sans modèle (§6.2.1) | 0 appel sur les gestes guidés |
| 2 | **Étage 1** : lectures directes de l'orchestrateur (§6.2.2) | 1 appel au lieu de 2 sur les questions simples |
| 3 | **Passe-plat** : la réponse du spécialiste n'est pas reformulée (§6.2.3) | 2 appels au lieu de 3 à l'étage 2 |
| 4 | **Haiku 5.5 partout** au départ ; Sonnet 5.5 seulement là où l'évaluation l'exige (§6.4.1) | ~20 fois moins cher que Sonnet |
| 5 | **Cache de prompt** : prompt système et outils en tête, triés de façon déterministe ; rien de variable avant le dernier point de cache (pas d'heure, pas d'identifiant) | Le préfixe stable est relu en cache à chaque message |
| 6 | **Spécialistes sans mémoire** : un brief, pas l'historique | Entrée courte et constante |
| 7 | **Effort `low`** sur la conversation, `medium` seulement sur les écritures du spécialiste Rendez-vous | Moins de tokens de réflexion, facturés comme de la sortie |
| 8 | **Sorties courtes** : réponse de 2 à 4 phrases, résultat structuré du spécialiste, plafond de sortie par agent fixé sur mesure | Moins de tokens de sortie |
| 9 | **Conversations bornées** : au-delà d'un nombre de tours (fixé en phase 1), le chat propose d'en commencer une nouvelle ; l'historique n'est jamais tronqué en douce | Entrée bornée, historique valide |
| 10 | **Cache applicatif des lectures publiques** (catalogue, infos du salon) dans Redis, quelques minutes | Moins de charge sur l'API |
| 11 | **Quotas** par utilisateur, par visiteur et par salon (§7) | Plafond de dépense |

L'**ordre de grandeur** se mesure en phase 1, et ne s'estime pas ici. La règle
de lecture est le **coût par tâche réussie**, pas par appel : un appel moins
cher qui demande deux relances ne l'est pas.

### 9.2 Ce qu'on mesure

- **Traces OpenTelemetry** (`instrumentation.ts`) : latence par tour, par étage,
  par agent et par action ; taux d'erreur par action.
- **Compteurs de tokens** : entrée, sortie, écrits et lus en cache, par agent,
  par modèle, par salon et par surface. Ils fondent toute décision de modèle ou
  d'effort.
- **Répartition par étage** : la part de messages servis aux étages 0, 1 et 2.
  Une part de l'étage 2 qui grimpe signale des suggestions mal ciblées.
- **Jamais journalisés** : le jeton, le contenu des messages en production.

## 10. Critères d'acceptation de la V1

| # | Critère | Comment on le prouve |
|---|---|---|
| CA-1 | Un visiteur qui écrit « je veux un massage demain après-midi » arrive sur le tunnel, filtré, et la liste s'anime | E2E Playwright avec un modèle simulé |
| CA-2 | Une cliente reporte un rendez-vous depuis le chat, **après** confirmation | E2E + test d'intégration |
| CA-3 | Un praticien ne voit pas d'action `agenda:read:all` ; une demande en ce sens est déclinée | Test unitaire du filtrage + recette |
| CA-4 | Aucune action n'atteint un autre salon | Tests de fuite par action |
| CA-5 | Le jeton n'apparaît dans aucune requête vers Claude ni aucune trace | Test sur la requête construite |
| CA-6 | Le hors-sujet est décliné en une phrase, avec une proposition | Jeu d'évaluation |
| CA-7 | Zéro écriture sans confirmation sur le jeu d'injection | Campagne de phase 5 |
| CA-8 | Le chat suit le design du site, clair et sombre, et tient à 360 px | `/design-audit` sur le parcours |

Les tests suivent ceux du dépôt : unitaires, intégration et E2E, **plus** la
recette fonctionnelle de chaque ticket (ADR 0005). Le modèle est **simulé** en
CI : aucun test ne dépend d'un appel réel à Claude. Le jeu d'évaluation, lui,
appelle Claude et se lance à la demande.

## 11. Hors V1

Console plateforme · actions sur les comptes et les rôles · réglages et
abonnement · écriture dans le catalogue et le fichier client · paiement ·
conservation des conversations · exposition du registre comme vrai serveur MCP (§6.2.4) · voix · SMS et e-mail par l'assistant
(« réceptionniste IA » du CDC).

## 12. Questions ouvertes

| Question | Qui tranche | Quand |
|---|---|---|
| Adaptateur Anthropic de CopilotKit ou boucle maison sur le SDK, exposée en AG-UI | spike P1-01 | phase 1 |
| Quels agents montent de Haiku 5.5 à Sonnet 5.5 ? | PO, sur le jeu d'évaluation (§6.4.1) | phase 3 |
| Le copilot est-il offert à tous les salons ou activable par salon ? | PO | avant la mise en production |
| Quels quotas par salon ? | PO | phase 1 |
