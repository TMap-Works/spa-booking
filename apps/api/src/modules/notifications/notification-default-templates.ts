import type { Locale } from '@spa/shared';

import type {
  NotificationChannel,
  NotificationTemplateSource,
  NotificationType,
} from './notifications.types';

/**
 * Les **modèles par défaut de la plateforme** — premier critère d'acceptation de
 * #69, « avec un modèle par défaut au niveau plateforme », et de #854, « des
 * modèles par défaut en `fr` et en `en` pour chaque type et chaque canal ».
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
 * les modèles dans chaque établissement à sa création : une correction de
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
 * ## Deux langues, et le repli ne traverse jamais la frontière — #854
 *
 * `DEFAULT_TEMPLATES` est désormais indexé par langue **d'abord**. Un envoi en
 * anglais qui ne trouve pas de personnalisation anglaise retombe sur le défaut
 * **anglais**, jamais sur la personnalisation française du salon : c'est le
 * quatrième critère d'acceptation, et c'est la raison pour laquelle ce fichier a
 * dû exister dans les deux langues avant que la colonne `locale` ait le moindre
 * intérêt. Sans lui, « pas de personnalisation dans cette langue » n'aurait eu
 * d'autre issue que de servir l'autre langue.
 *
 * ## Les deux jeux ne sont pas des traductions mot à mot
 *
 * Ils disent la même chose, et ce sont les **mêmes contraintes** qui les
 * gouvernent : pas de salutation nominative sur un message à deux publics, le
 * fuseau toujours nommé à côté d'une heure, l'origine d'annulation sous section,
 * et — sur le canal SMS — un coût borné, mesuré plutôt qu'espéré. Ce qui change
 * est l'idiome, pas la structure : `notification-default-templates.spec.ts`
 * vérifie que les deux langues couvrent exactement les mêmes couples
 * `(type, canal)`, faute de quoi une cliente perdrait son message en changeant de
 * langue.
 *
 * ## Ce que les modèles français reproduisent
 *
 * Les messages que #70 et #71 ont livrés, à la balise près. Ce fichier n'était
 * pas une réécriture : c'était le même texte, dont les variables sont désormais
 * nommées au lieu d'être interpolées. Les suites de
 * `notification-content.spec.ts` continuent de les exercer, et c'est leur rôle —
 * elles sont la preuve que le passage au moteur n'a rien changé à ce qu'une
 * cliente lit.
 *
 * La seule exception est la **confirmation**, que #911 a reformulée : elle
 * annonçait un rendez-vous « confirmé » alors qu'elle part sur la création,
 * c'est-à-dire sur un rendez-vous encore `PENDING`. Ce n'est pas un changement de
 * ton, c'est la correction d'un fait faux.
 */

// ---------------------------------------------------------------------------
// Français
// ---------------------------------------------------------------------------

/**
 * Le récapitulatif, en lignes de tableau HTML.
 *
 * L'adresse et le téléphone sont sous section : les deux colonnes sont nullables
 * au schéma, et un salon qui ne les a pas renseignés recevrait sinon deux lignes
 * vides dans chaque message. C'est le comportement que #70 avait déjà, porté dans
 * la grammaire du modèle plutôt que dans du code de rendu.
 *
 * ## La référence vient **en tête**, depuis #796
 *
 * Elle n'est pas sous section : la colonne est `NOT NULL`, tout rendez-vous en
 * porte une. Et elle est la première ligne parce qu'elle ne décrit rien — elle
 * **désigne**. C'est la seule information de ce tableau qu'une cliente cherche
 * dans son e-mail au moment de téléphoner, et la seule que le comptoir sache
 * résoudre : « RDV-A5HY-14 » ouvre le rendez-vous, « Massage 60 min, mardi » se
 * cherche à la main.
 *
 * Ce récapitulatif sert la confirmation **et** le rappel J-1, et c'est voulu :
 * le rappel est le message qu'une cliente a le plus souvent sous les yeux quand
 * elle appelle pour déplacer. L'avis d'annulation, lui, a son propre
 * récapitulatif et ne la porte pas — il n'y a plus de rendez-vous à citer.
 */
const HTML_SUMMARY_FR =
  '<tr><th align="left">Référence</th><td>{{reference}}</td></tr>' +
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
const TEXT_SUMMARY_FR = [
  'Référence : {{reference}}',
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
 *
 * ## Elle ne dit pas « confirmé », et c'est le correctif de #911
 *
 * Ce message part sur `appointment.created` — `BookingConfirmationListener`
 * s'abonne à cet événement-là — c'est-à-dire sur un rendez-vous que le dépôt
 * vient d'écrire au statut `PENDING`. Annoncer « votre rendez-vous est
 * confirmé » y était donc faux au moment même de l'envoi, et contredisait
 * l'espace client qui affichait, sur ce rendez-vous-là, « À confirmer par le
 * salon ».
 *
 * Le message dit **deux choses**, dans cet ordre : la réservation est
 * enregistrée — c'est ce qui rassure quelqu'un qui vient de cliquer —, et la
 * confirmation est attendue du salon — c'est ce qui nomme l'acteur, pour que la
 * cliente ne se croie pas redevable d'un geste.
 *
 * ## Il annonce le second message, depuis #800
 *
 * « Vous recevrez un message dès que ce sera fait » n'était pas écrit tant
 * qu'aucun message ne partait à la confirmation : c'eût été remplacer une phrase
 * fausse par une autre. `APPOINTMENT_CONFIRMED` part désormais quand le salon
 * confirme, et la phrase est devenue vraie — elle dit à la cliente qu'elle n'a
 * rien à surveiller.
 *
 * Il ne promet toujours **aucun délai** : l'API n'en expose pas, et le salon
 * confirme quand il le fait.
 *
 * Le SMS, lui, ne l'annonce pas : il coûte déjà 152 septets sur 160, et la
 * phrase le ferait passer à deux segments. Le second message suffit à la dire.
 */
const BOOKING_CONFIRMATION_EMAIL_FR: NotificationTemplateSource = {
  subject: 'À confirmer par le salon : votre rendez-vous du {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>Votre rendez-vous chez {{salon}} est enregistré. Il reste à confirmer par le salon : ' +
      'vous recevrez un message dès que ce sera fait.</p>',
    `<table role="presentation">${HTML_SUMMARY_FR}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}.</p>',
    '<p><a href="{{lien_annulation}}">Modifier ou annuler mon rendez-vous</a></p>',
    '<p>À bientôt,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour {{client}},',
    '',
    'Votre rendez-vous chez {{salon}} est enregistré. Il reste à confirmer par le salon : vous recevrez un message dès que ce sera fait.',
    '',
    TEXT_SUMMARY_FR,
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
 * ## Il portait le même mot faux que l'e-mail — #911
 *
 * « rendez-vous confirmé le … » disait de ce rendez-vous `PENDING` exactement ce
 * que l'objet de l'e-mail en disait. Le corriger d'un côté seulement aurait
 * laissé partir, sur le même événement, deux messages qui se contredisent — et
 * le SMS est celui des deux qu'on lit sans l'ouvrir.
 *
 * Il dit donc les deux mêmes choses que l'e-mail, en une phrase : enregistré, à
 * confirmer par le salon.
 *
 * ## La capitale `À` n'existe pas en GSM-7, la minuscule si
 *
 * L'alphabet GSM 03.38 de base connaît `à`, `é` et `è`, mais de ses voyelles
 * accentuées capitales il ne garde que `É`. Écrire ici « À confirmer », comme le
 * fait le libellé du front, aurait basculé le message entier en UCS-2 et
 * **doublé son coût** (notifications §5) — d'où la minuscule, obtenue en plaçant
 * la locution en seconde partie de phrase plutôt qu'en tête.
 *
 * Mesuré sur le rendu de référence — dont le nom de salon vaut le pire cas de
 * 40 caractères —, le modèle coûte 152 septets : **un** segment, et
 * `notification-template.spec.ts` le vérifie plutôt que de l'espérer.
 *
 * ## Ce que cette mesure ne couvre pas : la longueur de `{{fuseau}}`
 *
 * La référence porte `Indian/Antananarivo`, dix-neuf caractères — un fuseau
 * « parmi les plus longs », mais pas le plus long : `America/Argentina/Buenos_Aires`
 * en fait trente, et `America/Argentina/ComodRivadavia` trente-deux. Le message
 * reformulé y coûte 163 à 165 septets, c'est-à-dire **deux** segments, sans que
 * la suite rougisse — elle mesure sur la référence, pas sur le fuseau du salon.
 *
 * Les huit septets de marge qui restent ici sont donc une marge réelle, pas une
 * garantie : avant #911 le modèle en coûtait 123 et absorbait n'importe quel
 * fuseau IANA. Le jour où un établissement d'un tel fuseau s'inscrit, c'est
 * `REFERENCE_ZONE` qu'il faut porter au pire cas — et les modèles de SMS de la
 * plateforme qu'il faut alors raccourcir, dans les deux langues.
 */
const BOOKING_CONFIRMATION_SMS_FR: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rendez-vous du {{date}} ({{fuseau}}) enregistré, à confirmer par le salon.',
};

/**
 * « Votre rendez-vous est confirmé » — #800.
 *
 * Le pendant de `BOOKING_CONFIRMATION`, et il dit ce que l'autre ne pouvait pas
 * dire : le salon a regardé la demande, et il attend la cliente. C'est ce que la
 * cliente attendait depuis la réservation, et la seule chose que ce message a à
 * lui apprendre — le reste, elle l'a déjà reçu.
 *
 * Il porte pourtant le récapitulatif entier, référence en tête, pour la raison
 * qui le fait porter au rappel J-1 : c'est ce message-ci que la cliente
 * gardera, parce que c'est celui qui dit « confirmé ». Le premier, qui dit « à
 * confirmer », cesse d'être vrai à l'instant où celui-ci part.
 *
 * ## Il nomme le salon comme auteur
 *
 * « {{salon}} a confirmé » et non « votre rendez-vous a été confirmé » : le
 * premier message a nommé le salon comme celui qui confirmerait, celui-ci dit
 * que c'est fait, par lui. Un passif aurait laissé croire à une validation
 * automatique, ce qu'elle n'est pas.
 *
 * ## Il est relu avant de partir
 *
 * `NotificationDispatchService` ne l'expédie que si le rendez-vous est encore
 * `CONFIRMED` et pas encore commencé. Une confirmation suivie d'une annulation
 * dans la minute ne fait donc pas partir « confirmé » après « annulé ».
 */
const APPOINTMENT_CONFIRMED_EMAIL_FR: NotificationTemplateSource = {
  subject: 'Rendez-vous confirmé : le {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>{{salon}} a confirmé votre rendez-vous. Nous vous attendons le {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_FR}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}.</p>',
    '<p><a href="{{lien_annulation}}">Modifier ou annuler mon rendez-vous</a></p>',
    '<p>À bientôt,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour {{client}},',
    '',
    '{{salon}} a confirmé votre rendez-vous. Nous vous attendons le {{date}}.',
    '',
    TEXT_SUMMARY_FR,
    'Les horaires sont donnés à l’heure de {{fuseau}}.',
    '',
    'Modifier ou annuler mon rendez-vous : {{lien_annulation}}',
    '',
    'À bientôt,',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS de confirmation par le salon — l'avis, et rien d'autre, comme les
 * autres.
 *
 * Tout y est en GSM-7 — le `é` de « confirmé » compris —, et il tient en un
 * segment sur le rendu de référence : `notification-template.spec.ts` le
 * mesure plutôt que de l'espérer.
 */
const APPOINTMENT_CONFIRMED_SMS_FR: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : votre rendez-vous du {{date}} ({{fuseau}}) est confirmé.',
};

/**
 * « Votre rendez-vous a été déplacé » — part sur `appointment.rescheduled`.
 *
 * Un report annule l'ancien rendez-vous et en crée un nouveau (booking-engine
 * §5) : ni la réservation ni l'annulation ne partent, et la cliente dont le salon
 * déplaçait le rendez-vous depuis le planning n'en apprenait rien — elle se
 * présentait à l'ancienne heure. Demande du PO du 21/09.
 *
 * ## Il ne dit pas qui a déplacé
 *
 * Le report part des deux côtés du comptoir — l'espace de la cliente, le
 * planning du salon —, et l'événement ne distingue pas l'un de l'autre. Le
 * passif « a été déplacé » est juste dans les deux cas : c'est une
 * confirmation pour celle qui vient de le faire, une information pour celle
 * dont le salon l'a fait.
 *
 * ## Il porte le récapitulatif entier
 *
 * Pour la raison du message de confirmation : c'est celui-ci que la cliente
 * gardera, parce que c'est le seul qui porte la **nouvelle** heure. Le
 * récapitulatif est celui du rendez-vous neuf — référence comprise, qui change
 * avec lui.
 *
 * ## Il est relu avant de partir
 *
 * `NotificationDispatchService` ne l'expédie que si le rendez-vous neuf occupe
 * encore son créneau et n'a pas commencé : deux reports enchaînés ne font pas
 * arriver l'heure intermédiaire après la dernière.
 */
const APPOINTMENT_RESCHEDULED_EMAIL_FR: NotificationTemplateSource = {
  subject: 'Rendez-vous déplacé au {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>Votre rendez-vous chez {{salon}} a été déplacé. Nous vous attendons désormais le {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_FR}</table>`,
    '<p>Les horaires sont donnés à l’heure de {{fuseau}}.</p>',
    '<p><a href="{{lien_annulation}}">Modifier ou annuler mon rendez-vous</a></p>',
    '<p>À bientôt,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour {{client}},',
    '',
    'Votre rendez-vous chez {{salon}} a été déplacé. Nous vous attendons désormais le {{date}}.',
    '',
    TEXT_SUMMARY_FR,
    'Les horaires sont donnés à l’heure de {{fuseau}}.',
    '',
    'Modifier ou annuler mon rendez-vous : {{lien_annulation}}',
    '',
    'À bientôt,',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS de report — l'avis, et rien d'autre : la nouvelle heure. Tout y est en
 * GSM-7 — les `é` compris —, et `notification-template.spec.ts` le mesure à un
 * segment plutôt que de l'espérer.
 */
const APPOINTMENT_RESCHEDULED_SMS_FR: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : votre rendez-vous est déplacé au {{date}} ({{fuseau}}).',
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
const REMINDER_EMAIL_FR: NotificationTemplateSource = {
  subject: 'Rappel : votre rendez-vous du {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour {{client}},</p>',
    '<p>Nous vous attendons chez {{salon}} le {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_FR}</table>`,
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
    TEXT_SUMMARY_FR,
    'Les horaires sont donnés à l’heure de {{fuseau}}.',
    '',
    'Un empêchement ? Annulez ou déplacez votre rendez-vous : {{lien_annulation}}',
    '',
    'À très bientôt,',
    '{{salon}}',
  ].join('\n'),
};

/** Le SMS de rappel — même économie que celui de la confirmation. */
const REMINDER_SMS_FR: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rappel de votre rendez-vous le {{date}} ({{fuseau}}).',
};

/**
 * Le récapitulatif d'un rendez-vous **annulé**, en lignes de tableau HTML.
 *
 * Il diffère de `HTML_SUMMARY_FR` sur deux points, et les deux tiennent au fait
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
const CANCELLATION_HTML_SUMMARY_FR =
  '<tr><th align="left">Client</th><td>{{client}}</td></tr>' +
  '<tr><th align="left">Prestation</th><td>{{service}}</td></tr>' +
  '<tr><th align="left">Avec</th><td>{{praticien}}</td></tr>' +
  '<tr><th align="left">Date</th><td>{{date}}</td></tr>' +
  '{{#telephone}}<tr><th align="left">Téléphone du salon</th><td>{{telephone}}</td></tr>{{/telephone}}';

/** Le même récapitulatif en texte brut — même grammaire de sections. */
const CANCELLATION_TEXT_SUMMARY_FR = [
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
 * « Bonjour, » et non « Bonjour {{client}}, ». Le modèle est unique par canal et
 * par langue — l'unique de `notification_templates` est
 * `(tenant_id, type, channel, locale)` — et il part aussi bien à la cliente qu'au
 * praticien. Le nom de la cliente est donc dans le récapitulatif, où il est une
 * **information** pour l'un et une confirmation pour l'autre, et non dans la
 * salutation, où il aurait salué le praticien du nom de sa cliente.
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
const CANCELLATION_EMAIL_FR: NotificationTemplateSource = {
  subject: 'Annulation du rendez-vous du {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour,</p>',
    '<p>Le rendez-vous ci-dessous chez {{salon}} a été annulé{{#origine}} {{origine}}{{/origine}}.</p>',
    `<table role="presentation">${CANCELLATION_HTML_SUMMARY_FR}</table>`,
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
    CANCELLATION_TEXT_SUMMARY_FR,
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
 * Le SMS d'annulation — même économie que les autres.
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
const CANCELLATION_SMS_FR: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}} : rendez-vous du {{date}} ({{fuseau}}) annulé{{#origine}} {{origine}}{{/origine}}.',
};

/**
 * Le lien de réinitialisation d'un mot de passe — #809, quatrième critère.
 *
 * ## Il ne salue personne par son nom, et il ne nomme aucun compte
 *
 * « Bonjour, » et non « Bonjour {{client}}, ». Le message part à l'adresse
 * demandée, et rien ne garantit que la personne qui la relève soit celle qui a
 * demandé : une boîte partagée, une adresse professionnelle mutualisée, une
 * demande faite par erreur sur l'adresse d'autrui. Y écrire le nom du titulaire
 * du compte aurait fait de cet e-mail une réponse à la question « qui possède un
 * compte à cette adresse ? » — la même divulgation que la réponse 202 uniforme
 * de la route existe pour empêcher. Le message dit « un compte », jamais « votre
 * compte de Mme Untel ».
 *
 * Il ne nomme pas non plus le rôle. Le lien, lui, pointe vers l'écran qui
 * correspond — c'est le rendu qui le compose — mais l'écrire en clair aurait dit
 * à qui relève l'adresse que ce compte administre le salon.
 *
 * ## Il dit ce qu'il faut faire, et ce qu'il faut faire si on n'a rien demandé
 *
 * Deux paragraphes, et le second n'est pas une politesse : quelqu'un qui reçoit
 * ce courrier sans l'avoir demandé doit savoir que **rien n'a changé** et qu'il
 * n'a rien à faire. Sans cette phrase, le réflexe est de cliquer pour « vérifier »
 * — c'est-à-dire d'ouvrir le lien qu'on voulait justement laisser mourir.
 *
 * ## Il annonce les trente minutes
 *
 * En clair et en toutes lettres, parce que c'est court : un lien réclamé le soir
 * et ouvert le lendemain matin échouera, et une personne qui n'a plus accès à
 * son compte n'a pas à deviner pourquoi. La durée est **écrite** dans le modèle
 * plutôt que substituée par une variable : `PASSWORD_RESET_TOKEN_TTL_SECONDS`
 * vit dans `identity`, ce module n'en dépend pas, et une variable de gabarit de
 * plus n'aurait servi qu'à ce seul texte. La contrepartie est explicite — changer
 * la durée demande de reprendre cette phrase **dans les deux langues**, et c'est
 * écrit ici pour qu'on le sache.
 *
 * ## Aucun `{{fuseau}}`
 *
 * Il n'annonce aucune heure, donc il n'a pas à nommer de fuseau. C'est le seul
 * des cinq messages dans ce cas, et c'est ce qui le distingue le plus
 * nettement des quatre autres : il ne parle pas d'un rendez-vous.
 */
const PASSWORD_RESET_EMAIL_FR: NotificationTemplateSource = {
  subject: 'Réinitialisation de votre mot de passe — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    '<p>Bonjour,</p>',
    '<p>Une réinitialisation de mot de passe a été demandée pour un compte {{salon}} ' +
      'associé à cette adresse.</p>',
    '<p><a href="{{lien_mot_de_passe}}">Choisir un nouveau mot de passe</a></p>',
    '<p>Ce lien est valable <strong>trente minutes</strong> et ne peut servir qu’une fois.</p>',
    '<p>Si vous n’avez rien demandé, ignorez ce message : votre mot de passe reste inchangé, ' +
      'et personne ne peut accéder à votre compte sans ce lien.</p>',
    '<p>{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Bonjour,',
    '',
    'Une réinitialisation de mot de passe a été demandée pour un compte {{salon}} associé à cette adresse.',
    '',
    'Choisir un nouveau mot de passe : {{lien_mot_de_passe}}',
    '',
    'Ce lien est valable trente minutes et ne peut servir qu’une fois.',
    '',
    'Si vous n’avez rien demandé, ignorez ce message : votre mot de passe reste inchangé, et personne ne peut accéder à votre compte sans ce lien.',
    '',
    '{{salon}}',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Anglais — #854
// ---------------------------------------------------------------------------

/**
 * Le récapitulatif anglais — même structure de lignes, mêmes sections.
 *
 * Les libellés sont ceux qu'emploie un salon nord-américain : `Service` plutôt
 * que `Treatment`, `With` pour le praticien, `Ends` pour la fin prévue. Ce sont
 * des mots courts, et c'est délibéré — la colonne d'un tableau d'e-mail se lit
 * sur un téléphone, où une étiquette qui déborde repousse la valeur d'une ligne.
 */
const HTML_SUMMARY_EN =
  '<tr><th align="left">Reference</th><td>{{reference}}</td></tr>' +
  '<tr><th align="left">Service</th><td>{{service}}</td></tr>' +
  '<tr><th align="left">With</th><td>{{praticien}}</td></tr>' +
  '<tr><th align="left">Date</th><td>{{date}}</td></tr>' +
  '<tr><th align="left">Ends</th><td>{{fin}}</td></tr>' +
  '<tr><th align="left">Price</th><td>{{prix}}</td></tr>' +
  '{{#adresse}}<tr><th align="left">Address</th><td>{{adresse}}</td></tr>{{/adresse}}' +
  '{{#telephone}}<tr><th align="left">Phone</th><td>{{telephone}}</td></tr>{{/telephone}}';

/** Le même récapitulatif en texte brut — les sections emportent leur saut de ligne. */
const TEXT_SUMMARY_EN = [
  'Reference: {{reference}}',
  'Service: {{service}}',
  'With: {{praticien}}',
  'Date: {{date}}',
  'Ends: {{fin}}',
  'Price: {{prix}}',
  '{{#adresse}}Address: {{adresse}}',
  '{{/adresse}}{{#telephone}}Phone: {{telephone}}',
  '{{/telephone}}',
].join('\n');

/**
 * La confirmation de réservation, en anglais.
 *
 * Elle dit les mêmes deux choses que sa jumelle française, dans le même ordre :
 * la réservation est enregistrée, et c'est le salon qui doit la confirmer. « The
 * salon still has to confirm it » nomme l'acteur, exactement comme « il reste à
 * confirmer par le salon » — un passif (« it is awaiting confirmation ») aurait
 * laissé la cliente se croire redevable d'un geste.
 *
 * L'heure est **toujours** suivie de son fuseau, ici aussi : « 2:30 PM » sans
 * mention est tout aussi ambigu que « 14:30 » pour qui voyage, et ce produit
 * sert une clientèle qui traverse des fuseaux.
 */
const BOOKING_CONFIRMATION_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Awaiting confirmation: your appointment on {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello {{client}},</p>',
    '<p>Your appointment at {{salon}} is booked. The salon still has to confirm it: ' +
      'you will receive a message as soon as that is done.</p>',
    `<table role="presentation">${HTML_SUMMARY_EN}</table>`,
    '<p>Times are shown in {{fuseau}} time.</p>',
    '<p><a href="{{lien_annulation}}">Change or cancel my appointment</a></p>',
    '<p>See you soon,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello {{client}},',
    '',
    'Your appointment at {{salon}} is booked. The salon still has to confirm it: you will receive a message as soon as that is done.',
    '',
    TEXT_SUMMARY_EN,
    'Times are shown in {{fuseau}} time.',
    '',
    'Change or cancel my appointment: {{lien_annulation}}',
    '',
    'See you soon,',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS de confirmation, en anglais.
 *
 * Tout y est en ASCII, donc en GSM-7 : l'anglais n'a pas le problème d'accents
 * qui contraint la formulation française, et aucune de ses phrases ne peut à elle
 * seule doubler la facture. Ce qui le contraint est la **longueur** — la date
 * anglaise fait six caractères de plus que la française — et c'est
 * `notification-default-templates.spec.ts` qui le mesure, sur le même rendu de
 * référence et contre la même borne que les modèles français : c'est le septième
 * critère d'acceptation de #854.
 */
const BOOKING_CONFIRMATION_SMS_EN: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}}: appointment on {{date}} ({{fuseau}}) booked, awaiting confirmation.',
};

/** « Votre rendez-vous est confirmé », en anglais — le salon est nommé comme auteur. */
const APPOINTMENT_CONFIRMED_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Appointment confirmed: {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello {{client}},</p>',
    '<p>{{salon}} has confirmed your appointment. We look forward to seeing you on {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_EN}</table>`,
    '<p>Times are shown in {{fuseau}} time.</p>',
    '<p><a href="{{lien_annulation}}">Change or cancel my appointment</a></p>',
    '<p>See you soon,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello {{client}},',
    '',
    '{{salon}} has confirmed your appointment. We look forward to seeing you on {{date}}.',
    '',
    TEXT_SUMMARY_EN,
    'Times are shown in {{fuseau}} time.',
    '',
    'Change or cancel my appointment: {{lien_annulation}}',
    '',
    'See you soon,',
    '{{salon}}',
  ].join('\n'),
};

/** Le SMS de confirmation par le salon, en anglais. */
const APPOINTMENT_CONFIRMED_SMS_EN: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}}: your appointment on {{date}} ({{fuseau}}) is confirmed.',
};

/**
 * « Votre rendez-vous a été déplacé », en anglais.
 *
 * Le passif y est aussi délibéré qu'en français — « has been moved » ne nomme
 * personne, et le report part des deux côtés du comptoir : c'est une
 * confirmation pour celle qui vient de le faire, une information pour celle
 * dont le salon l'a fait.
 *
 * Il porte le récapitulatif entier, pour la même raison : c'est le seul message
 * qui donne la **nouvelle** heure, et c'est donc celui que la cliente gardera.
 */
const APPOINTMENT_RESCHEDULED_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Appointment moved to {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello {{client}},</p>',
    '<p>Your appointment at {{salon}} has been moved. We now look forward to seeing you on {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_EN}</table>`,
    '<p>Times are shown in {{fuseau}} time.</p>',
    '<p><a href="{{lien_annulation}}">Change or cancel my appointment</a></p>',
    '<p>See you soon,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello {{client}},',
    '',
    'Your appointment at {{salon}} has been moved. We now look forward to seeing you on {{date}}.',
    '',
    TEXT_SUMMARY_EN,
    'Times are shown in {{fuseau}} time.',
    '',
    'Change or cancel my appointment: {{lien_annulation}}',
    '',
    'See you soon,',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS de report, en anglais — l'avis, et rien d'autre : la nouvelle heure.
 *
 * Tout y est en ASCII, donc en GSM-7, et c'est la **longueur** qui le contraint :
 * la date anglaise du rendu de référence est plus longue que la française. C'est
 * `notification-default-templates.spec.ts` qui le mesure, contre la même borne
 * que son jumeau français — septième critère d'acceptation de #854.
 */
const APPOINTMENT_RESCHEDULED_SMS_EN: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}}: your appointment is moved to {{date}} ({{fuseau}}).',
};

/**
 * Le rappel J-1, en anglais.
 *
 * Il ne dit pas « tomorrow », pour la raison qui fait que le français ne dit pas
 * « demain » : le rappel part entre 24 et 25 heures avant, ce qui tombe presque
 * toujours la veille — et « presque toujours » n'est pas une garantie qu'un
 * modèle a le droit de prendre.
 *
 * La seconde phrase est sa raison d'être, ici comme en français : une annulation
 * la veille libère un créneau que le salon peut encore vendre.
 */
const REMINDER_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Reminder: your appointment on {{date}} — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello {{client}},</p>',
    '<p>We look forward to seeing you at {{salon}} on {{date}}.</p>',
    `<table role="presentation">${HTML_SUMMARY_EN}</table>`,
    '<p>Times are shown in {{fuseau}} time.</p>',
    '<p>Something came up? <a href="{{lien_annulation}}">Cancel or reschedule your appointment</a> — ' +
      'it frees the slot for someone else.</p>',
    '<p>See you very soon,<br />{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello {{client}},',
    '',
    'We look forward to seeing you at {{salon}} on {{date}}.',
    '',
    TEXT_SUMMARY_EN,
    'Times are shown in {{fuseau}} time.',
    '',
    'Something came up? Cancel or reschedule your appointment: {{lien_annulation}}',
    '',
    'See you very soon,',
    '{{salon}}',
  ].join('\n'),
};

/** Le SMS de rappel, en anglais — même économie que celui de la confirmation. */
const REMINDER_SMS_EN: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}}: reminder of your appointment on {{date}} ({{fuseau}}).',
};

/** Le récapitulatif d'un rendez-vous annulé, en anglais — il nomme la cliente. */
const CANCELLATION_HTML_SUMMARY_EN =
  '<tr><th align="left">Client</th><td>{{client}}</td></tr>' +
  '<tr><th align="left">Service</th><td>{{service}}</td></tr>' +
  '<tr><th align="left">With</th><td>{{praticien}}</td></tr>' +
  '<tr><th align="left">Date</th><td>{{date}}</td></tr>' +
  '{{#telephone}}<tr><th align="left">Salon phone</th><td>{{telephone}}</td></tr>{{/telephone}}';

/** Le même récapitulatif en texte brut. */
const CANCELLATION_TEXT_SUMMARY_EN = [
  'Client: {{client}}',
  'Service: {{service}}',
  'With: {{praticien}}',
  'Date: {{date}}',
  '{{#telephone}}Salon phone: {{telephone}}',
  '{{/telephone}}',
].join('\n');

/**
 * L'avis d'annulation, en anglais.
 *
 * Il ne salue personne par son nom — « Hello, » et non « Hello {{client}}, » —
 * pour la raison qui vaut en français : le modèle est unique par canal et par
 * langue, et il part aussi bien à la cliente qu'au praticien.
 *
 * `{{#origine}}` et `{{#destinataire_client}}` jouent exactement le même rôle
 * que dans le modèle français, et pour les mêmes raisons : l'origine s'efface si
 * elle est vide, et « Book a new appointment » ne s'affiche que pour la cliente —
 * un praticien y serait renvoyé vers un espace qui n'est pas son agenda.
 */
const CANCELLATION_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Appointment on {{date}} cancelled — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello,</p>',
    '<p>The appointment below at {{salon}} has been cancelled{{#origine}} {{origine}}{{/origine}}.</p>',
    `<table role="presentation">${CANCELLATION_HTML_SUMMARY_EN}</table>`,
    '<p>Times are shown in {{fuseau}} time. The slot is available again.</p>',
    '{{#destinataire_client}}<p><a href="{{lien_annulation}}">Book a new appointment</a></p>{{/destinataire_client}}',
    '<p>{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello,',
    '',
    'The appointment below at {{salon}} has been cancelled{{#origine}} {{origine}}{{/origine}}.',
    '',
    CANCELLATION_TEXT_SUMMARY_EN,
    'Times are shown in {{fuseau}} time. The slot is available again.',
    // La ligne vide est **dans** la section, comme en français : sans cela, un
    // avis au praticien aurait laissé deux lignes vides à la place du lien.
    '{{#destinataire_client}}',
    'Book a new appointment: {{lien_annulation}}',
    '{{/destinataire_client}}',
    '{{salon}}',
  ].join('\n'),
};

/**
 * Le SMS d'annulation, en anglais.
 *
 * C'est le plus long des quatre modèles de SMS anglais, parce qu'il porte
 * l'origine sous section et que la plus longue des trois — « automatically by the
 * system » — s'ajoute à une date déjà plus longue qu'en français. Il tient
 * malgré tout en un segment sur le rendu de référence, et la suite le mesure
 * plutôt que de l'espérer.
 */
const CANCELLATION_SMS_EN: NotificationTemplateSource = {
  subject: '',
  html: '',
  text: '{{salon}}: appointment on {{date}} ({{fuseau}}) cancelled{{#origine}} {{origine}}{{/origine}}.',
};

/**
 * Le lien de réinitialisation d'un mot de passe, en anglais.
 *
 * Même discipline que la version française, et ce n'est pas une question de
 * style : il ne salue personne par son nom et ne nomme aucun compte — « an
 * account », jamais « your account » suivi d'un nom —, parce que rien ne garantit
 * que la personne qui relève l'adresse soit celle qui a demandé. Il annonce les
 * trente minutes en toutes lettres, et il dit quoi faire si on n'a rien demandé :
 * rien.
 */
const PASSWORD_RESET_EMAIL_EN: NotificationTemplateSource = {
  subject: 'Reset your password — {{salon}}',
  html: [
    '<!DOCTYPE html>',
    '<html lang="en"><body>',
    '<p>Hello,</p>',
    '<p>A password reset was requested for a {{salon}} account linked to this address.</p>',
    '<p><a href="{{lien_mot_de_passe}}">Choose a new password</a></p>',
    '<p>This link is valid for <strong>thirty minutes</strong> and can only be used once.</p>',
    '<p>If you did not request it, ignore this message: your password is unchanged, ' +
      'and no one can access your account without this link.</p>',
    '<p>{{salon}}</p>',
    '</body></html>',
  ].join(''),
  text: [
    'Hello,',
    '',
    'A password reset was requested for a {{salon}} account linked to this address.',
    '',
    'Choose a new password: {{lien_mot_de_passe}}',
    '',
    'This link is valid for thirty minutes and can only be used once.',
    '',
    'If you did not request it, ignore this message: your password is unchanged, and no one can access your account without this link.',
    '',
    '{{salon}}',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// La table
// ---------------------------------------------------------------------------

/** Les modèles d'une langue, par type puis par canal. */
type LocaleTemplates = Readonly<
  Partial<Record<NotificationType, Readonly<Partial<Record<NotificationChannel, NotificationTemplateSource>>>>>
>;

/**
 * Les modèles de la plateforme, par **langue**, puis par type, puis par canal.
 *
 * La langue vient en premier et non en dernier, et ce n'est pas un détail
 * d'écriture : la question que pose le rendu est « ai-je un défaut pour ce
 * message, dans cette langue ? », et l'indexation suit la question. Elle rend
 * aussi lisible d'un coup d'œil ce que la suite vérifie — que les deux langues
 * couvrent les mêmes couples.
 *
 * La structure reste **partielle** à chaque étage — `Partial<Record<…>>` — et
 * `defaultTemplateFor` continue de rendre `null` : une entrée absente veut dire
 * « aucun modèle par défaut », et non « modèle vide ». C'est la forme qui
 * accueillera un message de plus sans que le renderer ait à changer, et c'est
 * elle qui garantit qu'un type ajouté à l'énumération sans ses modèles échoue en
 * `FAILED` plutôt que de partir vide.
 */
export const DEFAULT_TEMPLATES: Readonly<Record<Locale, LocaleTemplates>> = {
  fr: {
    BOOKING_CONFIRMATION: {
      EMAIL: BOOKING_CONFIRMATION_EMAIL_FR,
      SMS: BOOKING_CONFIRMATION_SMS_FR,
    },
    REMINDER_24H: { EMAIL: REMINDER_EMAIL_FR, SMS: REMINDER_SMS_FR },
    CANCELLATION: { EMAIL: CANCELLATION_EMAIL_FR, SMS: CANCELLATION_SMS_FR },
    // **E-mail seulement**, et c'est le quatrième critère de #809 au mot près :
    // « modèle `password_reset`, canal e-mail ». Le SMS n'a délibérément pas de
    // défaut, et c'est la structure partielle de cette table qui le permet — un
    // couple absent se lit « aucun modèle par défaut », et `defaultTemplateFor`
    // rend `null`.
    //
    // Pourquoi pas de SMS : un lien de 66 caractères sur les 160 d'un segment ne
    // laisse rien pour la phrase qui dit quoi en faire, et un lien tronqué par un
    // opérateur est un lien mort. Surtout, un SMS ne prouve pas la possession de
    // l'**adresse** — or c'est bien l'adresse qui a été saisie dans le formulaire,
    // et c'est elle que la procédure vérifie.
    //
    // Un salon reste libre d'écrire le sien : `NotificationTemplatesService.save`
    // l'acceptera, et la variable `lien_mot_de_passe` du rendu de référence est là
    // pour que la mesure de coût le refuse s'il dépasse trois segments.
    PASSWORD_RESET: { EMAIL: PASSWORD_RESET_EMAIL_FR },
    APPOINTMENT_CONFIRMED: {
      EMAIL: APPOINTMENT_CONFIRMED_EMAIL_FR,
      SMS: APPOINTMENT_CONFIRMED_SMS_FR,
    },
    APPOINTMENT_RESCHEDULED: {
      EMAIL: APPOINTMENT_RESCHEDULED_EMAIL_FR,
      SMS: APPOINTMENT_RESCHEDULED_SMS_FR,
    },
  },
  en: {
    BOOKING_CONFIRMATION: {
      EMAIL: BOOKING_CONFIRMATION_EMAIL_EN,
      SMS: BOOKING_CONFIRMATION_SMS_EN,
    },
    REMINDER_24H: { EMAIL: REMINDER_EMAIL_EN, SMS: REMINDER_SMS_EN },
    CANCELLATION: { EMAIL: CANCELLATION_EMAIL_EN, SMS: CANCELLATION_SMS_EN },
    // Même absence délibérée qu'en français, et pour les mêmes raisons : la
    // couverture des deux langues doit être **identique**, sans quoi une cliente
    // perdrait un message en changeant de langue. C'est ce que la suite vérifie.
    PASSWORD_RESET: { EMAIL: PASSWORD_RESET_EMAIL_EN },
    APPOINTMENT_CONFIRMED: {
      EMAIL: APPOINTMENT_CONFIRMED_EMAIL_EN,
      SMS: APPOINTMENT_CONFIRMED_SMS_EN,
    },
    APPOINTMENT_RESCHEDULED: {
      EMAIL: APPOINTMENT_RESCHEDULED_EMAIL_EN,
      SMS: APPOINTMENT_RESCHEDULED_SMS_EN,
    },
  },
};

/**
 * Le modèle de plateforme pour ce message, dans cette langue, s'il en existe un.
 *
 * Le repli ne traverse **jamais** la frontière de langue : une langue sans
 * modèle rend `null`, et l'appelant échoue, plutôt que de servir l'autre langue.
 * C'est le quatrième critère d'acceptation de #854, et la raison en est qu'un
 * message dans une langue qu'on ne lit pas est pire qu'un message absent — il
 * fait croire qu'on a été prévenu.
 */
export function defaultTemplateFor(
  type: NotificationType,
  channel: NotificationChannel,
  locale: Locale,
): NotificationTemplateSource | null {
  return DEFAULT_TEMPLATES[locale][type]?.[channel] ?? null;
}
