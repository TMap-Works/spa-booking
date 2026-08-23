# packages/shared — Contrats partagés

**Source de vérité du contrat d'API.** Le front n'y redéclare jamais un type que
l'API expose déjà ; l'API n'y duplique jamais un schéma de validation.

```
src/
  types/      entités et DTO exposés par l'API
  schemas/    schémas Zod — validés côté front (confort) et côté back (sécurité)
  errors/     codes d'erreur stables, sur lesquels le front réagit
  constants/  statuts de RDV, rôles, canaux de notification
```

Un changement de contrat commence ici. Les erreurs de compilation qui en
découlent dans `apps/*` sont la liste de travail.
