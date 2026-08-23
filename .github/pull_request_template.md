## Contexte

<!-- Pourquoi ce changement ? Quel problème résout-il ? -->

Closes #

## Ce qui change

<!-- Les points saillants du diff, pas un journal de commits -->

-

## Comment vérifier

<!-- Étapes concrètes pour qu'un relecteur constate que ça marche -->

1.

## Critères d'acceptation

<!-- Repris de l'issue, cochés un par un -->

- [ ]

## Definition of Done

- [ ] Tests unitaires et d'intégration passants
- [ ] Test d'isolation inter-tenant pour tout endpoint nouveau ou modifié
- [ ] Migration Prisma relue : additive et réversible
- [ ] Aucune entité Prisma renvoyée telle quelle par un contrôleur
- [ ] Types d'API exposés ajoutés à `packages/shared` (pas de doublon dans `apps/web`)
- [ ] Aucun secret, clé ou donnée personnelle dans le diff ni dans les logs
- [ ] Documentation à jour (README de module, ADR si décision structurante)

## Points d'attention pour la revue

<!-- Concurrence, fuseaux horaires, montants, PCI, RGPD, coût AWS, performance -->
