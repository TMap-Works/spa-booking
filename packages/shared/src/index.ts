// Source de vérité du contrat d'API. Voir packages/shared/README.md.
//
// Le front importe d'ici et ne redéclare jamais un type que l'API expose.
// Un changement de contrat commence par ce paquet : les erreurs de compilation
// qui en découlent dans apps/* sont la liste de travail.
//
// Ce baril réexporte les quatre familles du contrat — primitives communes,
// constantes, codes d'erreur, schémas d'entités et de DTO. Chaque famille a son
// propre baril, où les réexports sont **nommés un par un** plutôt que faits par
// `export *`. C'est ce qui rend la surface publique lisible d'un coup d'œil et
// oblige à décider explicitement qu'un nouveau symbole fait partie du contrat.
//
// Ici, en revanche, `export *` sur quatre barils déjà explicites : le point de
// vigilance est la collision. Deux familles qui exporteraient le même nom le
// verraient exclu du baril racine **en silence** — d'où le test de surface
// (`src/__tests__/contract-surface.spec.ts`), qui échoue si un symbole attendu
// n'arrive pas jusqu'ici.

export * from './common/index';
export * from './constants/index';
export * from './errors/index';
export * from './schemas/index';
