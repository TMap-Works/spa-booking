import type { ReportWindow } from '../reporting.types';

/**
 * La clé d'un export dans le bucket, et le nom du fichier qui en sort — #563,
 * deuxième critère.
 *
 * ## La clé est **préfixée par le `tenant_id`**, et ce préfixe ne vient jamais
 * de la requête
 *
 * `exports/{tenant_id}/{export_id}.csv`. Le premier segment est l'établissement
 * du **jeton vérifié**, résolu par le contexte de requête ; aucun appelant ne
 * peut le proposer, et aucune route ne l'accepte en paramètre
 * (tenant-isolation §2). C'est ce qui fait tenir la propriété demandée : un
 * `export_id` présenté par un salon voisin est recomposé sous **son** préfixe à
 * lui, désigne un objet qui n'existe pas, et rend 404 — jamais 403, jamais
 * l'URL, jamais la donnée (tenant-isolation §4).
 *
 * Le corollaire tient en une phrase, et c'est la seule règle à retenir de ce
 * fichier : **jamais de clé reçue, toujours une clé reconstruite.** Accepter une
 * clé complète depuis le fil aurait rendu la frontière négociable par celui-là
 * même qu'elle borne.
 *
 * ## L'identifiant est un UUID, et il est tiré au sort
 *
 * Ni le nom du fichier, ni la fenêtre, ni un compteur. Deux raisons :
 *
 * - deux exports de la même période ne doivent pas s'écraser — la gérante qui
 *   régénère son fichier après une correction de caisse attend deux fichiers,
 *   pas un ;
 * - une clé **devinable** est une clé qu'on tente. Le préfixe de tenant suffit à
 *   fermer la porte, mais un identifiant tiré au sort fait qu'il n'y a même pas
 *   de porte à essayer, y compris depuis le même établissement.
 *
 * ## Le nom du fichier n'entre pas dans la clé
 *
 * Il est servi par `Content-Disposition` au moment de la présignature. Le mettre
 * dans la clé aurait fait voyager un slug d'établissement et deux dates dans une
 * URL présignée — de l'information gratuite pour qui l'intercepte — et aurait
 * exposé la clé aux caractères que le slug peut porter.
 */

/** Le préfixe commun de tous les exports du bucket. */
export const REPORT_EXPORT_KEY_PREFIX = 'exports';

/** Extension et type MIME du seul format que l'export produit à ce jour. */
export const REPORT_EXPORT_EXTENSION = 'csv';

/**
 * `text/csv;charset=utf-8` — le jeu de caractères est **dans** le type.
 *
 * Sans lui, le tableur d'une gérante en locale française ouvre « Prestations
 * bien-être » en « PrestationsÂ bien-Ãªtre ». La marque d'ordre d'octets écrite
 * en tête du fichier joue le même rôle pour les tableurs qui ignorent l'en-tête ;
 * les deux sont posées, parce qu'aucune des deux ne suffit partout.
 */
export const REPORT_EXPORT_CONTENT_TYPE = 'text/csv;charset=utf-8';

/**
 * La clé d'objet d'un export — `exports/{tenantId}/{exportId}.csv`.
 *
 * Les deux fragments sont des UUID validés en amont : le `tenantId` vient du
 * jeton, l'`exportId` d'un tirage local ou d'un paramètre de route contraint par
 * `@IsUUID()`. Aucun des deux ne peut donc porter de `/` ni de `..` — ce qui
 * n'est pas une politesse : une clé S3 accepte les deux, et un `..` remonterait
 * hors du préfixe de l'établissement.
 */
export function reportExportKey(tenantId: string, exportId: string): string {
  return `${REPORT_EXPORT_KEY_PREFIX}/${tenantId}/${exportId}.${REPORT_EXPORT_EXTENSION}`;
}

/**
 * Le nom que le navigateur donnera au fichier —
 * `maison-lotus-reporting-2026-09-01_2026-09-30.csv`.
 *
 * Il reprend la forme que le navigateur posait jusqu'à #563 — la construction
 * côté web est partie avec ce ticket —, et la première moitié du cinquième
 * critère de #75 avec elle : le
 * fichier est **préfixé par l'établissement**, pour que deux exports de deux
 * salons ne se confondent pas dans un dossier de téléchargements.
 *
 * Les deux dates sont **civiles et inclusives**, lues dans le fuseau du salon :
 * la fenêtre de l'API a sa borne haute exclue — « du 1er au 30 septembre » y est
 * `[2026-09-01, 2026-10-01[` — et écrire `2026-10-01` dans le nom aurait fait
 * lire un jour qui n'est pas dans le fichier. La seconde borne est donc reculée
 * d'une milliseconde avant d'être découpée, ce qui rend le dernier instant
 * réellement couvert.
 */
export function reportExportFilename(
  tenantSlug: string,
  window: ReportWindow,
  timeZone: string,
): string {
  const from = civilDate(window.from, timeZone);
  const to = civilDate(new Date(window.to.getTime() - 1), timeZone);

  return `${tenantSlug}-reporting-${from}_${to}.${REPORT_EXPORT_EXTENSION}`;
}

/**
 * La date civile d'un instant dans un fuseau IANA, en `YYYY-MM-DD`.
 *
 * `Intl.DateTimeFormat` avec `en-CA` rend déjà ce format ; il est malgré tout
 * recomposé à partir des parties, parce qu'une locale n'est pas un contrat —
 * l'implémentation d'ICU décide du séparateur, et un fichier nommé
 * `2026/09/01` n'est pas un nom de fichier.
 */
function civilDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}
