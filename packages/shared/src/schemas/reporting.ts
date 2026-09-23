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
import { submittedLocaleSchema } from '../locale/index';
import type { Locale } from '../locale/locale';

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

/**
 * La langue dans laquelle l'export CSV est écrit — #851, troisième critère.
 *
 * ## Pourquoi la langue voyage dans la demande, et pas ailleurs
 *
 * Le fichier est produit **par le serveur** depuis #563 : c'est lui qui écrit la
 * ligne d'en-tête, la colonne de libellés et les séparateurs. Or la langue de
 * l'interface vit côté navigateur — elle est choisie par la personne qui regarde
 * l'écran, pas par l'établissement. Trois façons de la faire traverser étaient
 * possibles, et deux sont écartées :
 *
 * - `Accept-Language` : c'est la préférence du **navigateur**, pas celle de
 *   l'interface. Une gérante qui bascule le back-office en anglais sur un
 *   navigateur français aurait reçu un fichier français ;
 * - `tenants.default_locale` : c'est la langue de l'établissement, celle des
 *   notifications envoyées aux clientes. Elle ne dit rien de la langue dans
 *   laquelle on est *en train* de lire l'écran.
 *
 * Reste la demande elle-même, où la langue est un paramètre explicite — et ce
 * schéma est ce qui la valide, des deux côtés du fil : le front l'emploie avant
 * d'émettre, l'API avant de produire quoi que ce soit.
 *
 * `submittedLocaleSchema` et non `localeSchema` : la valeur arrive d'une chaîne
 * de requête, donc d'une **saisie** au sens large — `FR` et ` fr ` sont la même
 * langue, et refuser sur la casse ferait échouer un export pour une raison qui
 * n'en est pas une. La sortie, elle, est toujours l'une des deux valeurs du
 * contrat.
 */
export const reportExportLocaleSchema = submittedLocaleSchema;

/**
 * La langue employée quand la demande n'en porte aucune.
 *
 * **Le français**, et non `DEFAULT_LOCALE` — qui vaut `en`, la langue par défaut
 * du *système*. Les deux ne répondent pas à la même question : celle-ci dit ce
 * qu'un export doit contenir quand personne n'a demandé de langue, c'est-à-dire
 * quand l'appelant est antérieur à ce ticket. Avant #851 le fichier était écrit
 * en français, en dur ; un repli sur `en` aurait donc fait basculer en anglais,
 * sans qu'aucun appel ne change, les exports de tout client non encore mis à
 * jour.
 *
 * C'est la même conduite que le repli transitoire de `lib/format.ts` et de
 * `lib/appointment-status.ts` côté web (#845) : le défaut garde le comportement
 * d'avant le ticket.
 */
export const REPORT_EXPORT_FALLBACK_LOCALE: Locale = 'fr';

/**
 * La langue d'une demande d'export, quoi qu'elle porte — jamais d'erreur.
 *
 * Rendue ici plutôt que recopiée de part et d'autre : le front et l'API doivent
 * retenir **la même** langue pour la même demande, sans quoi l'écran annoncerait
 * un fichier anglais et le fichier sortirait français. Une valeur absente
 * retombe sur {@link REPORT_EXPORT_FALLBACK_LOCALE} ; une valeur présente mais
 * invalide est du ressort de la validation de la route, qui la refuse en 400
 * avant qu'on arrive ici.
 */
export function resolveReportExportLocale(value: unknown): Locale {
  const parsed = reportExportLocaleSchema.safeParse(value);

  return parsed.success ? parsed.data : REPORT_EXPORT_FALLBACK_LOCALE;
}
