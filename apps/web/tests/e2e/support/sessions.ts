/**
 * Les sessions que la suite ouvre — et le registre de ce qu'elles coûtent (#1129).
 *
 * ## Le défaut que ce module referme
 *
 * La suite ouvrait **neuf sessions de `manager@e2e.test` en cinquante secondes**,
 * pour un plafond de dix par minute et par cible depuis #1127 — une tentative de
 * marge, sur un compteur qui avait déjà fait passer `develop` au rouge une fois.
 * Chacune de ces connexions était pourtant la même : le comptoir n'a pas cinq
 * sessions parce qu'il fait cinq gestes.
 *
 * Deux mécaniques la referment, et elles sont complémentaires :
 *
 * - **l'IHM** — le projet `sessions` (`sessions.setup.ts`, déclaré en dépendance
 *   dans `playwright.config.ts`) ouvre une session de comptoir et une session
 *   cliente, les écrit ici, et chaque suite les reprend par `test.use({
 *   storageState })`. Un `storageState` n'est pas une connexion : le navigateur
 *   repart avec les cookies déjà posés, et `/auth/login` n'est pas appelé ;
 * - **l'API** — `connecter()` (`support/api.ts`) mémorise son jeton par compte et
 *   ne le redemande qu'à l'approche de son échéance.
 *
 * ## Le registre des connexions, compte par compte
 *
 * C'est le critère d'acceptation du ticket — **au plus trois par compte sur
 * l'ensemble de la suite** —, et il se vérifie en relisant ce tableau contre les
 * appels du dossier. Toute ligne ajoutée ici doit l'être sciemment.
 *
 * | Compte | Ouvertures | Où, et pourquoi celle-là existe |
 * |---|---|---|
 * | `manager@e2e.test` | 2 | `sessions.setup.ts` pour l'IHM du comptoir · `connecter()` pour l'API, une fois par processus de worker |
 * | `client@e2e.test` | 3 | `sessions.setup.ts` pour les traversées qui n'éprouvent pas la porte · le tunnel du parcours critique (fr) · le tunnel du parcours bilingue (en) |
 * | `admin@e2e.test` | 1 | `session-expiree.e2e.ts`, dont l'objet **est** la session |
 * | `staff@e2e.test` | 0 | la matrice de permissions se couvre sans navigateur |
 *
 * Les deux connexions du tunnel restent délibérément : réserver exige un compte
 * depuis le 2026-09-22, l'écran de connexion est une étape du parcours critique,
 * et #846 demande que le même scénario passe dans les deux langues — traverser
 * cette porte avec des cookies déjà posés ne prouverait plus rien d'elle. Les
 * deux scénarios qui ne surveillent que la console, eux, repartent de la session
 * enregistrée : ils rejouaient le tunnel pour regarder ailleurs.
 *
 * ## Ce qu'un fichier de session rejoué exige du banc
 *
 * Un `storageState` est une **copie figée** : le jeton de rafraîchissement qu'il
 * porte y reste tel quel, alors que l'API le fait tourner à chaque renouvellement
 * et n'en accepte qu'un usage — dix secondes de grâce mises à part
 * (`REFRESH_ROTATION_GRACE_MS`). Si un scénario renouvelle, le suivant repart d'un
 * jeton déjà consommé, l'API y voit un réemploi et **révoque la session** : tous
 * ceux qui partagent le fichier échouent ensuite sur l'écran de connexion.
 *
 * Rien ne renouvelle tant que le cookie d'accès enregistré est valide, et c'est
 * ce que `playwright.config.ts` garantit en portant `JWT_EXPIRES_IN` à deux
 * heures pour les serveurs du banc — voir la note qui l'accompagne. Les deux
 * mécaniques tiennent ensemble : ouvrir une session une fois n'est sûr que si
 * elle vaut plus longtemps que la passe.
 *
 * ## Ce que le plafond n'a pas à devenir
 *
 * Relever les dix tentatives par minute de `/auth/login` n'est pas une option :
 * c'est la borne que #1127 a posée contre le forçage du mot de passe d'un compte,
 * et une suite E2E n'est pas une raison de la desserrer.
 *
 * ## Où les fichiers vivent
 *
 * Sous `test-results/`, comme le jeu d'essai (`jeu-dessai.ts`) et pour les mêmes
 * raisons : déjà ignoré par `.gitignore`, et hors de l'`outputDir` que Playwright
 * vide à chaque exécution. Ils sont réécrits à chaque run par le projet
 * `sessions`, si bien qu'aucun d'eux ne survit à la table rase du jeu d'essai —
 * un jeton d'un établissement effacé ne servirait à rien.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { RACINE_WEB } from './environnement';

const RACINE_SESSIONS = path.join(RACINE_WEB, 'test-results', 'sessions');

/** La session du comptoir — rang gérant, back-office de l'établissement d'essai. */
export const SESSION_COMPTOIR = path.join(RACINE_SESSIONS, 'comptoir.json');

/** La session de la cliente — espace client, celle que le tunnel reconnaît. */
export const SESSION_CLIENTE = path.join(RACINE_SESSIONS, 'cliente.json');

/** Le jeton d'accès de l'espace client — voir `compte/session.ts`, `ACCESS_COOKIE`. */
export const COOKIE_ACCES_CLIENT = 'spa_account_access';

/**
 * La présence de la cliente — `lib/account-presence.ts`.
 *
 * C'est **lui** que le tunnel lit, et non le jeton : les cookies de session sont
 * bornés à `/{slug}/compte`, et `/{slug}/reservation` ne les reçoit jamais. Une
 * session enregistrée sans ce cookie-là rouvrirait la porte du compte au milieu
 * du tunnel.
 */
export const COOKIE_PRESENCE_CLIENT = 'spa_account_presence';

/**
 * Crée le dossier des sessions avant que Playwright n'y écrive.
 *
 * `storageState({ path })` écrit un fichier ; il ne crée pas l'arborescence qui
 * le porte, et `test-results/sessions/` n'existe pas au premier run d'un dépôt
 * fraîchement cloné.
 */
export function preparerDossierDesSessions(): void {
  mkdirSync(RACINE_SESSIONS, { recursive: true });
}
