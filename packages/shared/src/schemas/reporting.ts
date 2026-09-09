/**
 * Le contrat de l'**export** du reporting — #563, sixième critère de #75.
 *
 * ## Pourquoi ce fichier ne décrit que l'export, et pas les trois rapports
 *
 * Les trois rapports de lecture (`/reports/revenue`, `/reports/appointments`,
 * `/reports/no-shows`) ne sont pas encore au contrat partagé : le front les
 * relit contre ses propres schémas (`apps/web/lib/admin/reporting-contract.ts`),
 * qui documentent l'écart. #554 l'a examiné et **assumé** plutôt que refermé :
 * les y remonter suppose de trancher la question de casse (`NO_SHOW` en base,
 * `no_show` au contrat), qui est un changement de format de fil, et elle ne se
 * décide pas pour le reporting seul — l'historique, les rôles et l'agenda la
 * posent au même endroit.
 *
 * L'export, lui, **naît** au contrat. Sa réponse ne porte ni statut, ni moyen de
 * paiement, ni la moindre valeur d'énumération : trois chaînes, dont aucune n'a
 * de casse à négocier. Le publier ici plutôt que de le redéclarer d'un côté et
 * de l'autre est donc gratuit, et c'est la règle du dépôt — « les types d'API
 * vivent dans `packages/shared` » (CLAUDE.md).
 *
 * ## Ce que la réponse **ne** porte pas
 *
 * Ni la clé S3, ni le nom du bucket, ni l'identifiant d'établissement. La clé
 * est préfixée par le `tenant_id` et cette valeur vient du **jeton vérifié**,
 * jamais d'une charge utile : la publier reviendrait à apprendre à un
 * établissement la forme des clés de ses voisins, et à inviter un appelant à
 * proposer la sienne. L'`id` rendu ci-dessous est l'identifiant **relatif** de
 * l'export dans le préfixe du tenant courant — il ne désigne rien en dehors.
 */

import { z } from 'zod';

import { utcInstantSchema } from '../common/time';

/**
 * Durée de vie maximale d'une URL présignée d'export, en secondes.
 *
 * Quinze minutes, le plafond du quatrième critère de #563. Ce n'est pas une
 * précaution de style : une URL présignée est un **porteur** — quiconque la
 * détient lit l'objet, sans jeton, sans rôle et sans trace côté application.
 * Elle transite par un journal de navigateur, un historique, un presse-papier ;
 * la seule chose qui borne les dégâts est le temps qu'elle reste valable.
 *
 * Quinze minutes, et non une : le fichier se télécharge à la main, parfois sur
 * une connexion de salon, et une URL périmée avant le clic aurait forcé à
 * régénérer l'export — donc à déposer un second objet — à chaque tentative.
 */
export const MAX_REPORT_EXPORT_TTL_SECONDS = 900;

/**
 * L'export d'un rapport, tel que l'API le rend.
 *
 * `url` est **présignée et éphémère** : elle vaut jusqu'à `expiresAt`, et pas
 * une seconde de plus. Un écran ne la met donc jamais en cache et ne la range
 * dans aucun état persistant — il l'ouvre, ou il la redemande.
 *
 * `filename` est le nom que le navigateur donnera au fichier. Il est **préfixé
 * par le slug de l'établissement** (`maison-lotus-reporting-2026-09-01_2026-09-30.csv`),
 * pour que deux exports de deux salons ne se confondent pas dans un dossier de
 * téléchargements — c'est la première moitié du cinquième critère de #75, et
 * elle est désormais tenue côté serveur plutôt que par le navigateur.
 *
 * `id` désigne l'export dans le préfixe du tenant courant, et sert à le
 * **re-signer** une fois l'URL périmée sans reproduire le fichier. Il ne dit
 * rien de la clé S3 réelle : celle-ci se reconstruit côté serveur à partir de
 * l'établissement du jeton, si bien qu'un `id` présenté par un salon voisin
 * désigne un objet inexistant chez lui — 404, jamais l'URL.
 */
export const reportExportSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string().url(),
    expiresAt: utcInstantSchema,
    filename: z.string().min(1),
  })
  .strict();

export type ReportExport = z.infer<typeof reportExportSchema>;
