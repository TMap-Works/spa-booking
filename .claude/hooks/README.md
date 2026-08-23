# Traçabilité des demandes

Chaque demande faite à Claude Code sur ce projet ouvre automatiquement un ticket
GitHub, refermé en fin de tour avec le résumé de ce qui a réellement été produit.
L'objectif est d'avoir dans GitHub l'historique complet de ce qui a été demandé,
et pas seulement de ce qui a été commité.

## Fonctionnement

| Hook | Script | Effet |
|---|---|---|
| `UserPromptSubmit` | `request_open.py` | Crée l'issue (label `tracking`), enregistre le commit de départ, injecte le numéro dans le contexte de Claude |
| `Stop` | `request_close.py` | Commente les commits, le diffstat et le travail non commité, puis clôture l'issue |

Le numéro étant injecté dans le contexte, Claude ajoute `Refs #N` à ses commits :
le ticket et le code se retrouvent liés dans les deux sens.

L'état de la session vit dans `.claude/.tracking/<session>.json`, non versionné.

## Ce qui n'ouvre pas de ticket

Un historique noyé sous des tickets « ok » ne documente rien. Sont ignorés :

- les commandes slash (`/feature-start`, `/pr-open`…) — elles portent déjà leur
  propre traçabilité via l'issue du backlog ;
- les relances triviales : `ok`, `continue`, `vas-y`, `merci`, `refais`, etc. ;
- les prompts de moins de 30 caractères.

Le travail déclenché par une relance est de toute façon capturé : il apparaît
dans le résumé du ticket ouvert par la demande initiale, tant que la session
n'a pas produit de `Stop` intermédiaire.

## Réglages

| Variable | Effet |
|---|---|
| `SPA_TRACKING=off` | Désactive complètement la traçabilité |
| `SPA_TRACKING_MIN_CHARS` | Seuil de longueur (défaut : 30) |
| `SPA_TRACKING_REPO` | Dépôt cible (défaut : `TMap-Works/spa-booking`) |

Pour désactiver durablement sans toucher au dépôt, retirer les blocs
`UserPromptSubmit` et `Stop` de `.claude/settings.local.json`, ou passer par
`/hooks`.

## Garanties

- **Aucun blocage.** Si `gh` est absent, non authentifié ou hors ligne, le hook
  sort silencieusement. La traçabilité ne doit jamais empêcher le travail.
- **Pas de pollution du board.** Les tickets `tracking` n'ont pas de milestone
  et sont explicitement exclus de `project-automation.yml`.
- **Encodage.** stdin et stdout sont lus et écrits en UTF-8 explicite : sous
  Windows, `sys.stdin` décode en cp1252 et corromprait tous les accents.

## Limite connue

Un ticket est ouvert par **demande substantielle**, pas par tâche métier. Ces
tickets documentent l'historique de collaboration ; ils ne remplacent pas les
issues du backlog MVP, qui restent la référence pour le suivi d'avancement.
