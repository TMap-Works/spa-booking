# ADR 0001 — Monolithe modulaire plutôt que microservices

- **Statut** : Accepté
- **Date** : 2026-08-23
- **Contexte CDC** : §2.1 Principes d'architecture

## Contexte

Le MVP doit être livré en quatre semaines par une équipe restreinte, tout en
préservant la possibilité d'évoluer vers une plateforme multi-établissement.
Le découpage fonctionnel comporte huit domaines métier bien identifiés.

## Options envisagées

### Option A — Microservices dès le départ

Chaque domaine devient un service déployable indépendamment. Cela offre une
isolation forte et une mise à l'échelle ciblée, au prix d'une infrastructure
démultipliée : huit pipelines, huit jeux de logs, communication inter-services,
cohérence distribuée. Sur quatre semaines, ce coût consomme la majeure partie du
budget avant toute fonctionnalité livrée.

### Option B — Monolithe modulaire

Un backend unique, découpé en modules métier aux frontières explicites, déployé
comme une seule unité. Un module s'extrait plus tard en service si un besoin réel
de mise à l'échelle indépendante apparaît.

## Décision

Option B. Un backend NestJS unique, structuré en huit modules (identity, catalog,
availability, appointments, crm, payments, notifications, reporting), déployé sur
ECS Fargate.

La discipline de découplage est appliquée dès maintenant : un module n'importe
jamais le repository d'un autre. Les échanges passent par un appel de service
(lecture synchrone) ou un événement de domaine (réaction asynchrone).

## Conséquences

**Facilite** : un seul pipeline CI/CD, un seul jeu de logs, des transactions
locales pour les opérations critiques comme la réservation, un temps de mise en
route très court.

**Coûte** : la mise à l'échelle est globale — un pic sur le moteur de
disponibilité fait monter tout le service. Acceptable au dimensionnement du MVP,
qui vise un à quelques établissements.

**Ferme** : le déploiement indépendant par domaine et l'hétérogénéité
technologique entre modules. Rouvrir cette porte demandera une extraction, dont
le coût est directement proportionnel au respect de la règle de non-import croisé
énoncée ci-dessus.
