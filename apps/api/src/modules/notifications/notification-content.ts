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
 */
export function cancellationUrl(appBaseUrl: string, tenantSlug: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(tenantSlug)}/compte`;
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
