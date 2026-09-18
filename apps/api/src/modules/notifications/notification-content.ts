import { tenantPublicUrl, type TenantUrlMode } from '@spa/shared';

import {
  SMS_TENANT_NAME_MAX,
  capSmsBody,
  escapeHtml,
  keepAsIs,
  renderTemplateSource,
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

/** Locale unique du produit, comme `apps/web/lib/format.ts`. */
const LOCALE = 'fr-FR';

/**
 * « lundi 8 septembre 2026 à 14:30 » — l'instant, dans le fuseau du salon.
 *
 * `hourCycle: 'h23'` fixe l'horloge sur 24 h : le français l'attend, et le
 * défaut de la locale a changé d'une version d'ICU à l'autre. `formatToParts`
 * n'est pas nécessaire ici — c'est une chaîne pour un humain — mais le séparateur
 * est composé à la main plutôt que laissé à `dateStyle: 'full'` + `timeStyle`,
 * dont le mot de liaison varie lui aussi selon la version d'ICU.
 */
export function formatDateTimeInTenantTimeZone(instant: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);

  return `${date} à ${formatTimeInTenantTimeZone(instant, timeZone)}`;
}

/** « 14:30 » — l'heure seule, dans le fuseau du salon. */
export function formatTimeInTenantTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/**
 * Un montant, à partir de son entier en plus petite unité.
 *
 * La division par 100 se fait **dans le formateur**, via `minimumFractionDigits`
 * appliqué à un quotient calculé une seule fois : la valeur ne circule jamais
 * comme flottant dans le domaine, elle n'est convertie que pour être écrite.
 * `Intl.NumberFormat` connaît le nombre de décimales de chaque devise, ce qu'une
 * division en dur par 100 ignorerait — le yen n'en a aucune.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat(LOCALE, { style: 'currency', currency });
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
 */
export function cancellationOrigin(cancelledBy: AppointmentCancelledBy | null): string {
  switch (cancelledBy) {
    case 'CLIENT':
      return 'à la demande du client';
    case 'STAFF':
      return "à l'initiative du salon";
    case 'SYSTEM':
      return 'automatiquement par le système';
    default:
      return '';
  }
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
 */
export function buildTemplateVariables(
  context: AppointmentMessageContext,
  cancelUrl: string,
  channel: NotificationChannel,
  recipientUserId: string,
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
    date: formatDateTimeInTenantTimeZone(context.startsAt, zone),
    heure: formatTimeInTenantTimeZone(context.startsAt, zone),
    fin: formatTimeInTenantTimeZone(context.endsAt, zone),
    fuseau: zone,
    prix: formatMoney(context.priceAmountMinor, context.priceCurrency),
    lien_annulation: cancelUrl,
    origine: cancellationOrigin(context.cancelledBy),
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
