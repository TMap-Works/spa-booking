# Police embarquée du ticket de caisse — Roboto

`roboto-regular.ts` et `roboto-bold.ts` portent les octets de **Roboto**,
Copyright 2011 Google Inc., distribuée sous **Apache License 2.0**
(<https://www.apache.org/licenses/LICENSE-2.0>).

Les fichiers d'origine sont `Roboto_400Regular.ttf` et `Roboto_700Bold.ttf`
du paquet npm [`@expo-google-fonts/roboto`](https://www.npmjs.com/package/@expo-google-fonts/roboto),
repris tels quels — aucun glyphe n'a été retiré ni modifié.

## Pourquoi du base64 dans un `.ts`, et non deux `.ttf`

Parce que la compilation de l'API est **`tsc` et rien d'autre**
(`apps/api/package.json` : `"build": "tsc -p tsconfig.build.json"`), et que
`tsconfig.build.json` ne prend que `src/**/*.ts`. Un `.ttf` posé à côté des
sources ne serait jamais recopié dans `dist/` — et l'image d'exécution ne
contient **que** `dist/` (`apps/api/Dockerfile`, étape `runtime`). La panne
serait un `ENOENT` au premier ticket imprimé en production, invisible en local
où les sources sont là.

Trois issues de la maison décrivent exactement cette classe de panne — un
artefact présent à la compilation et absent de l'image (#463). Le choix est donc
délibéré : un module TypeScript **est** une source, il traverse `tsc`, il arrive
dans `dist/`, et il n'y a pas d'étape de copie d'actifs à tenir.

Le coût est un `Buffer.from(…, 'base64')` par police au démarrage du service —
une fois, mis en cache dans un module — soit environ 330 Kio de RSS.

## Pourquoi Roboto, et pourquoi deux graisses

Le deuxième critère de #819 demande une police **embarquée** « qui rend les
accents et les symboles de devise (€, Ar) ». Roboto couvre le latin étendu, `€`
(U+20AC) et les lettres de `Ar`, et sa licence permissive autorise
la redistribution dans un binaire.

Deux graisses parce qu'un ticket de caisse hiérarchise : l'enseigne, le numéro de
pièce et le total sont en gras, le reste en romain. Simuler le gras par un
double passage décalé — ce que fait un pilote d'imprimante thermique — donne un
rendu sale à 203 ppp et ne se contrôle pas depuis PDFKit.
