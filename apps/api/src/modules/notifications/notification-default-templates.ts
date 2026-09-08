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
 * ## `CANCELLATION` en a un depuis #72
 *
 * Il en manquait un jusque-là, délibérément : servir à un avis d'annulation le
 * modèle du rappel aurait dit « nous vous attendons » à qui vient d'annuler,
 * pire qu'un message absent. C'est ce ticket qui l'écrit, et il est le seul des
 * trois à s'adresser **à deux publics** — la cliente et le praticien (CDC §1.4,
 * « avis d'annulation au staff et au client »). D'où sa forme : il ne tutoie
 * personne, ne dit ni « votre cliente » ni « votre praticien », et nomme les
 * deux parties dans son récapitulatif.
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
 * Le récapitulatif d'un rendez-vous **annulé**, en lignes de tableau HTML.
 *
 * Il diffère de `HTML_SUMMARY` sur deux points, et les deux tiennent au fait
 * qu'il est lu par la cliente **ou** par le praticien :
 *
 * 1. il nomme la **cliente**. Les deux autres messages n'en ont pas besoin — ils
 *    lui sont adressés — mais un praticien qui apprend une annulation a d'abord
 *    besoin de savoir de qui il s'agit ;
 * 2. il ne dit pas la **fin prévue** ni le **prix**. Ce sont des informations
 *    d'exécution : elles servent à se préparer et à payer, or il n'y a plus rien
 *    à préparer ni à régler. Les faire figurer aurait donné à un avis
 *    d'annulation l'allure d'une facture.
 */
const CANCELLATION_HTML_SUMMARY =
  '<tr><th align="left">Client</th><td>{{client}}</td></tr>' +
  '<tr><th align="left">Prestation</th><td>{{service}}</td></tr>' +
  '<tr><th align="left">Avec</th><td>{{praticien}}</td></tr>' +
  '<tr><th align="left">Date</th><td>{{date}}</td></tr>' +
  '{{#telephone}}<tr><th align="left">Téléphone du salon</th><td>{{telephone}}</td></tr>{{/telephone}}';

/** Le même récapitulatif en texte brut — même grammaire de sections. */
const CANCELLATION_TEXT_SUMMARY = [
  'Client : {{client}}',
  'Prestation : {{service}}',
  'Avec : {{praticien}}',
  'Date : {{date}}',
  '{{#telephone}}Téléphone du salon : {{telephone}}',
  '{{/telephone}}',
].join('\n');

/**
 * L'avis d'annulation — #72, troisième message du MVP.
 *
 * ## Il ne salue personne par son nom
 *
 * « Bonjour, » et non « Bonjour {{client}}, ». Le modèle est unique par canal —
 * l'unique de `notification_templates` est `(tenant_id, type, channel)` — et il
 * part aussi bien à la cliente qu'au praticien. Le nom de la cliente est donc
 * dans le récapitulatif, où il est une **information** pour l'un et une
 * confirmation pour l'autre, et non dans la salutation, où il aurait salué le
 * praticien du nom de sa cliente.
 *
 * ## L'origine est sous section
 *
 * `{{#origine}}` s'efface si l'origine est vide, ce qui n'arrive pas sur un
 * rendez-vous réellement annulé mais reste la conduite sûre : un salon qui
 * recopie ce modèle pour le personnaliser n'écrira jamais « a été annulé . »
 * avec une espace en trop.
 *
 * ## Il ne dit pas pourquoi
 *
 * Le motif (`appointments.cancellation_reason`) n'a pas de variable, et il n'en
 * aura pas : c'est un texte libre écrit par un humain, qui peut nommer un état
 * de santé ou un tiers. Il est enregistré sur la ligne, et qui a le droit de le
 * lire l'y relit (CDC §5.1).
 *
 * ## Le lien est sous section, et c'est le correctif de #534
 *
 * « Prendre un nouveau rendez-vous » vers l'espace client est une invitation qui
 * n'a de sens que pour la cliente. Tant qu'un seul des deux publics recevait
 * l'avis, la faute passait ; depuis que les deux le reçoivent sur la même
 * annulation, le praticien lirait à chaque fois une phrase qui ne le concerne
 * pas — et qui l'enverrait sur un espace qui n'est pas son agenda.
 *
 * `{{#destinataire_client}}` referme le paragraphe pour lui, et pour lui seul.
 * Le reste du message — le récapitulatif qui nomme la cliente, l'origine, le
 * « le créneau est de nouveau disponible » — vaut pour les deux et ne bouge pas.
 * C'est ce qui permet de corriger la faute **sans** dégrader l'e-mail de la
 * cliente, ce qu'une reformulation neutre aurait fait.
 */
const CANCELLATION_EMAIL: NotificationTemplateSource = {
  subject: 'Annulation du rendez-vous du {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour,</p>',
    '<p>Le rendez-vous ci-dessous chez {{salon}} a été annulé{{#origine}} {{origine}}{{/origine}}.</p>',
    `<table role="presentation">${CANCELLATION_HTML_SUMMARY}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}. Le créneau est de nouveau disponible.</p>',
    '{{#destinataire_client}}<p><a href="{{lien_annulation}}">Prendre un nouveau rendez-vous</a></p>{{/destinataire_client}}',
    '<p>{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour,',
    '',
    'Le rendez-vous ci-dessous chez {{salon}} a été annulé{{#origine}} {{origine}}{{/origine}}.',
    '',
    CANCELLATION_TEXT_SUMMARY,
    'Les horaires sont donnés à l’heure de {{fuseau}}. Le créneau est de nouveau disponible.',
    // La ligne vide est **dans** la section : sans cela, un avis au praticien
    // aurait laissé deux lignes vides à la place du lien.
    '{{#destinataire_client}}',
    'Prendre un nouveau rendez-vous : {{lien_annulation}}',
    '{{/destinataire_client}}',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS d'annulation — même économie que les deux autres.
 *
 * Il ne porte ni récapitulatif ni lien : le détail est dans l'e-mail, qui part
 * toujours (notifications §6). Ce qu'un SMS doit faire ici est **arrêter le
 * déplacement** de quelqu'un qui allait venir, et cela tient en une phrase.
 *
 * Chacun de ses caractères est dans l'alphabet GSM-7 — y compris le `é` de
 * « annulé » et le `è` de « système », que `{{origine}}` peut y déposer. Il tient
 * donc en un segment, et `notification-template.spec.ts` le mesure sur le rendu
 * de référence plutôt que de le supposer.
 */
const CANCELLATION_SMS: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rendez-vous du {{date}} ({{fuseau}}) annulé{{#origine}} {{origine}}{{/origine}}.',
};

/**
 * Les modèles de la plateforme, par type puis par canal.
 *
 * Les trois messages du CDC §1.4 y sont désormais, sur les deux canaux. La
 * structure reste **partielle** — `Partial<Record<…>>` — et `defaultTemplateFor`
 * continue de rendre `null` : une entrée absente veut dire « aucun modèle par
 * défaut », et non « modèle vide ». C'est la forme qui accueillera un quatrième
 * message sans que le renderer ait à changer, et c'est elle qui garantit qu'un
 * type ajouté à l'énumération sans son modèle échoue en `FAILED` plutôt que de
 * partir vide.
 */
export const DEFAULT_TEMPLATES: Readonly<
  Partial<
    Record<NotificationType, Readonly<Partial<Record<NotificationChannel, NotificationTemplateSource>>>>
  >
> = {
  BOOKING_CONFIRMATION: { EMAIL: BOOKING_CONFIRMATION_EMAIL, SMS: BOOKING_CONFIRMATION_SMS },
  REMINDER_24H: { EMAIL: REMINDER_EMAIL, SMS: REMINDER_SMS },
  CANCELLATION: { EMAIL: CANCELLATION_EMAIL, SMS: CANCELLATION_SMS },
};

/** Le modèle de plateforme pour ce message, s'il en existe un. */
export function defaultTemplateFor(
  type: NotificationType,
  channel: NotificationChannel,
): NotificationTemplateSource | null {
  return DEFAULT_TEMPLATES[type]?.[channel] ?? null;
}
