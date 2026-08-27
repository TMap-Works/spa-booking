/**
 * Bornes du contrat : longueurs de champs, pagination, politique de mot de passe.
 *
 * Les longueurs reprennent **exactement** les largeurs déclarées dans
 * `apps/api/prisma/schema.prisma`. Ce n'est pas de la duplication décorative :
 * une borne front plus large que la colonne produit un 500 sur un `VARCHAR` trop
 * court là où l'utilisateur attendait un message de champ. Les deux se corrigent
 * ensemble, et ce fichier est l'endroit où le front les lit.
 */

/** `VARCHAR(320)` — longueur maximale d'une adresse e-mail (RFC 5321). */
export const EMAIL_MAX_LENGTH = 320;

/** `VARCHAR(32)` — numéro de téléphone, format libre à ce stade du MVP. */
export const PHONE_MAX_LENGTH = 32;

/** `VARCHAR(80)` — prénom, nom, catégorie. */
export const NAME_MAX_LENGTH = 80;

/** `VARCHAR(160)` — nom d'établissement, de prestation, nom public de praticien. */
export const DISPLAY_NAME_MAX_LENGTH = 160;

/**
 * `VARCHAR(63)` — slug de tenant, borné par la longueur d'un label DNS.
 *
 * Le slug de prestation s'y aligne alors que sa colonne accepte 80 caractères
 * (`services.slug`) : la borne la plus étroite est celle qui tient, et un slug
 * de prestation est destiné à une URL au même titre que celui d'un
 * établissement. Le sens du décalage compte — une borne **plus étroite** que la
 * colonne refuse proprement en 422, une borne plus large produit un 500 sur un
 * `VARCHAR` trop court.
 */
export const SLUG_MAX_LENGTH = 63;

/** `VARCHAR(2000)` — description de prestation, biographie, note de rendez-vous. */
export const LONG_TEXT_MAX_LENGTH = 2000;

/** `VARCHAR(500)` — motif d'annulation, cause d'échec d'envoi. */
export const REASON_MAX_LENGTH = 500;

/** `VARCHAR(64)` — identifiant de fuseau IANA. */
export const TIMEZONE_MAX_LENGTH = 64;

/**
 * Politique de mot de passe (#21).
 *
 * Le plancher est une **longueur**, pas une composition : imposer majuscule +
 * chiffre + caractère spécial produit des mots de passe plus courts et plus
 * prévisibles, pour un gain d'entropie nul. Le plafond n'est pas une contrainte
 * de sécurité mais une borne de coût : sans lui, une chaîne de plusieurs
 * mégaoctets soumise à argon2id est un déni de service à une requête.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Pagination : valeur par défaut et plafond dur, appliqués côté serveur. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Fenêtre maximale d'une requête de disponibilité, en jours.
 *
 * Le calcul des créneaux se fait à la demande (booking-engine §3) : une plage
 * non bornée fait exploser le temps de réponse et le cache. Trente et un jours
 * couvrent le « mois suivant » du calendrier public.
 */
export const MAX_AVAILABILITY_RANGE_DAYS = 31;

/**
 * Pas de découpage des créneaux proposés, en minutes (#34).
 *
 * `tenants.slot_interval_minutes` porte la valeur, ces trois constantes portent
 * ses bornes — les **mêmes** que la contrainte
 * `tenants_slot_interval_minutes_check`. Comme les longueurs de champs plus
 * haut, ce n'est pas de la duplication décorative : un écran de réglages qui
 * accepterait ce que la base refuse produirait un 500 là où l'utilisateur
 * attendait un message de champ.
 *
 * La borne basse n'est pas une préférence d'ergonomie : un pas nul ou négatif
 * fait **boucler indéfiniment** le découpage d'une fenêtre de travail, puisque
 * le curseur n'avance plus. La borne haute est une borne de faute de frappe — un
 * pas d'une journée entière ne propose qu'un créneau par jour, au-delà la valeur
 * ne veut plus rien dire.
 */
export const DEFAULT_SLOT_INTERVAL_MINUTES = 15;
export const MIN_SLOT_INTERVAL_MINUTES = 1;
export const MAX_SLOT_INTERVAL_MINUTES = 1440;

/**
 * Délai minimum entre l'instant présent et le début d'un créneau proposable, en
 * minutes (#34).
 *
 * Sans lui, la page publique propose un créneau qui commence dans deux minutes :
 * le praticien n'a pas vu passer la réservation, et personne n'accueille la
 * cliente. `0` est licite — c'est le salon qui accepte le passage immédiat —, et
 * le filtre « créneaux dans le passé » reste alors actif de lui-même,
 * `maintenant + 0` valant `maintenant`.
 *
 * La borne haute vaut trente jours. Au-delà, le préavis vide l'agenda du mois
 * entier sans qu'aucune erreur ne le signale : le moteur cesse simplement de
 * rendre des créneaux, ce qui est exactement le mode de défaillance qu'une borne
 * de faute de frappe existe pour rendre impossible.
 */
export const DEFAULT_MIN_BOOKING_NOTICE_MINUTES = 60;
export const MIN_BOOKING_NOTICE_MINUTES_FLOOR = 0;
export const MAX_MIN_BOOKING_NOTICE_MINUTES = 43_200;

/**
 * Fenêtre maximale d'une plage bloquée ou d'un congé, en jours — et la même
 * borne pour la fenêtre qu'en interroge le planning de back-office (#33).
 *
 * Elle ne protège d'aucun abus : c'est une **borne de faute de frappe**. Une
 * absence saisie au 20 **2**6 au lieu de 2026 blanchirait l'agenda du praticien
 * pour deux siècles, et rien ne le signalerait — le moteur de créneaux ne rendrait
 * plus aucune disponibilité, sans erreur, sans trace, jusqu'à ce que quelqu'un
 * remonte à la ligne fautive.
 *
 * Une année et un jour couvre le congé sabbatique comme le planning annuel, tout
 * en rendant la faute de frappe impossible à confondre avec une saisie légitime.
 * Au-delà, l'absence se pose en deux lignes — le moteur les fusionne.
 */
export const MAX_TIME_OFF_RANGE_DAYS = 366;
