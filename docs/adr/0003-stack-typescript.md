# ADR 0003 — TypeScript de bout en bout (Next.js + NestJS)

- **Statut** : Accepté
- **Date** : 2026-08-23
- **Contexte CDC** : §2.2 Stack technologique proposée

## Contexte

Le CDC laisse le choix ouvert entre Node.js (NestJS) et Python (FastAPI/Django)
pour le backend, le front étant fixé à React/Next.js. Le calendrier d'un mois
impose de minimiser les frictions.

## Options envisagées

### Option A — NestJS (TypeScript)

Un seul langage sur toute la chaîne. Les contrats d'API sont partagés
littéralement entre le front et le back via un paquet commun : un changement de
contrat produit une erreur de compilation exactement là où il casse quelque
chose. La structure modulaire de NestJS correspond directement au découpage du
CDC §2.3. Le futur React Native réutilise les mêmes types.

### Option B — FastAPI (Python)

Très productif, Pydantic offre une validation solide. Mais le contrat d'API doit
être maintenu en double — schémas Pydantic côté back, types TypeScript côté
front — ou généré, ce qui ajoute une étape de build et une source de
désynchronisation silencieuse.

### Option C — Django + DRF

ORM et interface d'administration matures, utiles pour un back-office. Le modèle
reste orienté requête-réponse synchrone, moins adapté au calcul de disponibilité
temps réel, et le poids du framework ralentit l'itération sur un MVP court.

## Décision

Option A. NestJS et Prisma côté API, Next.js 15 côté web, types et schémas de
validation partagés dans `packages/shared` — source de vérité unique du contrat
d'API.

## Conséquences

**Facilite** : un seul écosystème d'outillage, une revue de code sans changement
de contexte, un contrat d'API impossible à désynchroniser silencieusement, une
bascule directe vers React Native en post-MVP.

**Coûte** : Node reste moins à l'aise que Python sur le calcul intensif. Les
agrégats de reporting devront s'appuyer sur SQL plutôt que sur du code
applicatif — ce qui est de toute façon préférable.

**Ferme** : l'usage des bibliothèques Python d'analyse de données dans le
backend. Si un tel besoin apparaît en post-MVP, il justifiera un service dédié
plutôt qu'un changement de la stack principale.
