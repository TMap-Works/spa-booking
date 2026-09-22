import { tenantPublicUrl, type Locale, type TenantUrlMode } from '@spa/shared';

import {
  SMS_TENANT_NAME_MAX,
  capSmsBody,
  escapeHtml,
  keepAsIs,
  measureSms,
  renderTemplateSource,
  type SmsCost,
  type TemplateVariables,
} from './notification-template';
import type { AppointmentCancelledBy } from '../appointments/appointment-status';
import type {
  AppointmentMessageContext,
  NotificationChannel,
  NotificationTemplateSource,
  PasswordResetMessageContext,
  RenderedNotification,
} from './notifications.types';

/**
 * Le pont entre un rendez-vous et un modèle — **fonctions pures**, sans Nest,
 * sans Prisma, sans horloge.
 *
 * ## Ce que ce fichier fait, depuis #69
 *
 * Il ne porte plus les modèles : ils sont en base par établissement
 * (`notification_templates`) et en code pour la plateforme
 * (`notification-default-templates.ts`). Ce qui reste ici est ce qu'aucun modèle
 * ne doit avoir à savoir faire — convertir un instant au fuseau du salon,
 * formater un montant entier en devise, composer le lien d'annulation — et
 * l'assemblage qui en tire les variables.
 *
 * La frontière est nette et elle est le point du ticket : **un modèle ne calcule
 * rien.** Il ne choisit pas de fuseau, ne divise pas un montant, ne compose pas
 * d'URL. Il nomme des valeurs déjà justes. C'est ce qui fait qu'un salon peut
 * réécrire ses messages sans pouvoir déplacer un rendez-vous de deux heures ni
 * publier un lien vers un domaine qu'il aurait choisi.
 *
 * ## Le fuseau du salon, et pourquoi `Intl` plutôt que `TenantClockService`
 *
 * CLAUDE.md est explicite : « tout est stocké en UTC, converti à l'affichage
 * selon le fuseau du tenant », et « un rendez-vous mal fuseau-horairé est un bug
 * de sévérité haute ». Un e-mail est un affichage, et le pire de tous — il
 * survit à l'écran, et la cliente s'y fie des jours plus tard.
 *
 * `TenantClockService` sait convertir, mais son `formatInTenantTime` rend un ISO
 * 8601 à décalage explicite (`2026-09-08T14:30:00+03:00`), destiné aux contrats,
 * pas à une lectrice. Il aurait fallu importer `AvailabilityModule` dans
 * `notifications` — donc coupler la chaîne de messages au moteur de
 * disponibilité — pour ensuite ne pas se servir du résultat. `Intl` est dans la
 * bibliothèque standard, c'est déjà ce qu'emploie `apps/web/lib/format.ts` pour
 * le même besoin, et le fuseau est validé à l'écriture côté `tenants.timezone`.
 */

/**
 * L'étiquette `Intl` de chaque langue du contrat — #854, troisième critère.
 *
 * ## Deux étiquettes, et non deux langues de plus
 *
 * `Locale` ne connaît que `fr` et `en` (#844, « pas de variantes régionales »),
 * mais `Intl` a besoin d'une région pour choisir un ordre de date et un
 * séparateur décimal : `en` seul se résout selon l'implémentation, et le même
 * rendez-vous s'écrirait « 16 September 2026 » sur une machine et
 * « September 16, 2026 » sur une autre. La région est donc **fixée ici**, une
 * fois, plutôt que subie.
 *
 * `en-US` parce que la clientèle du produit est nord-américaine — la même
 * décision du PO qui a fait de `en` la langue par défaut du système (#844,
 * `DEFAULT_LOCALE`).
 *
 * Ce n'est pas le fuseau ni la devise : ceux-là ont leurs propres colonnes sur
 * l'établissement, et une cliente anglophone d'un salon parisien lit bien ses
 * heures en `Europe/Paris` et ses prix en euros. La langue décide de l'**écriture**
 * — l'ordre des termes, le mot de liaison, l'horloge —, jamais du fond.
 */
const INTL_LOCALES: Readonly<Record<Locale, string>> = {
  fr: 'fr-FR',
  en: 'en-US',
};

/**
 * Le mot qui relie la date à l'heure, par langue.
 *
 * Composé à la main plutôt que laissé à `dateStyle: 'full'` + `timeStyle`, dont
 * le mot de liaison varie d'une version d'ICU à l'autre — la raison est d'origine
 * (#70) et elle vaut d'autant plus avec deux langues : un rendu qui change au gré
 * de l'image Docker ferait rougir les suites sans qu'aucun code ait bougé.
 */
const DATE_TIME_JOINERS: Readonly<Record<Locale, string>> = {
  fr: ' à ',
  en: ' at ',
};

/**
 * L'horloge de chaque langue.
 *
 * `h23` en français — « 14:30 », ce que le français attend. `h12` en anglais —
 * « 2:30 PM », ce qu'une cliente nord-américaine lit sur son propre agenda. Lui
 * servir « 14:30 » l'obligerait à compter, sur le message même qui existe pour
 * qu'elle n'ait rien à faire.
 */
const HOUR_CYCLES: Readonly<Record<Locale, 'h12' | 'h23'>> = {
  fr: 'h23',
  en: 'h12',
};

/**
 * Les espaces insécables qu'`Intl` glisse dans une heure, ramenées à l'espace
 * ordinaire.
 *
 * ## Ce que cela corrige, et ce que cela coûterait de ne pas le faire
 *
 * Depuis ICU 72, `en-US` sépare l'heure de son « AM »/« PM » par une **espace
 * fine insécable** (U+202F) là où les versions antérieures mettaient une espace
 * ordinaire. Ce caractère n'est pas dans l'alphabet GSM-7 : un SMS anglais qui
 * nomme `{{date}}` ou `{{heure}}` basculerait donc en UCS-2 — 70 caractères par
 * segment au lieu de 160, **le double de la facture** (notifications §5) — pour
 * une espace que personne ne distingue à l'écran d'un téléphone.
 *
 * Elle stabilise du même coup le rendu d'une version d'ICU à l'autre, ce que
 * `DATE_TIME_JOINERS` fait déjà pour le mot de liaison.
 *
 * ## Elle ne touche pas les montants
 *
 * `formatMoney` garde ses insécables, et c'est délibéré : « 1 250,00 MGA » n'a
 * de sens qu'avec elles — un montant coupé en fin de ligne entre ses milliers se
 * relit mal, et c'est précisément ce qu'une insécable empêche. Le coût est connu,
 * mesuré, et aucun modèle de plateforme ne nomme `{{prix}}` sur le canal SMS.
 */
function withPlainSpaces(value: string): string {
  // Écrites en échappement, faute d'être distinguables d'une espace ordinaire
  // à la lecture du fichier — et ce sont pourtant elles qui décident de
  // l'encodage, donc de la facture.
  return value.replaceAll('\u202f', ' ').replaceAll('\u00a0', ' ');
}

/**
 * « lundi 8 septembre 2026 à 14:30 » — l'instant, dans le fuseau du salon et
 * dans la langue de l'envoi.
 *
 * Le fuseau et la langue sont deux paramètres distincts, et c'est le troisième
 * critère d'acceptation de #854 au mot près : « les dates et heures du message
 * sont formatées dans la langue d'envoi **et** dans le fuseau de
 * l'établissement ». Une cliente anglophone d'un salon parisien lit
 * « Monday, September 8, 2026 at 2:30 PM » — l'heure de Paris, écrite en anglais.
 */
export function formatDateTimeInTenantTimeZone(
  instant: Date,
  timeZone: string,
  locale: Locale,
): string {
  const date = new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);

  return `${date}${DATE_TIME_JOINERS[locale]}${formatTimeInTenantTimeZone(instant, timeZone, locale)}`;
}

/** « 14:30 », ou « 2:30 PM » — l'heure seule, dans le fuseau du salon. */
export function formatTimeInTenantTimeZone(
  instant: Date,
  timeZone: string,
  locale: Locale,
): string {
  const cycle = HOUR_CYCLES[locale];

  return withPlainSpaces(
    new Intl.DateTimeFormat(INTL_LOCALES[locale], {
      timeZone,
      // `numeric` sur une horloge de 12 heures : « 2:30 PM » et non « 02:30 PM »,
      // qui n'est la convention de personne. Sur 24 heures, le zéro de tête est
      // au contraire ce que le français attend.
      hour: cycle === 'h12' ? 'numeric' : '2-digit',
      minute: '2-digit',
      hourCycle: cycle,
    }).format(instant),
  );
}

/**
 * Un montant, à partir de son entier en plus petite unité, dans la langue de
 * l'envoi.
 *
 * La division par 100 se fait **dans le formateur**, via `minimumFractionDigits`
 * appliqué à un quotient calculé une seule fois : la valeur ne circule jamais
 * comme flottant dans le domaine, elle n'est convertie que pour être écrite.
 * `Intl.NumberFormat` connaît le nombre de décimales de chaque devise, ce qu'une
 * division en dur par 100 ignorerait — le yen n'en a aucune.
 *
 * La **devise** ne dépend pas de la langue : elle vient de l'établissement, et
 * seul son écriture change — « 1 250,00 € » en français, « €1,250.00 » en
 * anglais. C'est la même somme, et c'est ce que le CDC exige (« montants en
 * entiers avec un code devise explicite »).
 */
export function formatMoney(amountMinor: number, currency: string, locale: Locale): string {
  const formatter = new Intl.NumberFormat(INTL_LOCALES[locale], { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

  return formatter.format(amountMinor / 10 ** digits);
}

/**
 * Le lien d'annulation — variable `{{lien_annulation}}`.
 *
 * ## Pourquoi cette adresse-là
 *
 * Il pointe l'espace client de l'établissement, où chaque rendez-vous à venir
 * porte son bouton « Annuler »
 * (`apps/web/app/(account)/[tenantSlug]/compte/components/appointment-card.tsx`).
 * C'est la seule surface web qui annule **durablement** : l'écran de
 * confirmation du tunnel de réservation le fait aussi, mais il vit dans le
 * `sessionStorage` de l'onglet et ne survit pas à sa fermeture — or un lien
 * d'e-mail est cliqué des jours plus tard, depuis un autre appareil.
 *
 * ## Il n'est pas une variable que le salon peut composer
 *
 * Le modèle nomme `{{lien_annulation}}`, il ne l'écrit pas. L'origine vient de
 * `AppConfigService.appUrl`, validée au démarrage, et le slug de la ligne
 * `tenants` — jamais d'un en-tête de requête, jamais d'un champ de formulaire.
 * C'est ce qui empêche qu'un modèle personnalisé devienne un vecteur
 * d'hameçonnage signé du nom du salon.
 *
 * ## Ce qu'il ne fait pas, et pourquoi c'est délibéré
 *
 * Il ne porte **aucun jeton d'annulation**. Composer une URL signée qui annule
 * en un clic aurait ajouté un secret à faire tourner, une durée de validité à
 * choisir, et une route publique de plus — pour un gain nul ici, puisque
 * l'espace client existe déjà et authentifie. Un lien d'annulation directe est
 * une décision de conception à part entière ; elle appartient à son issue, pas à
 * une ligne de modèle.
 *
 * ## Le sous-domaine, et le repli par chemin — #837
 *
 * L'arbitrage du PO du 16/09/2026 sert chaque salon sur `{slug}.{domaine}`
 * (#832) : le lien devient `https://maison-lotus.exemple.test/compte` là où il
 * était `https://exemple.test/maison-lotus/compte`. La composition est déléguée
 * à `tenantPublicUrl` du contrat partagé, qui applique à l'écriture la règle
 * d'hôte de base que `publicBaseHost` applique à la lecture — sans quoi un lien
 * d'e-mail pourrait tomber sur un hôte que le middleware ne sait pas relire.
 *
 * `mode` vaut `auto` par défaut, et c'est ce qui rend les environnements sans
 * sous-domaine sûrs sans configuration : sur `http://127.0.0.1:3001` ou
 * `http://localhost:3000`, aucun `maison-lotus.127.0.0.1` ne se résout, et le
 * constructeur retombe de lui-même sur la forme par chemin. Un e-mail de recette
 * reste donc cliquable. `PUBLIC_TENANT_URL_MODE` permet de forcer l'un ou
 * l'autre — voir `config/env.schema.ts`.
 */
export function cancellationUrl(
  appBaseUrl: string,
  tenantSlug: string,
  mode: TenantUrlMode = 'auto',
): string {
  return tenantPublicUrl(tenantSlug, '/compte', { baseUrl: appBaseUrl, mode });
}

/**
 * Les rôles internes à l'établissement, tels que `enum UserRole` les nomme —
 * `identity/roles.ts`, `STAFF_ROLES`.
 *
 * Recopiés et non importés : `identity` est le module qui authentifie, et
 * `notifications` n'en dépend pas (api-module §3). La liste est courte, close, et
 * un rôle qui n'y figurerait pas mène à l'écran client — le moins privilégié —
 * plutôt qu'à la console d'administration.
 */
const STAFF_RESET_ROLES: ReadonlySet<string> = new Set(['STAFF', 'MANAGER', 'ADMIN']);

/**
 * Le lien de réinitialisation d'un mot de passe — #809, quatrième critère.
 *
 * ## Deux écrans, et c'est le **rôle** qui tranche
 *
 * « Le lien pointe vers `/{slug}/admin/mot-de-passe` ou vers
 * `/{slug}/compte/mot-de-passe`, selon le rôle du compte » : le critère est
 * littéral, et la raison est qu'un praticien envoyé sur l'espace client se
 * retrouverait, après avoir choisi son mot de passe, sur un écran qui n'est pas
 * son agenda — et réciproquement, une cliente sur une console d'administration
 * qu'elle n'a pas le droit d'ouvrir.
 *
 * Le rôle est lu **en base au moment du rendu**, jamais porté par le jeton : un
 * rôle figé à l'émission enverrait une praticienne promue entre la demande et le
 * clic vers le mauvais écran. C'est le même raisonnement que celui qui interdit
 * à `InvitationTokenClaims` de porter un `role`.
 *
 * ## Le jeton est dans le **fragment de requête**, et le chemin est public
 *
 * L'écran qui reçoit ce lien est public — il doit l'être, la personne n'ayant
 * plus de session. Le jeton voyage donc en paramètre de requête, seule forme
 * qu'un lien cliquable depuis un client mail sache transporter.
 *
 * `encodeURIComponent` n'est pas une précaution de forme : un JWT est en
 * base64url, qui ne contient ni `&` ni `=` hors du remplissage, mais c'est
 * exactement le genre d'invariant qu'on ne veut pas faire dépendre de
 * l'encodage d'un signataire. Un jeton mal échappé produirait un lien tronqué au
 * premier `&`, donc un refus en 401 que personne ne saurait expliquer.
 *
 * ## L'origine vient de la configuration, comme celle du lien d'annulation
 *
 * Tout ce que dit l'en-tête de `cancellationUrl` vaut ici, et vaut davantage :
 * ce lien-ci **ouvre un compte**. Une origine tirée d'un en-tête `Host` entrant
 * en aurait fait le vecteur d'hameçonnage le plus efficace que ce produit puisse
 * offrir — un courrier signé du nom du salon, qui demande un mot de passe, sur
 * un domaine choisi par l'attaquant.
 */
export function passwordResetUrl(
  appBaseUrl: string,
  tenantSlug: string,
  role: string,
  token: string,
  mode: TenantUrlMode = 'auto',
): string {
  // `isStaffRole` vit dans `identity` et ce module n'en dépend pas : la
  // comparaison se fait sur les valeurs d'énumération, qui sont celles du schéma.
  //
  // Les rôles internes sont **énumérés**, et le défaut est l'espace client — le
  // rôle le moins privilégié. C'est ce que l'écriture inverse (`role === 'CLIENT'
  // ? client : admin`) promettait sans le tenir : elle envoyait vers la console
  // d'administration toute valeur qu'elle ne reconnaissait pas, y compris un rôle
  // ajouté à l'énumération sans que ce fichier soit revu, et y compris une faute
  // de frappe. Un rôle inconnu doit mener à l'écran qui ne suppose aucun droit.
  const path = STAFF_RESET_ROLES.has(role) ? '/admin/mot-de-passe' : '/compte/mot-de-passe';

  return `${tenantPublicUrl(tenantSlug, path, { baseUrl: appBaseUrl, mode })}?jeton=${encodeURIComponent(token)}`;
}

/**
 * Les variables d'un lien de réinitialisation — #809.
 *
 * ## Deux valeurs renseignées, toutes les autres **vides**
 *
 * `TemplateVariables` est un `Record` complet par construction : la liste des
 * variables est close, et le rendu substitue ce qu'il trouve. Un message qui
 * n'annonce aucun rendez-vous n'a donc rien à mettre dans `date`, `service` ou
 * `prix` — et les laisser vides est exactement ce qui rend leur emploi en
 * section inoffensif, comme `origine` l'est sur une confirmation.
 *
 * Ce n'est pas une lacune qu'on comble par des valeurs de repli : écrire
 * « aucune » dans `service` aurait produit, sur le modèle d'un salon qui nomme
 * cette variable par erreur, une phrase fausse plutôt qu'une phrase incomplète.
 *
 * ## `salon` est écourté sur le canal SMS, comme ailleurs
 *
 * La plateforme n'envoie ce message que par e-mail, mais un salon peut écrire
 * son propre modèle de SMS : la règle d'écourtement doit donc s'appliquer ici
 * aussi, faute de quoi le seul chemin par lequel un nom de salon de 160
 * caractères entre dans un segment serait celui-là.
 */
export function buildPasswordResetVariables(
  context: PasswordResetMessageContext,
  resetUrl: string,
  channel: NotificationChannel,
): TemplateVariables {
  return {
    client: '',
    reference: '',
    service: '',
    praticien: '',
    salon: channel === 'SMS' ? shortenForSms(context.tenantName) : context.tenantName,
    adresse: '',
    telephone: '',
    date: '',
    heure: '',
    fin: '',
    fuseau: '',
    prix: '',
    lien_annulation: '',
    origine: '',
    destinataire_client: '',
    lien_mot_de_passe: resetUrl,
  };
}

/** Le nom d'usage de la cliente, tel qu'un message l'emploie. */
function clientName(context: AppointmentMessageContext): string {
  return `${context.clientFirstName} ${context.clientLastName}`.trim();
}

/**
 * D'où vient l'annulation, en toutes lettres — variable `{{origine}}`, troisième
 * critère d'acceptation de #72.
 *
 * ## Trois formulations, et aucune ne s'adresse à quelqu'un
 *
 * « à la demande du client » et non « à votre demande » : le modèle
 * `CANCELLATION` est **unique par canal** et sert les deux destinataires que le
 * CDC §1.4 nomme — la cliente et le praticien. Une formulation à la deuxième
 * personne aurait donc été fausse pour l'un des deux à chaque envoi, et c'est
 * exactement le genre de faute qu'une cliente relit des jours plus tard dans sa
 * boîte.
 *
 * `SYSTEM` n'est émis par aucune surface aujourd'hui — seuls le tunnel public
 * (`CLIENT`) et le back-office (`STAFF`) annulent — mais il est dans
 * `CANCELLATION_AUTHORS`, donc dans ce que la colonne peut contenir. Lui donner
 * une phrase plutôt que de le laisser tomber dans le cas vide est ce qui évite
 * qu'un avis parte un jour en disant « a été annulé. » sans plus d'explication.
 *
 * ## La chaîne vide n'est pas un défaut, c'est une absence
 *
 * `null` — un rendez-vous qui n'est pas annulé, ce qui est le cas de tous ceux
 * que la confirmation et le rappel décrivent — rend `''`, ce que la grammaire
 * des sections sait lire : `{{#origine}}…{{/origine}}` s'efface entièrement. Un
 * texte de repli aurait fini par apparaître dans une confirmation.
 *
 * ## Chaque caractère est dans l'alphabet GSM-7
 *
 * `à`, `é` et `è` en font partie ; `ê`, `ô` et `ç` minuscule n'y sont pas, et un
 * seul d'entre eux ferait basculer l'avis d'annulation en UCS-2 — donc de 160
 * caractères à 70, donc au double de sa facture (notifications §5). C'est
 * pourquoi la formulation évite « à l'initiative du gérant » ou « suite à un
 * empêchement », et `notification-template.spec.ts` le vérifie plutôt que de
 * l'espérer.
 *
 * ## L'anglais, depuis #854
 *
 * Trois formulations de plus, et les mêmes contraintes : aucune ne s'adresse à
 * quelqu'un — « at the client's request » et non « at your request » —, aucune ne
 * sort de l'alphabet GSM-7, et l'absence reste la chaîne vide. Elles sont
 * **côte à côte** dans une table indexée par langue plutôt que dans deux
 * fonctions : c'est ce qui fait qu'une quatrième origine ajoutée à
 * `CANCELLATION_AUTHORS` ne compile pas tant qu'elle n'a pas ses deux phrases.
 */
const CANCELLATION_ORIGINS: Readonly<
  Record<Locale, Readonly<Record<AppointmentCancelledBy, string>>>
> = {
  fr: {
    CLIENT: 'à la demande du client',
    STAFF: "à l'initiative du salon",
    SYSTEM: 'automatiquement par le système',
  },
  en: {
    CLIENT: "at the client's request",
    STAFF: 'by the salon',
    SYSTEM: 'automatically by the system',
  },
};

export function cancellationOrigin(
  cancelledBy: AppointmentCancelledBy | null,
  locale: Locale,
): string {
  return cancelledBy === null ? '' : CANCELLATION_ORIGINS[locale][cancelledBy];
}

/**
 * Les valeurs des variables, pour ce rendez-vous et ce canal.
 *
 * ## Pourquoi le canal entre ici
 *
 * Pour une seule variable, et elle vaut le détour : `salon`. `tenants.name`
 * accepte 160 caractères, et une enseigne bavarde emporterait à elle seule deux
 * segments de SMS — c'est-à-dire la facture, et souvent la date du rendez-vous
 * avec. L'écourter au rendu plutôt qu'au stockage est ce qui permet à l'e-mail
 * de porter le nom entier pendant que le SMS porte sa version courte.
 *
 * Le reste est identique d'un canal à l'autre : un modèle de SMS qui nomme
 * `{{prix}}` obtient le même prix que l'e-mail.
 *
 * ## Les absences sont des chaînes vides, jamais `null`
 *
 * L'adresse et le téléphone sont nullables au schéma. Une chaîne vide est ce que
 * la grammaire des sections sait lire (`{{#adresse}}…{{/adresse}}` s'efface), là
 * où un `null` aurait obligé chaque substitution à s'en défendre — et aurait fini
 * par écrire « null » dans un e-mail le jour d'un oubli.
 *
 * ## Pourquoi le destinataire entre ici — #534
 *
 * Pour une seule variable, `destinataire_client`, et pour la même raison que le
 * canal : il n'y a **qu'un** modèle par `(tenant_id, type, channel)`, et l'avis
 * d'annulation part désormais vers deux comptes sur la même annulation. Ce qui
 * ne vaut que pour l'un des deux doit pouvoir s'effacer pour l'autre, et cela se
 * décide au rendu — le seul instant où le destinataire est connu.
 *
 * Le compte est comparé à `context.clientId`, jamais au rôle du compte : c'est
 * « es-tu la cliente **de ce rendez-vous** » qui est demandé, et une praticienne
 * qui a réservé pour elle-même y répond oui.
 *
 * ## Pourquoi la langue entre ici — #854
 *
 * Parce que trois variables se **formatent** au lieu d'être recopiées : `date`,
 * `heure` et `fin` passent par `Intl`, et `prix` aussi. Ce sont exactement celles
 * que le troisième critère d'acceptation nomme. Les autres sont des chaînes que
 * la base porte telles quelles — un nom de cliente, un nom de prestation — et
 * qu'aucune langue ne réécrit.
 *
 * `origine` s'y ajoute : elle n'est pas une donnée mais une **phrase**, composée
 * ici, et une phrase a une langue.
 *
 * La langue est **passée** et non déduite du contexte, et c'est le point du
 * ticket : elle est résolue au moment de l'expédition, sur le destinataire de ce
 * message-ci. Deux avis d'annulation du même rendez-vous — l'un vers une cliente
 * anglophone, l'autre vers un praticien francophone — traversent cette fonction
 * avec deux langues différentes.
 */
export function buildTemplateVariables(
  context: AppointmentMessageContext,
  cancelUrl: string,
  channel: NotificationChannel,
  recipientUserId: string,
  locale: Locale,
): TemplateVariables {
  const zone = context.tenantTimeZone;

  return {
    client: clientName(context),
    // Recopiée telle quelle : la référence est déjà sous sa forme émise en base
    // (#796). La reformater ici — ou pire, la recalculer — serait une seconde
    // définition de ce qu'est une référence, et c'est celle de l'e-mail qui
    // finirait par différer de celle de l'écran.
    reference: context.appointmentReference,
    service: context.serviceName,
    praticien: context.staffName,
    salon: channel === 'SMS' ? shortenForSms(context.tenantName) : context.tenantName,
    adresse: context.tenantAddress ?? '',
    telephone: context.tenantPhone ?? '',
    date: formatDateTimeInTenantTimeZone(context.startsAt, zone, locale),
    heure: formatTimeInTenantTimeZone(context.startsAt, zone, locale),
    fin: formatTimeInTenantTimeZone(context.endsAt, zone, locale),
    fuseau: zone,
    prix: formatMoney(context.priceAmountMinor, context.priceCurrency, locale),
    lien_annulation: cancelUrl,
    origine: cancellationOrigin(context.cancelledBy, locale),
    destinataire_client: recipientUserId === context.clientId ? 'oui' : '',
    // Vide sur les trois messages de rendez-vous, comme `origine` l'est sur la
    // confirmation et sur le rappel : un modèle qui la nommerait ici n'écrirait
    // rien plutôt qu'un lien mort, et elle reste donc utilisable en section.
    // Seule la réinitialisation la renseigne (`buildPasswordResetVariables`).
    lien_mot_de_passe: '',
  };
}

/** Le nom du salon, écourté pour un SMS — le reste du message est prioritaire. */
function shortenForSms(name: string): string {
  return name.length > SMS_TENANT_NAME_MAX
    ? `${name.slice(0, SMS_TENANT_NAME_MAX - 1)}…`
    : name;
}

// ---------------------------------------------------------------------------
// Le rendu de référence — ce qu'un modèle coûtera, avant tout envoi
// ---------------------------------------------------------------------------

/**
 * L'instant de référence : **mercredi 16 septembre 2026, 14 h 30** au fuseau
 * ci-dessous.
 *
 * Le jour et le mois ne sont pas pris au hasard — ce sont les plus longs des deux
 * langues. « mercredi » et « septembre » sont le nom de jour et le nom de mois
 * les plus longs du français ; « Wednesday » et « September » le sont de
 * l'anglais. Un quantième à deux chiffres complète le pire cas, puisque aucun mois
 * n'en a trois.
 *
 * C'est exactement l'instant qu'employait le littéral que #69 avait écrit : le
 * rendu français ne bouge donc pas d'un caractère, et les mesures documentées
 * dans `notification-default-templates.ts` restent celles de la suite.
 */
const REFERENCE_ZONE = 'Indian/Antananarivo';
const REFERENCE_START = new Date('2026-09-16T11:30:00Z');
const REFERENCE_END = new Date('2026-09-16T12:30:00Z');

/**
 * L'enseigne de référence — **quarante caractères**, soit exactement
 * `SMS_TENANT_NAME_MAX`.
 *
 * C'est le pire cas que le rendu laisse passer, et il est écrit comme une
 * enseigne réelle plutôt qu'en lettres répétées : la même valeur sert la mesure
 * d'un SMS et l'aperçu d'un modèle, et l'aperçu doit se lire.
 *
 * Tous ses caractères — `é` compris, qui est dans la table de base — valent un
 * septet en GSM-7. La borne est reprise à l'exécution plutôt que supposée, pour
 * qu'un changement de `SMS_TENANT_NAME_MAX` ne fasse pas mentir la mesure en
 * silence.
 */
const REFERENCE_TENANT_NAME = 'Institut de Beauté Maison Lotus de Paris';

function referenceTenantName(): string {
  return REFERENCE_TENANT_NAME.length >= SMS_TENANT_NAME_MAX
    ? REFERENCE_TENANT_NAME.slice(0, SMS_TENANT_NAME_MAX)
    : REFERENCE_TENANT_NAME.padEnd(SMS_TENANT_NAME_MAX, 'x');
}

/**
 * Les références déjà calculées, par langue.
 *
 * Elles ne dépendent que de la langue — l'instant, le fuseau et les libellés sont
 * des constantes de ce fichier —, et leur calcul construit cinq formateurs `Intl`,
 * ce qui est de loin la partie la plus coûteuse de la mesure d'un modèle.
 * `GET /notification-templates` en demande une par modèle de SMS, soit dix par
 * appel : les recalculer à chaque fois payait cinquante constructions `Intl` pour
 * deux résultats possibles.
 *
 * Le jeu rendu est **gelé** : il n'est qu'une source de substitution, aucun
 * appelant ne l'écrit, et le figer rend cet invariant vérifiable plutôt que
 * supposé.
 */
const REFERENCE_VARIABLES = new Map<Locale, TemplateVariables>();

/**
 * Un jeu de valeurs **de référence**, pour mesurer un modèle avant tout envoi.
 *
 * ## Pourquoi une référence, et non les valeurs réelles
 *
 * Parce qu'un modèle se valide au moment où le salon l'enregistre, c'est-à-dire
 * quand aucun rendez-vous n'est en jeu. Mesurer la chaîne brute — balises
 * comprises — aurait dit n'importe quoi : `{{date}}` fait huit caractères et en
 * rendra trente-quatre.
 *
 * ## Pourquoi ces valeurs-là
 *
 * Longues sans être absurdes. Prendre la largeur maximale de chaque colonne
 * (`services.name` en accepte 120, `tenants.name` 160) aurait fait refuser tous
 * les modèles, y compris ceux de la plateforme ; prendre des valeurs courtes
 * aurait laissé passer un modèle qui déborde au premier vrai rendez-vous. Ce
 * sont donc des valeurs plausiblement hautes : un nom composé, une prestation
 * nommée avec sa durée, un fuseau parmi les plus longs.
 *
 * `salon` est écrit à la largeur exacte à laquelle le rendu l'écourte
 * (`SMS_TENANT_NAME_MAX`), ce qui rend la mesure fidèle sans dépendre de
 * l'enseigne : c'est le pire cas réellement atteignable. C'est une **enseigne
 * plausible** de cette largeur-là, et non une répétition de la même lettre :
 * depuis #854 ces valeurs servent aussi à l'aperçu d'un modèle
 * (`NotificationTemplatesService.preview`), qui existe pour donner à lire la
 * phrase telle qu'elle partira. Un `SSSSSSSS…` de quarante lettres dans l'objet
 * d'un e-mail aurait rendu illisible le seul écran qui doit l'être. La mesure
 * n'en change pas d'un septet : chaque caractère du nom retenu est dans
 * l'alphabet GSM-7 de base, comme l'était la lettre répétée.
 *
 * ## Pourquoi une **fonction de la langue**, depuis #854
 *
 * Parce que quatre de ces valeurs sont formatées, et qu'elles ne font pas la même
 * longueur d'une langue à l'autre : « mercredi 16 septembre 2026 à 14:30 » fait
 * 34 caractères, « Wednesday, September 16, 2026 at 2:30 PM » en fait 40. Mesurer
 * un modèle anglais contre la référence française aurait donc **sous-estimé** son
 * coût de six caractères — de quoi annoncer un segment à un salon qui en paiera
 * deux.
 *
 * ## Pourquoi elles sont **calculées** et non écrites en dur
 *
 * Parce qu'une référence écrite à la main ment dès que le formatage change, et
 * qu'elle ment en silence : elle est la seule chose qui se mette entre un salon et
 * sa facture. Les faire passer par `formatDateTimeInTenantTimeZone` et
 * `formatMoney` — les fonctions mêmes du rendu — garantit que la mesure décrit ce
 * qui partira. Le littéral de #69 portait d'ailleurs déjà une inexactitude de ce
 * genre : il donnait deux décimales à l'ariary, que la CLDR n'en dote pas.
 *
 * ## Ce que la référence ne couvre toujours pas
 *
 * La longueur de `{{fuseau}}`, pour la raison qu'expose `BOOKING_CONFIRMATION_SMS` :
 * `Indian/Antananarivo` est « parmi les plus longs », pas le plus long. Et, en
 * anglais, l'heure de référence tombe l'après-midi (« 2:30 PM », sept
 * caractères) là où une heure entre minuit et une heure du matin en coûterait
 * huit (« 12:30 AM »). Un septet de marge, du même ordre que celui qui est déjà
 * assumé sur le fuseau.
 */
export function smsReferenceVariables(locale: Locale): TemplateVariables {
  const cached = REFERENCE_VARIABLES.get(locale);

  if (cached !== undefined) {
    return cached;
  }

  const variables = Object.freeze(buildReferenceVariables(locale));
  REFERENCE_VARIABLES.set(locale, variables);

  return variables;
}

function buildReferenceVariables(locale: Locale): TemplateVariables {
  return {
    client: 'Marie-Christine Rakotoarison',
    // Onze caractères, et c'est le pire cas : la référence est de largeur fixe
    // (`RDV-XXXX-NN`), donc la valeur mesurée est exactement celle que tout
    // rendez-vous produira. Tous ses caractères sont dans GSM-7.
    reference: 'RDV-8F3K-27',
    service: 'Massage suédois 60 minutes',
    praticien: 'Claire Delaunay',
    salon: referenceTenantName(),
    adresse: '12 rue des Lilas, 75011 Paris',
    telephone: '+33 1 23 45 67 89',
    date: formatDateTimeInTenantTimeZone(REFERENCE_START, REFERENCE_ZONE, locale),
    heure: formatTimeInTenantTimeZone(REFERENCE_START, REFERENCE_ZONE, locale),
    fin: formatTimeInTenantTimeZone(REFERENCE_END, REFERENCE_ZONE, locale),
    fuseau: REFERENCE_ZONE,
    // `Intl.NumberFormat` sépare les milliers par une espace fine insécable
    // (U+202F) en français et le symbole monétaire par une insécable (U+00A0)
    // dans les deux langues. **Aucune des deux n'est dans GSM-7**, et c'est
    // précisément ce que la mesure doit voir : un modèle de SMS qui nomme
    // `{{prix}}` part en UCS-2, donc à 70 caractères par segment.
    prix: formatMoney(125_000, 'MGA', locale),
    // Sur sous-domaine depuis #837, comme le lien que compose `cancellationUrl`.
    lien_annulation: 'https://maison-lotus.reservation.spa-booking.app/compte',
    // La plus longue des trois formulations que `cancellationOrigin` sait rendre
    // dans cette langue : mesurer la plus courte aurait annoncé un segment à un
    // salon dont l'avis d'annulation en coûte deux dès qu'une annulation vient
    // du système.
    origine: longestCancellationOrigin(locale),
    // Le pire cas, ici encore : une section ouverte coûte ce qu'elle contient, et
    // mesurer avec la variable vide aurait annoncé un segment à un salon dont le
    // SMS en coûte deux dès qu'il part vers une cliente.
    destinataire_client: 'oui',
    // Le plus long des deux chemins que `passwordResetUrl` sait composer — celui
    // du personnel, `/admin/mot-de-passe`, cinq caractères de plus que celui de
    // la clientèle. La plateforme n'envoie ce message que par e-mail, mais un
    // salon a le droit d'écrire son propre modèle de SMS, et c'est cette
    // mesure-là qui le refusera s'il dépasse.
    lien_mot_de_passe: 'https://maison-lotus.reservation.spa-booking.app/admin/mot-de-passe',
  };
}

/**
 * La plus longue des origines d'annulation de cette langue.
 *
 * Calculée plutôt que recopiée : c'est « automatiquement par le système » en
 * français et « automatically by the system » en anglais aujourd'hui, mais rien
 * ne garantit que la reformulation d'une phrase n'en fasse pas une autre demain —
 * et une référence qui aurait gardé l'ancienne sous-estimerait le coût sans que
 * rien ne le dise.
 */
function longestCancellationOrigin(locale: Locale): string {
  return Object.values(CANCELLATION_ORIGINS[locale]).reduce((longest, phrase) =>
    phrase.length > longest.length ? phrase : longest,
  );
}

/**
 * Ce qu'un modèle de SMS coûtera, une fois ses variables remplies, dans cette
 * langue.
 *
 * C'est cette mesure que la validation compare à `SMS_MAX_SEGMENTS`, et c'est
 * elle que l'API rend au back-office : un salon qui écrit « à très bientôt ! »
 * avec une apostrophe typographique doit **voir** que son message vient de passer
 * de un segment à deux.
 *
 * Elle vit ici depuis #854, et non plus dans `notification-template.ts` : elle a
 * désormais besoin des formateurs de ce fichier pour composer sa référence, et un
 * moteur de gabarits qui importerait le formatage des dates aurait formé un
 * cycle. La frontière reste la même qu'avant — `notification-template.ts` compte
 * les septets, il ne sait pas ce qu'est un rendez-vous.
 */
export function measureSmsTemplate(source: string, locale: Locale): SmsCost {
  return measureSms(renderTemplateSource(source, smsReferenceVariables(locale), keepAsIs));
}

/**
 * Rend un modèle en un message prêt à partir — le point de passage **unique**.
 *
 * Qu'il vienne de la base ou du code, un modèle passe par ici : c'est ce qui
 * garantit qu'un modèle personnalisé subit exactement le même échappement et la
 * même borne de longueur que celui de la plateforme. Deux chemins de rendu
 * auraient fini par diverger, et c'est toujours le chemin le moins relu qui perd
 * l'échappement.
 *
 * ## HTML échappé, texte non — et la raison n'est pas symétrique
 *
 * Le corps HTML échappe ses variables parce qu'un `<` y a un sens ; le corps
 * texte n'échappe rien parce qu'un `&amp;` y serait lu tel quel par la cliente.
 * L'objet, lui, n'est pas du HTML non plus : un client mail affiche le texte
 * brut de l'en-tête `Subject`, et l'échapper y ferait apparaître des `&#39;`.
 *
 * ## Le SMS ne porte ni objet ni HTML, quoi qu'en dise le modèle
 *
 * Y compris si un salon a rempli les deux champs : un expéditeur SNS ne lit que
 * `text`, et laisser passer du HTML ici ouvrirait la porte à une passerelle mal
 * branchée qui l'enverrait tel quel. Le plafond est appliqué en dernier rideau —
 * la validation du modèle a déjà mesuré un rendu de référence, mais rien ne
 * garantit qu'un nom réel soit plus court que la référence. Ce qu'il borne est le
 * nombre de **segments facturés**, pas un nombre de caractères : les deux ne se
 * déduisent pas l'un de l'autre, et couper un message GSM-7 à la longueur d'un
 * message UCS-2 lui aurait pris sa date sans rien économiser.
 */
export function renderNotification(
  source: NotificationTemplateSource,
  variables: TemplateVariables,
  channel: NotificationChannel,
): RenderedNotification {
  if (channel === 'SMS') {
    return {
      subject: '',
      html: '',
      text: capSmsBody(renderTemplateSource(source.text, variables, keepAsIs)),
    };
  }

  return {
    subject: renderTemplateSource(source.subject, variables, keepAsIs),
    html: renderTemplateSource(source.html, variables, escapeHtml),
    text: renderTemplateSource(source.text, variables, keepAsIs),
  };
}
