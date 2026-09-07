import type {
  NotificationChannel,
  NotificationTemplateSource,
  NotificationType,
} from './notifications.types';

/**
 * Les **modèles par défaut de la plateforme** — premier critère d'acceptation de
 * #69, « avec un modèle par défaut au niveau plateforme ».
 *
 * ## Pourquoi ils sont en code et non en base
 *
 * C'est la seule décision de conception de ce fichier, et elle découle d'une
 * contrainte non négociable : « toute table métier porte `tenant_id` »
 * (CLAUDE.md, tenant-isolation §1), non nullable. Un modèle de plateforme n'a par
 * définition pas d'établissement ; l'inscrire dans `notification_templates`
 * aurait demandé un `tenant_id` nullable — c'est-à-dire une ligne que l'extension
 * de scoping ne sait pas borner, dans la table même qui décide de ce que les
 * clientes de chaque salon reçoivent. La seule autre issue aurait été de recopier
 * les quatre modèles dans chaque établissement à sa création : une correction de
 * coquille serait alors devenue une migration de données sur tous les tenants.
 *
 * Le code est donc le bon endroit, et il l'est pour une raison de fond : le
 * défaut est ce qui part quand personne n'a rien choisi. Il doit être versionné,
 * relu, testé, et identique partout — quatre propriétés qu'un fichier a et qu'une
 * ligne de base n'a pas.
 *
 * La base, elle, ne porte que les **personnalisations** : ce qu'un salon a
 * délibérément écrit. C'est ce que le critère demande — « stockés en base par
 * tenant » — et l'effacement d'une ligne rend l'établissement au défaut, sans
 * qu'aucun contenu n'ait à être recopié.
 *
 * ## Ce qu'ils reproduisent
 *
 * Exactement les messages que #70 et #71 ont livrés, à la balise près. Ce fichier
 * n'est pas une réécriture : c'est le même texte, dont les variables sont
 * désormais nommées au lieu d'être interpolées. Les suites de
 * `notification-content.spec.ts` continuent de les exercer, et c'est leur rôle —
 * elles sont la preuve que le passage au moteur n'a rien changé à ce qu'une
 * cliente lit.
 *
 * ## Pourquoi `CANCELLATION` n'en a pas
 *
 * L'avis d'annulation est le troisième message du MVP (CDC §1.4) et il a son
 * issue, #72. Lui servir ici le modèle du rappel dirait « nous vous attendons » à
 * qui vient d'annuler — pire qu'un message absent. Son absence laisse
 * `AppointmentNotificationRenderer` lever `UnrenderableNotificationError`, donc la
 * ligne en `FAILED`, donc reprenable telle quelle le jour où le modèle existera
 * (notifications §4).
 *
 * Un salon peut malgré tout en écrire un : la table accepte les trois types, et
 * rien ne justifierait de lui refuser ce que le schéma représente. S'il le fait,
 * son avis d'annulation part — ce qui est exactement ce que « personnaliser sans
 * déploiement » veut dire.
 */

/**
 * Le récapitulatif, en lignes de tableau HTML.
 *
 * L'adresse et le téléphone sont sous section : les deux colonnes sont nullables
 * au schéma, et un salon qui ne les a pas renseignés recevrait sinon deux lignes
 * vides dans chaque message. C'est le comportement que #70 avait déjà, porté dans
 * la grammaire du modèle plutôt que dans du code de rendu.
 */
const HTML_SUMMARY =
  '<tr><th align="left">Prestation</th><td>{{service}}</td></tr>' +
  '<tr><th align="left">Avec</th><td>{{praticien}}</td></tr>' +
  '<tr><th align="left">Date</th><td>{{date}}</td></tr>' +
  '<tr><th align="left">Fin prévue</th><td>{{fin}}</td></tr>' +
  '<tr><th align="left">Prix</th><td>{{prix}}</td></tr>' +
  '{{#adresse}}<tr><th align="left">Adresse</th><td>{{adresse}}</td></tr>{{/adresse}}' +
  '{{#telephone}}<tr><th align="left">Téléphone</th><td>{{telephone}}</td></tr>{{/telephone}}';

/**
 * Le même récapitulatif en texte brut.
 *
 * Les sections emportent leur saut de ligne : `{{#adresse}}Adresse : …\n{{/adresse}}`
 * ne laisse aucune ligne vide quand l'adresse manque.
 */
const TEXT_SUMMARY = [
  'Prestation : {{service}}',
  'Avec : {{praticien}}',
  'Date : {{date}}',
  'Fin prévue : {{fin}}',
  'Prix : {{prix}}',
  '{{#adresse}}Adresse : {{adresse}}',
  '{{/adresse}}{{#telephone}}Téléphone : {{telephone}}',
  '{{/telephone}}',
].join('\n');

/**
 * La confirmation de réservation — #70.
 *
 * L'heure est **toujours** suivie de son fuseau. Sans mention, « 14:30 » est
 * ambigu pour une cliente qui voyage, et c'est précisément l'ambiguïté que
 * CLAUDE.md classe en sévérité haute.
 */
const BOOKING_CONFIRMATION_EMAIL: NotificationTemplateSource = {
  subject: 'Votre rendez-vous du {{date}} est confirmé — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>Votre rendez-vous chez {{salon}} est confirmé.</p>',
    `<table role="presentation">${HTML_SUMMARY}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}.</p>',
    '<p><a href="{{lien_annulation}}">Modifier ou annuler mon rendez-vous</a></p>',
    '<p>À bientôt,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour {{client}},',
    '',
    'Votre rendez-vous chez {{salon}} est confirmé.',
    '',
    TEXT_SUMMARY,
    'Les horaires sont donnés à l’heure de {{fuseau}}.',
    '',
    'Modifier ou annuler mon rendez-vous : {{lien_annulation}}',
    '',
    'À bientôt,',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS de confirmation — l'avis, et rien d'autre.
 *
 * Il ne reprend pas le récapitulatif : un SMS n'est pas un e-mail raccourci. Le
 * détail et le lien d'annulation sont dans l'e-mail, qui part toujours
 * (notifications §6).
 *
 * Chacun de ses caractères est dans l'alphabet GSM-7 — `é` en fait partie, à la
 * différence de `’` ou de `…`. Le modèle tient donc en **un** segment, et
 * `notification-template.spec.ts` le vérifie plutôt que de l'espérer.
 */
const BOOKING_CONFIRMATION_SMS: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rendez-vous confirmé le {{date}} ({{fuseau}}).',
};

/**
 * Le rappel J-1 — #71.
 *
 * Il partage le récapitulatif de la confirmation, et affirme autre chose : la
 * confirmation dit « c'est enregistré », le rappel dit « c'est bientôt, et voici
 * comment vous décommander ». Ce second membre de phrase est sa raison d'être —
 * une annulation la veille libère un créneau que le salon peut encore vendre.
 *
 * Il ne dit pas « demain » : le rappel part entre 24 et 25 heures avant, ce qui
 * tombe presque toujours la veille — et « presque toujours » n'est pas une
 * garantie qu'un modèle a le droit de prendre.
 */
const REMINDER_EMAIL: NotificationTemplateSource = {
  subject: 'Rappel : votre rendez-vous du {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>Nous vous attendons chez {{salon}} le {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}.</p>',
    '<p>Un empêchement ? <a href="{{lien_annulation}}">Annulez ou déplacez votre rendez-vous</a> — ' +
      'cela libère le créneau pour quelqu’un d’autre.</p>',
    '<p>À très bientôt,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour {{client}},',
    '',
    'Nous vous attendons chez {{salon}} le {{date}}.',
    '',
    TEXT_SUMMARY,
    'Les horaires sont donnés à l’heure de {{fuseau}}.',
    '',
    'Un empêchement ? Annulez ou déplacez votre rendez-vous : {{lien_annulation}}',
    '',
    'À très bientôt,',
    '{{salon}}',
  ].join('\n'),
};

/** Le SMS de rappel — même économie que celui de la confirmation. */
const REMINDER_SMS: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rappel de votre rendez-vous le {{date}} ({{fuseau}}).',
};

/**
 * Les modèles de la plateforme, par type puis par canal.
 *
 * Une entrée absente veut dire « aucun modèle par défaut » — et non « modèle
 * vide » : c'est le cas de `CANCELLATION`, dont l'absence est délibérée.
 */
export const DEFAULT_TEMPLATES: Readonly<
  Partial<
    Record<NotificationType, Readonly<Partial<Record<NotificationChannel, NotificationTemplateSource>>>>
  >
> = {
  BOOKING_CONFIRMATION: { EMAIL: BOOKING_CONFIRMATION_EMAIL, SMS: BOOKING_CONFIRMATION_SMS },
  REMINDER_24H: { EMAIL: REMINDER_EMAIL, SMS: REMINDER_SMS },
};

/** Le modèle de plateforme pour ce message, s'il en existe un. */
export function defaultTemplateFor(
  type: NotificationType,
  channel: NotificationChannel,
): NotificationTemplateSource | null {
  return DEFAULT_TEMPLATES[type]?.[channel] ?? null;
}
