import { LOCALES, type Locale } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { loadMessages, type MessageTree } from '@/i18n/messages';

/**
 * Le glossaire, tenu par un test — #1329.
 *
 * ## Pourquoi il en faut un
 *
 * Les catalogues étaient complets, typés, à parité de clés et sans
 * `MISSING_MESSAGE` : tout ce que l'outillage savait vérifier était vert, et
 * l'anglais restait britannique sur vingt-neuf « catalogue », trente et un
 * « cancelled » et quatre « cancelling », pendant que le même écran s'appelait
 * « Schedule », « planning », « calendar » ou « agenda » selon la page. Aucune de
 * ces divergences n'est une faute de code : ce sont des mots, et rien ne les
 * regardait.
 *
 * `messages/README.md` les fixe désormais. Ce fichier-ci est ce qui empêche le
 * glossaire de redevenir une intention : un ticket qui écrira « the catalogue »
 * dans un mois rougira ici, avec la forme attendue dans le message d'échec.
 *
 * ## Ce qu'il ne tient pas
 *
 * Il ne juge ni le ton, ni la longueur, ni la justesse d'une traduction — rien
 * qu'un test ne peut trancher sans devenir un dictionnaire. Il tient une liste
 * **fermée** de couples « forme refusée → forme retenue », tous relevés par la
 * recette de traduction du 2026-09-29, et deux règles de terminologie.
 *
 * Il ne regarde que les **valeurs**. Les clés sont des identifiants, et plusieurs
 * reprennent une valeur d'énumération du contrat partagé —
 * `appointment-status.json` porte `cancelled` et `no_show` parce que
 * `AppointmentStatus` les nomme ainsi.
 */

/** Les feuilles d'un catalogue, par clé aplatie. */
function leaves(tree: MessageTree, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();

  for (const [key, value] of Object.entries(tree)) {
    const full = prefix === '' ? key : `${prefix}.${key}`;

    if (typeof value === 'string') {
      entries.set(full, value);
    } else {
      for (const [nested, message] of leaves(value, full)) {
        entries.set(nested, message);
      }
    }
  }

  return entries;
}

interface Regle {
  /** La forme refusée, telle qu'on la cherche dans les valeurs. */
  readonly refuse: RegExp;
  /** Ce qu'il faut écrire à la place — c'est ce que l'échec affiche. */
  readonly retenu: string;
  /**
   * Les clés dispensées, avec la raison. Une dispense se justifie ou n'existe
   * pas : c'est ce qui empêche cette liste de servir de déversoir.
   */
  readonly sauf?: readonly string[];
}

/**
 * Le message débarrassé de ses **noms d'arguments** — `{slug}`, `{catalogue}`,
 * `{client}`.
 *
 * Ce sont des identifiants, pas du texte lu : `{catalogue}` nomme la variable que
 * le composant passe, et `/{slug}` affiche une adresse dont le mot « slug » ne
 * paraît jamais. Les juger comme de la prose aurait obligé à dispenser des clés
 * une à une, c'est-à-dire à percer le glossaire là où il ne l'est pas.
 *
 * Seuls les arguments **simples** disparaissent : `{count, plural, one {…}}` porte
 * une virgule, et le texte de ses branches reste soumis aux règles — c'est bien
 * de la prose, et c'est là que vivent la moitié des libellés du produit.
 */
function sansArguments(message: string): string {
  return message.replace(/\{\s*\w+\s*\}/g, ' ');
}

/** L'orthographe américaine — la seule du produit (`messages/README.md`). */
const ORTHOGRAPHE: readonly Regle[] = [
  // `cancellation` garde ses deux `l` en anglais américain : seules les formes
  // fléchies du verbe se simplifient. La borne `\b` ne suffit donc pas, il faut
  // exclure le substantif explicitement.
  { refuse: /\bcancell(?!ation)/i, retenu: 'canceled / canceling' },
  { refuse: /\bcatalogue\b/i, retenu: 'catalog' },
  { refuse: /\brecognis/i, retenu: 'recognized' },
  { refuse: /\bhonour/i, retenu: 'honor' },
  { refuse: /\bfavour/i, retenu: 'favor' },
  { refuse: /\btowards\b/i, retenu: 'toward' },
  { refuse: /\bwhilst\b/i, retenu: 'while' },
  { refuse: /\bamongst\b/i, retenu: 'among' },
  { refuse: /\blicence\b/i, retenu: 'license' },
  { refuse: /\bcolour/i, retenu: 'color' },
  { refuse: /\borganis/i, retenu: 'organize' },
  { refuse: /\bauthoris/i, retenu: 'authorize' },
  { refuse: /\bbehaviour/i, retenu: 'behavior' },
];

/** Le vocabulaire du métier, un mot par chose (`messages/README.md`). */
const VOCABULAIRE: Readonly<Record<Locale, readonly Regle[]>> = {
  en: [
    // « till » est la caisse en anglais britannique ; l'américain dit
    // « register ». La borne écarte « still » et « until ».
    { refuse: /\btill\b/i, retenu: 'register' },
    // La grille du salon s'appelle « schedule », et elle seule.
    { refuse: /\bagenda\b/i, retenu: 'schedule' },
    { refuse: /\bdiary\b/i, retenu: 'schedule' },
    { refuse: /\bplanning\b/i, retenu: 'schedule' },
    // « no-show » porte toujours son trait d'union.
    { refuse: /\bno shows?\b/i, retenu: 'no-show / no-shows' },
  ],
  fr: [
    // Le français a trois mots pour trois choses : le **planning** est la grille
    // du salon, le **calendrier** le sélecteur de date du tunnel, et l'**agenda**
    // celui de la cliente — d'où les deux dispenses, et elles seules.
    {
      refuse: /\bagenda\b/i,
      retenu: 'planning',
      sauf: ['appointments.addToCalendar', 'tunnel.confirmationStep.addToCalendar'],
    },
  ],
};

/** Le jargon d'implémentation ne s'affiche pas — dans aucune langue. */
const JARGON: readonly Regle[] = [
  { refuse: /\bslug\b/i, retenu: 'adresse / address' },
  { refuse: /\bMVP\b/, retenu: 'ce que la personne peut faire, pas l’état du produit' },
  { refuse: /front ?end/i, retenu: 'une phrase sans architecture dedans' },
  // « 0 fiche(s) trouvée(s) » : les pluriels passent par ICU.
  { refuse: /\(s\)/, retenu: 'un pluriel ICU — {count, plural, …}' },
];

/**
 * Les valeurs d'une langue, la clé du namespace comprise — c'est elle qui rend un
 * échec localisable, et elle que les dispenses désignent.
 */
function valeurs(locale: Locale): Map<string, string> {
  return leaves(loadMessages(locale));
}

/** `true` si la clé est dispensée de la règle. */
function dispensee(regle: Regle, cle: string): boolean {
  return (regle.sauf ?? []).some((exempt) => cle === exempt || cle.endsWith(`.${exempt}`));
}

function verifier(locale: Locale, regles: readonly Regle[]): void {
  const fautes: string[] = [];

  for (const [cle, message] of valeurs(locale)) {
    for (const regle of regles) {
      if (dispensee(regle, cle)) {
        continue;
      }

      const trouve = regle.refuse.exec(sansArguments(message));

      if (trouve !== null) {
        fautes.push(`${locale} · ${cle} : « ${trouve[0]} » → écrire « ${regle.retenu} »`);
      }
    }
  }

  expect(fautes, `écarts au glossaire (apps/web/messages/README.md) :\n${fautes.join('\n')}`).toEqual(
    [],
  );
}

describe('le glossaire des catalogues (#1329)', () => {
  it('n’écrit l’anglais qu’en orthographe américaine', () => {
    verifier('en', ORTHOGRAPHE);
  });

  for (const locale of LOCALES) {
    it(`nomme chaque chose d’un seul mot en « ${locale} »`, () => {
      verifier(locale, VOCABULAIRE[locale]);
    });

    it(`n’affiche aucun terme d’implémentation en « ${locale} »`, () => {
      verifier(locale, JARGON);
    });
  }
});
