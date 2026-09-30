import { LOCALES, validationPhrases, type Locale } from '@spa/shared';
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
 * Il ne regarde que les **valeurs** pour le vocabulaire. Les clés sont des
 * identifiants, et plusieurs reprennent une valeur d'énumération du contrat
 * partagé — `appointment-status.json` porte `cancelled` et `no_show` parce que
 * `AppointmentStatus` les nomme ainsi.
 *
 * ## Le registre, depuis #1357
 *
 * S'y ajoute une règle qui, elle, **part de la clé** : le registre des refus de
 * validation. `messages/README.md` veut qu'une phrase montrée à quelqu'un
 * commence par une capitale et finisse par un point, refus compris — et rien ne
 * le tenait, si bien que #1329 a repris trois namespaces et laissé les quatre
 * autres en fragments minuscules.
 *
 * La règle ne peut pas porter sur tout le catalogue : « Adresse e-mail », un
 * en-tête de colonne, une entrée de menu ne sont pas des phrases et n'en
 * prennent pas la ponctuation. Elle porte donc sur le sous-ensemble que
 * `messages/README.md` **nomme** — voir {@link estUnRefus}.
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

/**
 * Les blocs dont **toutes** les feuilles sont des refus de validation.
 *
 * C'est la forme que `messages/README.md` impose à tout refus ajouté désormais :
 * `form.errors.slugTooLong`, `login.fieldErrors.password`. Le nom du bloc suffit
 * alors à classer la feuille, sans liste à tenir — un refus neuf est tenu
 * d'office, le jour où il est écrit.
 *
 * Au singulier, `error` n'y est **pas** : `admin-auth.error.title` et
 * `booking.salon.error.title` sont des titres d'écran en erreur, pas des refus
 * de saisie.
 */
const BLOCS_DE_REFUS: ReadonlySet<string> = new Set(['errors', 'fieldErrors']);

/**
 * Les refus déclarés **hors** d'un bloc `errors` — le registre nommé.
 *
 * Ils précèdent la convention, et les ranger sous `errors` demanderait de
 * renommer leurs clés dans les composants qui les lisent : un autre diff que
 * celui-ci. La liste est **fermée**, et c'est ce qui la distingue d'une
 * dispense : elle n'exempte rien, elle **étend** la règle à des clés que leur
 * nom ne trahissait pas. Un refus neuf n'a pas à y être inscrit — il se range
 * sous `errors` et la règle le tient sans rien ajouter ici.
 */
const REFUS_HORS_BLOC: ReadonlySet<string> = new Set([
  // Le catalogue des prestations et ses rubriques.
  'admin-catalog.actions.invalidService',
  'admin-catalog.actions.invalidCategory',
  'admin-catalog.actions.chooseStaff',
  'admin-catalog.staffPanel.alreadyAssigned',
  'admin-catalog.categoryForm.slugTaken',
  // Le fichier client — coordonnées et recherche.
  'admin-clients.actions.invalidInput',
  'admin-clients.list.search.tooShort',
  'admin-clients.list.search.tooLong',
  // Les réglages de l'établissement — adresse postale et horaires d'ouverture.
  'admin-settings.address.countryFormat',
  'admin-settings.address.incomplete',
  'admin-settings.address.invalid',
  'admin-settings.hours.format',
  'admin-settings.hours.pair',
  'admin-settings.hours.order',
  'admin-settings.hours.emptyDay',
  'admin-settings.hours.invalid',
  // Le personnel — invitation, fiche praticien, semaine de travail, absences.
  'admin-staff.invite.phoneInvalid',
  'admin-staff.invite.invalid',
  'admin-staff.member.accountRequired',
  'admin-staff.member.invalid',
  'admin-staff.profile.invalid',
  'admin-staff.schedule.incomplete',
  'admin-staff.schedule.tooMany',
  'admin-staff.schedule.overlap',
  'admin-staff.schedule.endBeforeStart',
  'admin-staff.schedule.invalid',
  'admin-staff.timeOff.missingFrom',
  'admin-staff.timeOff.missingTo',
  'admin-staff.timeOff.rangeInvalid',
  'admin-staff.timeOff.invalid',
  'admin-staff.actions.invalid',
  'admin-staff.actions.invalidTimeOff',
  'admin-staff.actions.chooseRole',
  'admin-staff.actions.statusRequired',
  // Le consentement du tunnel, refus posé en phrase par #1329.
  'booking.tunnel.consent.error',
]);

/**
 * Un **titre** n'est pas une phrase : « Connexion refusée », « Formulaire
 * incomplet ». Il nomme l'écran ou le verdict, et ne prend pas de point final —
 * c'est déjà l'usage du dépôt sur `failureTitle`, `savedTitle`, `noticeTitle`.
 *
 * Il en vit sous les blocs de refus : `platform.login.errors.throttled.title`
 * coiffe le `body` qui, lui, est bien une phrase.
 */
function estUnTitre(cle: string): boolean {
  const feuille = cle.slice(cle.lastIndexOf('.') + 1);

  return feuille === 'title' || feuille.endsWith('Title');
}

/** `true` si cette clé désigne un refus de validation (`messages/README.md`). */
function estUnRefus(cle: string): boolean {
  if (estUnTitre(cle)) {
    return false;
  }

  if (REFUS_HORS_BLOC.has(cle)) {
    return true;
  }

  // Le dernier segment nomme la feuille ; les précédents nomment ses blocs.
  return cle
    .split('.')
    .slice(0, -1)
    .some((bloc) => BLOCS_DE_REFUS.has(bloc));
}

/** Ce qui clôt une phrase. `…` compte : « Patientez… » est close. */
const PONCTUATION_FINALE = /[.!?…]$/u;

/**
 * Le message ramené à ce que la ponctuation concerne.
 *
 * Deux retraits, et deux seulement :
 *
 * - les **balises riches** de next-intl — `<link>`, `<strong>` —, dont les
 *   chevrons masqueraient le point qui les précède ou les suit ;
 * - les **accolades fermantes de fin**, qui closent un `plural` ou un `select`
 *   dont la dernière branche, elle, porte bien sa ponctuation.
 */
function corpsDeLaPhrase(message: string): string {
  return message
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .trim()
    .replace(/\}+$/u, '')
    .trim();
}

/** L'ouverture de la phrase, guillemets et parenthèse d'entrée retirés. */
function ouvertureDeLaPhrase(corps: string): string {
  return corps.replace(/^[«“"'(\s]+/u, '');
}

/** Un message qui n'est **qu'un** `plural` ou un `select` — accolade en tête. */
const ICU_A_BRANCHES = /^\{\s*\w+\s*,\s*(?:plural|selectordinal|select)\s*,/u;

/**
 * Les branches d'un `plural` ou d'un `select`, une à une, ou rien.
 *
 * L'appariement des accolades, et non une expression régulière : une branche en
 * contient — `{count, plural, one {Une seule plage, {day}.} …}` —, et une
 * expression gourmande ou paresseuse se tromperait de fermante dans un cas comme
 * dans l'autre. Les branches imbriquées descendent d'un cran de plus.
 */
function branchesICU(message: string): readonly string[] {
  const corps = message.trim();

  if (!ICU_A_BRANCHES.test(corps) || !corps.endsWith('}')) {
    return [];
  }

  const interieur = corps.slice(1, -1);
  const branches: string[] = [];
  let profondeur = 0;
  let debut = -1;

  for (let index = 0; index < interieur.length; index += 1) {
    const caractere = interieur[index];

    if (caractere === '{') {
      if (profondeur === 0) {
        debut = index + 1;
      }

      profondeur += 1;
    } else if (caractere === '}') {
      profondeur -= 1;

      if (profondeur === 0 && debut >= 0) {
        branches.push(interieur.slice(debut, index));
        debut = -1;
      }
    }
  }

  return branches.flatMap((branche) => {
    const imbriquees = branchesICU(branche);

    return imbriquees.length === 0 ? [branche] : imbriquees;
  });
}

/**
 * Les phrases d'un message : une seule en général, **une par branche** quand le
 * message est un `plural` ou un `select`.
 *
 * Sans cette descente, un refus écrit `{count, plural, one {…} other {…}}`
 * échapperait à la règle de la capitale : son corps commence par une accolade,
 * jamais par une minuscule, et la règle le déclarerait juste sans l'avoir lu.
 * C'est déjà la position du glossaire sur le vocabulaire — voir
 * {@link sansArguments} : « le texte de ses branches reste soumis aux règles ».
 */
function phrasesDuMessage(message: string): readonly string[] {
  const branches = branchesICU(message);

  return branches.length === 0 ? [message] : branches;
}

/**
 * Ce qui cloche dans ce message — la liste vide quand il dit bien une phrase.
 *
 * Les motifs sont **dédoublonnés** : deux branches d'un même pluriel qui
 * oublient l'une et l'autre leur point n'ont qu'une faute à nommer.
 */
function fautesDePhrase(message: string): readonly string[] {
  const fautes = new Set<string>();

  for (const phrase of phrasesDuMessage(message)) {
    const corps = corpsDeLaPhrase(phrase);

    // `\p{Ll}` et non `[a-z]` : « état », « à partir de » sont minuscules eux
    // aussi. Un `{argument}`, un chiffre ou un acronyme ouvrent légitimement —
    // seule une **lettre minuscule** est une faute.
    if (/^\p{Ll}/u.test(ouvertureDeLaPhrase(corps))) {
      fautes.add('ne commence pas par une capitale');
    }

    if (!PONCTUATION_FINALE.test(corps)) {
      fautes.add('ne finit pas par un point');
    }
  }

  return [...fautes];
}

describe('le registre des refus de validation (#1357)', () => {
  for (const locale of LOCALES) {
    it(`dit chaque refus en une phrase en « ${locale} »`, () => {
      const fautes: string[] = [];
      let refus = 0;

      for (const [cle, message] of valeurs(locale)) {
        if (!estUnRefus(cle)) {
          continue;
        }

        refus += 1;

        for (const faute of fautesDePhrase(message)) {
          fautes.push(`${locale} · ${cle} : « ${message} » ${faute}`);
        }
      }

      // Une garde contre le pire échec possible : une règle qui ne juge plus
      // rien et reste verte. Le catalogue en porte plus de cent.
      expect(refus).toBeGreaterThan(100);

      expect(
        fautes,
        `refus de validation hors registre (apps/web/messages/README.md) :\n${fautes.join('\n')}`,
      ).toEqual([]);
    });
  }

  it('ne compte pour refus ni un libellé, ni un en-tête, ni un titre', () => {
    // Les trois formes que l'issue #1357 nommait comme le piège à éviter : une
    // règle appliquée à tout le catalogue aurait rougi sur elles.
    expect(estUnRefus('admin-staff.invite.email')).toBe(false);
    expect(estUnRefus('admin-staff.accounts.role')).toBe(false);
    expect(estUnRefus('shell.admin.rail.upcoming')).toBe(false);
    expect(estUnRefus('platform.login.errors.throttled.title')).toBe(false);
    expect(estUnRefus('admin-catalog.form.failureTitle')).toBe(false);

    // Et les deux formes qu'elle tient : le bloc nommé, et le registre.
    expect(estUnRefus('admin-catalog.form.errors.nameTooLong')).toBe(true);
    expect(estUnRefus('admin-staff.schedule.overlap')).toBe(true);

    // Le registre désigne des clés une à une : le voisin d'un refus inscrit
    // n'en devient pas un. `hours.timezone` est une mention sous le champ.
    expect(estUnRefus('admin-settings.hours.timezone')).toBe(false);
  });

  it('juge le texte des branches d’un pluriel, et non l’accolade qui l’ouvre', () => {
    // Une phrase simple, pour l'ancrage.
    expect(fautesDePhrase('Au plus {max} plages par semaine.')).toEqual([]);
    expect(fautesDePhrase('au plus {max} plages par semaine')).toEqual([
      'ne commence pas par une capitale',
      'ne finit pas par un point',
    ]);

    // Le message qui n'est **qu'un** pluriel : son corps ouvre sur une
    // accolade, et sans descente dans les branches la règle ne jugerait rien.
    expect(
      fautesDePhrase('{max, plural, one {Une seule plage est permise.} other {Au plus # plages.}}'),
    ).toEqual([]);
    expect(
      fautesDePhrase('{max, plural, one {une seule plage est permise.} other {au plus # plages.}}'),
    ).toEqual(['ne commence pas par une capitale']);
    expect(
      fautesDePhrase('{max, plural, one {Une seule plage est permise} other {Au plus # plages}}'),
    ).toEqual(['ne finit pas par un point']);

    // Une branche porte ses propres accolades : l'appariement les traverse sans
    // se tromper de fermante.
    expect(
      fautesDePhrase('{count, plural, one {Une plage le {day}.} other {# plages le {day}.}}'),
    ).toEqual([]);
  });

  it('n’inscrit au registre hors bloc que des clés qui existent', () => {
    const cles = new Set(valeurs('en').keys());
    const fantomes = [...REFUS_HORS_BLOC].filter((cle) => !cles.has(cle));

    expect(
      fantomes,
      `clés inscrites au registre mais absentes du catalogue :\n${fantomes.join('\n')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Un refus du contrat n'a qu'une source — #1373, élargi par #1376
// ---------------------------------------------------------------------------

/**
 * Les phrases de `validationPhrases(locale)` qui sont des **chaînes**, par nom.
 *
 * Lues au contrat et jamais recopiées ici : une reformulation du contrat ne fait
 * pas rougir la garde, elle la suit. Et lues **par énumération** plutôt que par
 * une liste de noms — `required`, `email`, `invalid`… — pour la raison qui vaut
 * déjà pour `messages-parity` : une phrase ajoutée au contrat est tenue le jour
 * où elle est écrite, sans qu'il faille revenir ici l'y inscrire.
 *
 * ## Pourquoi les phrases **paramétrées** en sont dehors
 *
 * `tooShort`, `tooLong`, `tooSmall`, `tooBig`, `tooFew`, `tooMany` prennent une
 * borne et rendent une phrase qui la porte — « Ne dépassez pas 2000
 * caractères. ». Un catalogue, lui, écrit la même chose avec un argument ICU —
 * « Ce champ fait au plus {max} caractères. » —, et les deux textes ne
 * s'égalisent pour aucune valeur de la borne : la comparaison littérale ne dirait
 * rien, ni dans un sens ni dans l'autre. C'est pourquoi le deuxième critère de
 * #1376 nomme les phrases **`string`**, et non toutes.
 *
 * Ce n'est pas un trou laissé par commodité : `messages/README.md` tranche que le
 * plafond de longueur **reste** au catalogue — « ce sont deux formulations
 * différentes d'une même règle, pas une copie ». Il n'y a donc rien à y
 * surveiller, et la garde qu'il faut sur ces phrases-là est celle d'un test de
 * rendu, qui montre laquelle des deux arrive sous le champ
 * (`refus-de-saisie-vient-du-contrat.test.tsx`).
 */
function phrasesFixesDuContrat(locale: Locale): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(validationPhrases(locale)).filter(
      (entree): entree is [string, string] => typeof entree[1] === 'string',
    ),
  );
}

/**
 * Les copies d'une phrase du contrat que la garde laisse encore passer.
 *
 * **Elle est vide, et c'est l'état attendu** — troisième critère de #1376. Elle
 * ne l'a pas toujours été : #1373 y avait nommé
 * `booking.tunnel.contactStep.errors.required`, le temps qu'un ticket vienne
 * reprendre le tunnel public, qu'il ne nommait pas. Le cas
 * « ne garde de dispense que pour une copie qui existe encore » a forcé la main
 * au bon moment : reprendre le tunnel a fait rougir ce cas-là, et la dispense
 * s'en est allée du même geste que ce qu'elle dispensait.
 *
 * Ce qui la garde vide est le régime, et non la chance : un écran qui aurait
 * besoin d'y inscrire une clé est un écran qui redit une phrase que
 * `zodErrorMap(locale)` sait déjà dire — le remède est de laisser la carte
 * répondre, jamais d'allonger cette liste.
 */
const COPIES_DE_PHRASES_TOLEREES: ReadonlySet<string> = new Set<string>();

describe('un refus du contrat n’a qu’une source (#1373, #1376)', () => {
  /**
   * `validationPhrases(locale)` décide seule de ce qui s'affiche sous un champ
   * que le contrat refuse — la décision et sa raison sont écrites dans
   * `messages/README.md` et dans `zod-messages.ts`.
   *
   * Ce que ce cas empêche est précis : qu'un catalogue **redise** une de ces
   * phrases. Neuf clés le faisaient — trois reprises par #1373, six par #1376 —,
   * sans que rien ne relie les deux sources ; le jour où l'une des deux bougeait,
   * le même champ disait deux phrases selon que le refus venait du schéma partagé
   * ou du formulaire. Et ce jour-là était déjà venu sans que rien ne le signale :
   * les quatre clés d'adresse e-mail étaient identiques au contrat en anglais et
   * en divergeaient en français, « valide » contre « valable ».
   */
  for (const locale of LOCALES) {
    it(`n’en laisse aucune copie au catalogue en « ${locale} »`, () => {
      const contrat = phrasesFixesDuContrat(locale);
      const copies: string[] = [];

      for (const [cle, message] of valeurs(locale)) {
        if (COPIES_DE_PHRASES_TOLEREES.has(cle)) {
          continue;
        }

        for (const [nom, phrase] of contrat) {
          if (message === phrase) {
            copies.push(`${cle} redit validationPhrases(${locale}).${nom} — « ${phrase} »`);
          }
        }
      }

      // Une garde contre le pire échec possible : une règle qui ne juge plus
      // rien et reste verte. Le contrat en porte dix.
      expect(contrat.size).toBeGreaterThanOrEqual(10);

      expect(
        copies,
        'clés qui redisent une phrase que le contrat porte déjà — laisser ' +
          `zodErrorMap(${locale}) répondre et retirer la clé (voir messages/README.md) :\n` +
          copies.join('\n'),
      ).toEqual([]);
    });
  }

  it('ne garde de dispense que pour une copie qui existe encore', () => {
    const survivantes: string[] = [];

    for (const locale of LOCALES) {
      const catalogue = valeurs(locale);
      const phrases = new Set(phrasesFixesDuContrat(locale).values());

      for (const cle of COPIES_DE_PHRASES_TOLEREES) {
        const message = catalogue.get(cle);

        if (message === undefined || !phrases.has(message)) {
          survivantes.push(`${locale} · ${cle}`);
        }
      }
    }

    expect(
      survivantes,
      'dispenses devenues inutiles — la copie a été reprise, retirer la clé ' +
        `de COPIES_DE_PHRASES_TOLEREES :\n${survivantes.join('\n')}`,
    ).toEqual([]);
  });
});
