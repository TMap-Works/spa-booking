---
description: Referme le ticket de traçabilité ouvert — publie le résumé des changements produits, passe la carte du Project en Done
argument-hint: [numéro de ticket]
allowed-tools: Bash, Read
---

Referme le ticket de traçabilité ouvert par `/ticket-new` : commentaire de
résumé — commits, fichiers modifiés, travail non commité —, carte du Project en
`Done`, issue close.

Ticket visé : **$ARGUMENTS** — vide, c'est le ticket ouvert le plus récent.

## Phase 1 — Quel ticket, et est-il encore d'actualité ?

```bash
python scripts/tracking.py status
```

- **Sortie `{}`** et aucun argument → aucun ticket ouvert : le dire et s'arrêter.
  Ne pas en inventer un pour avoir quelque chose à fermer.
- **Sortie avec un `issue`** → vérifier que ce ticket correspond bien au travail
  qui vient d'être fait (champ `title`). Si l'utilisateur a nommé un autre
  numéro, c'est le sien qui prime.

## Phase 2 — Le travail est-il en état d'être clôturé ?

Le résumé publié est factuel : il montre ce qui est là, y compris les manques.
Regarder avant de fermer, et **le signaler à l'utilisateur** sans bloquer :

- du travail non commité (`git status --short`) — il apparaîtra tel quel dans le
  résumé ;
- une PR ouverte non mergée pour cette demande ;
- une vérification jamais passée alors que du code a changé (`npm run verify`).

Rien de tout cela n'empêche la clôture : le ticket documente ce qui a été fait,
pas ce qui aurait dû l'être. Mais un point resté en suspens se dit maintenant,
pas après la fermeture.

## Phase 3 — Relire le résumé

```bash
python scripts/tracking.py close --dry-run
```

Affiche le commentaire exact sans rien écrire dans GitHub. Le résumé est
construit depuis le commit de départ enregistré à l'ouverture du ticket ; s'il
est vide alors que du travail a été produit, c'est que la branche a changé
entre-temps — le dire, et fermer quand même plutôt que de perdre le ticket.

## Phase 4 — Clôturer

```bash
python scripts/tracking.py close                 # le ticket courant
python scripts/tracking.py close --issue <N>     # un ticket nommé, état perdu
```

Un seul appel : commentaire, `Done` sur la carte, issue fermée, état local
effacé. La commande est **non rejouable** — un second appel ne trouve plus
d'état et échoue ; c'est voulu, il vaut mieux une erreur qu'un second
commentaire de clôture.

## Phase 5 — Les oublis d'avant

Un ticket resté ouvert d'une session précédente fausse le suivi du sprint :

```bash
python scripts/tracking.py sweep --dry-run --older-than 0   # ce qu'il fermerait
python scripts/tracking.py sweep --older-than 24            # ferme au-delà de 24 h
```

Le seuil d'âge épargne les tickets d'un travail encore en cours — y compris dans
une session ouverte en parallèle. Ne jamais balayer à `--older-than 0` sans
avoir regardé le `--dry-run` d'abord.

## Phase 6 — Rendre compte

Une ligne : numéro et URL du ticket clôturé, et ce que le résumé contenait
(nombre de commits, ou « aucune modification de fichier »). Si un point a été
signalé en phase 2, le répéter — c'est la dernière occasion de le voir.
