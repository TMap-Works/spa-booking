import type { AppointmentMessageContext, RenderedNotification } from './notifications.types';

/**
 * Les modèles de message — **fonctions pures**, sans Nest, sans Prisma, sans
 * horloge.
 *
 * ## Pourquoi ce fichier ne dépend de rien
 *
 * Trois des cinq critères d'acceptation de #70 se prouvent ici et nulle part
 * ailleurs : le récapitulatif, le lien d'annulation, et l'heure affichée dans le
 * fuseau du salon. Les mettre dans un service injectable aurait obligé chaque
 * assertion à monter un module Nest pour vérifier une chaîne de caractères. Ce
 * sont des fonctions de `(contexte) → texte`, et leurs tests le sont aussi.
 *
 * ## Le fuseau du salon, et pourquoi `Intl` plutôt que `TenantClockService`
 *
 * CLAUDE.md est explicite : « tout est stocké en UTC, converti à l'affichage
 * selon le fuseau du tenant », et « un rendez-vous mal fuseau-horairé est un bug
 * de sévérité haute ». Un e-mail est un affichage, et le pire de tous — il
 * survit à l'écran, et la cliente s'y fie des jours plus tard.
 *
 * `TenantClockService` sait convertir, mais son `formatInTenantTime` rend un ISO
 * 8601 à décalage explicite (`2026-09-08T14:30:00+03:00`), destiné aux
 * contrats, pas à une lectrice. Il aurait fallu importer `AvailabilityModule`
 * dans `notifications` — donc coupler la chaîne de messages au moteur de
 * disponibilité — pour ensuite ne pas se servir du résultat. `Intl` est dans la
 * bibliothèque standard, c'est déjà ce qu'emploie `apps/web/lib/format.ts` pour
 * le même besoin, et le fuseau est validé à l'écriture côté `tenants.timezone`.
 *
 * ## L'échappement n'est pas une précaution de style
 *
 * Un nom de cliente est une chaîne libre de 80 caractères. Sans échappement, un
 * `<` suffit à casser le rendu du message, et une balise complète à y injecter
 * ce qu'on veut (notifications §6). Toutes les variables passent donc par
 * `escapeHtml` dans le corps HTML — et **aucune** dans le corps texte, où
 * échapper produirait des `&amp;` visibles.
 */

/** Locale unique du produit, comme `apps/web/lib/format.ts`. */
const LOCALE = 'fr-FR';

/**
 * Longueur au-delà de laquelle un SMS coûte un second segment.
 *
 * 160 caractères en GSM-7, mais nos modèles français portent des accents, ce qui
 * bascule le message en UCS-2 et le limite à **70** (notifications §5). Le
 * modèle est écrit pour tenir sous cette borne dans les cas courants ; la
 * constante existe pour que le test le vérifie plutôt que de l'espérer, et la
 * troncature protège des noms d'établissement démesurés.
 */
export const SMS_SINGLE_SEGMENT_UCS2 = 70;

/**
 * Plafond dur d'un SMS, tous segments confondus.
 *
 * Trois segments UCS-2 concaténés. Au-delà, l'opérateur découpe et facture sans
 * rien apprendre de plus à la cliente : la confirmation détaillée est dans
 * l'e-mail, le SMS n'en est que l'avis.
 */
const SMS_MAX_LENGTH = 201;

/**
 * Largeur laissée au nom de l'établissement dans un SMS.
 *
 * C'est **lui** qu'on écourte, et pas la fin du message. `tenants.name` accepte
 * 160 caractères : tronquer la phrase entière à `SMS_MAX_LENGTH` emporterait
 * alors la date et l'heure — c'est-à-dire la seule chose que ce SMS existe pour
 * dire — et laisserait la cliente avec un nom de salon suivi de rien. Écourter
 * la signature coûte quelques lettres à une enseigne bavarde ; écourter la
 * queue coûte le rendez-vous.
 */
const SMS_TENANT_NAME_MAX = 40;

/**
 * Échappe les cinq caractères qui ont un sens en HTML.
 *
 * `&` en premier, impérativement : le traiter après aurait ré-échappé les
 * esperluettes que les autres remplacements viennent d'introduire, et
 * `<` serait sorti en `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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
 * Le lien d'annulation — troisième critère d'acceptation de #70.
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
 * ## Ce qu'il ne fait pas, et pourquoi c'est délibéré
 *
 * Il ne porte **aucun jeton d'annulation**. Composer une URL signée qui annule
 * en un clic aurait ajouté un secret à faire tourner, une durée de validité à
 * choisir, et une route publique de plus — pour un gain nul sur ce ticket,
 * puisque l'espace client existe déjà et authentifie. Un lien d'annulation
 * directe est une décision de conception à part entière ; elle appartient à son
 * issue, pas à une ligne de modèle.
 *
 * Il n'encode pas non plus l'identifiant du rendez-vous dans un chemin qui
 * n'existe pas : la page `/{slug}/compte` liste les rendez-vous à venir, et
 * inventer `/compte/rendez-vous/{id}` produirait un 404 dans un e-mail — la
 * pire des impressions.
 */
export function cancellationUrl(appBaseUrl: string, tenantSlug: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(tenantSlug)}/compte`;
}

/** Le nom d'usage de la cliente, tel qu'un message l'emploie. */
function clientName(context: AppointmentMessageContext): string {
  return `${context.clientFirstName} ${context.clientLastName}`.trim();
}

/** Les lignes du récapitulatif, dans l'ordre où on les lit. */
function summaryRows(context: AppointmentMessageContext): readonly (readonly [string, string])[] {
  const zone = context.tenantTimeZone;

  const rows: (readonly [string, string])[] = [
    ['Prestation', context.serviceName],
    ['Avec', context.staffName],
    ['Date', formatDateTimeInTenantTimeZone(context.startsAt, zone)],
    ['Fin prévue', formatTimeInTenantTimeZone(context.endsAt, zone)],
    ['Prix', formatMoney(context.priceAmountMinor, context.priceCurrency)],
  ];

  if (context.tenantAddress !== null) {
    rows.push(['Adresse', context.tenantAddress]);
  }

  if (context.tenantPhone !== null) {
    rows.push(['Téléphone', context.tenantPhone]);
  }

  return rows;
}

/**
 * L'e-mail de confirmation : objet, HTML et texte brut du même message.
 *
 * L'heure est **toujours** suivie de son fuseau. Sans mention, « 14:30 » est
 * ambigu pour une cliente qui voyage, et c'est précisément l'ambiguïté que
 * CLAUDE.md classe en sévérité haute.
 */
export function renderBookingConfirmationEmail(
  context: AppointmentMessageContext,
  cancelUrl: string,
): RenderedNotification {
  const rows = summaryRows(context);
  const zone = context.tenantTimeZone;
  const when = formatDateTimeInTenantTimeZone(context.startsAt, zone);

  const subject = `Votre rendez-vous du ${when} est confirmé — ${context.tenantName}`;

  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    `<p>Bonjour ${escapeHtml(clientName(context))},</p>`,
    `<p>Votre rendez-vous chez ${escapeHtml(context.tenantName)} est confirmé.</p>`,
    `<table role="presentation">${htmlRows}</table>`,
    `<p>Les horaires sont donnés à l’heure de ${escapeHtml(zone)}.</p>`,
    `<p><a href="${escapeHtml(cancelUrl)}">Modifier ou annuler mon rendez-vous</a></p>`,
    `<p>À bientôt,<br />${escapeHtml(context.tenantName)}</p>`,
    '</body></html>',
  ].join('');

  const text = [
    `Bonjour ${clientName(context)},`,
    '',
    `Votre rendez-vous chez ${context.tenantName} est confirmé.`,
    '',
    ...rows.map(([label, value]) => `${label} : ${value}`),
    '',
    `Les horaires sont donnés à l’heure de ${zone}.`,
    '',
    `Modifier ou annuler mon rendez-vous : ${cancelUrl}`,
    '',
    `À bientôt,`,
    context.tenantName,
  ].join('\n');

  return { subject, html, text };
}

/**
 * L'e-mail de rappel J-1 — le message que #71 met en circulation.
 *
 * ## Ce qu'il partage avec la confirmation, et ce qui l'en distingue
 *
 * Le récapitulatif est le même, et c'est voulu : une cliente qui reçoit un
 * rappel ne doit pas avoir à retrouver la confirmation pour savoir avec qui, où
 * et pour combien. Ce qui change est **ce que le message affirme** — la
 * confirmation dit « c'est enregistré », le rappel dit « c'est demain, et voici
 * comment vous décommander si vous ne pouvez pas ». Ce second membre de phrase
 * est la raison d'être du message : le CDC §1.4 le tient pour la mesure qui
 * réduit le taux de no-show, et une annulation la veille libère un créneau que
 * le salon peut encore vendre.
 *
 * ## Il ne dit pas « demain »
 *
 * Le rappel part entre 24 et 25 heures avant le rendez-vous, ce qui tombe
 * presque toujours la veille dans le calendrier du salon — mais « presque
 * toujours » n'est pas une garantie qu'un modèle a le droit de prendre : un
 * changement d'heure, ou un rendez-vous au tout début de la fenêtre, suffirait à
 * rendre le mot faux. La date complète, dans le fuseau de l'établissement, est
 * toujours juste et ne coûte rien de plus à lire.
 */
export function renderReminderEmail(
  context: AppointmentMessageContext,
  cancelUrl: string,
): RenderedNotification {
  const rows = summaryRows(context);
  const zone = context.tenantTimeZone;
  const when = formatDateTimeInTenantTimeZone(context.startsAt, zone);

  const subject = `Rappel : votre rendez-vous du ${when} — ${context.tenantName}`;

  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="fr"><body>',
    `<p>Bonjour ${escapeHtml(clientName(context))},</p>`,
    `<p>Nous vous attendons chez ${escapeHtml(context.tenantName)} le ${escapeHtml(when)}.</p>`,
    `<table role="presentation">${htmlRows}</table>`,
    `<p>Les horaires sont donnés à l’heure de ${escapeHtml(zone)}.</p>`,
    `<p>Un empêchement ? <a href="${escapeHtml(cancelUrl)}">Annulez ou déplacez votre rendez-vous</a> — ` +
      'cela libère le créneau pour quelqu’un d’autre.</p>',
    `<p>À très bientôt,<br />${escapeHtml(context.tenantName)}</p>`,
    '</body></html>',
  ].join('');

  const text = [
    `Bonjour ${clientName(context)},`,
    '',
    `Nous vous attendons chez ${context.tenantName} le ${when}.`,
    '',
    ...rows.map(([label, value]) => `${label} : ${value}`),
    '',
    `Les horaires sont donnés à l’heure de ${zone}.`,
    '',
    `Un empêchement ? Annulez ou déplacez votre rendez-vous : ${cancelUrl}`,
    '',
    `À très bientôt,`,
    context.tenantName,
  ].join('\n');

  return { subject, html, text };
}

/**
 * Le SMS de rappel — l'avis, et rien d'autre.
 *
 * Même économie que le SMS de confirmation : le détail et le lien d'annulation
 * sont dans l'e-mail, qui part toujours. Le SMS existe pour être lu sur un écran
 * verrouillé, et un rappel qu'on ne lit pas ne réduit aucun no-show.
 */
export function renderReminderSms(context: AppointmentMessageContext): RenderedNotification {
  const zone = context.tenantTimeZone;
  const name =
    context.tenantName.length > SMS_TENANT_NAME_MAX
      ? `${context.tenantName.slice(0, SMS_TENANT_NAME_MAX - 1)}…`
      : context.tenantName;
  const text =
    `${name} : rappel de votre rendez-vous le ` +
    `${formatDateTimeInTenantTimeZone(context.startsAt, zone)} (${zone}).`;

  return { subject: '', html: '', text: text.slice(0, SMS_MAX_LENGTH) };
}

/**
 * Le SMS de confirmation — le même fait, en une phrase.
 *
 * Il ne reprend pas le récapitulatif complet : un SMS n'est pas un e-mail
 * raccourci, c'est un avis. Le détail et le lien d'annulation sont dans
 * l'e-mail, qui part toujours (notifications §6).
 *
 * `subject` et `html` sont renseignés pour que le type reste unique d'un canal à
 * l'autre — un expéditeur SMS ne lit que `text`. Les laisser vides plutôt que de
 * dupliquer le corps évite qu'une passerelle mal branchée envoie du HTML par
 * SNS.
 */
export function renderBookingConfirmationSms(
  context: AppointmentMessageContext,
): RenderedNotification {
  const zone = context.tenantTimeZone;
  const name =
    context.tenantName.length > SMS_TENANT_NAME_MAX
      ? `${context.tenantName.slice(0, SMS_TENANT_NAME_MAX - 1)}…`
      : context.tenantName;
  const text =
    `${name} : rendez-vous confirmé le ` +
    `${formatDateTimeInTenantTimeZone(context.startsAt, zone)} (${zone}).`;

  // Le plafond dur reste, en second rideau : un fuseau IANA est court, mais
  // rien dans ce fichier ne le garantit.
  return { subject: '', html: '', text: text.slice(0, SMS_MAX_LENGTH) };
}
