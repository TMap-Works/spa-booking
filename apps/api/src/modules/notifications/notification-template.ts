/**
 * Le **moteur de modèles** — substitution de variables, échappement, et mesure
 * du coût d'un SMS. Des fonctions pures, sans Nest, sans Prisma, sans horloge.
 *
 * ## Pourquoi un moteur, et pourquoi celui-là
 *
 * #69 déplace les modèles du code vers la base : un salon doit pouvoir
 * personnaliser ses messages sans déploiement (notifications §6). Une chaîne
 * écrite par un salon n'est plus un littéral relu en revue — c'est une **entrée**,
 * et tout ce fichier découle de ce seul changement de statut.
 *
 * Aucune dépendance de rendu n'est ajoutée pour autant. Handlebars, EJS ou Nunjucks
 * savent tous évaluer des expressions dans le modèle, ce qui est exactement ce
 * qu'on ne veut pas : le contenu vient d'un utilisateur authentifié mais non
 * privilégié à l'échelle de la plateforme, et un moteur qui exécute du code
 * transforme un champ de formulaire en exécution côté serveur. La grammaire tient
 * donc en deux formes, et elles n'évaluent rien :
 *
 * | Forme | Ce qu'elle fait |
 * |---|---|
 * | `{{nom}}` | remplace par la valeur de la variable, échappée si le corps est du HTML |
 * | `{{#nom}}…{{/nom}}` | garde le fragment **si et seulement si** la variable est non vide |
 *
 * La section existe pour une raison précise et non pour la généralité : l'adresse
 * et le téléphone du salon sont nullables au schéma, et le modèle de confirmation
 * omettait déjà leurs lignes quand ils manquaient. Sans section, un salon sans
 * adresse recevrait une ligne « Adresse : » vide dans chaque message — une
 * régression visible sur un e-mail que la cliente garde.
 *
 * ## L'échappement est la raison d'être du fichier
 *
 * Troisième critère d'acceptation de #69, et le seul qui soit une faille et non
 * une gêne. Un nom de cliente est une chaîne libre de 80 caractères ; un nom de
 * prestation, de 120. Injectés tels quels dans un corps HTML, un `<` casse le
 * rendu et une balise complète y place ce qu'on veut — y compris un lien
 * d'hameçonnage dans un e-mail qui porte le nom du salon.
 *
 * L'échappement se fait donc **à la substitution**, pas au stockage : ce qui est
 * échappé est la *valeur*, jamais le modèle. Échapper le modèle aurait rendu
 * impossible d'y écrire du HTML, ce qui est tout son objet ; échapper à
 * l'écriture aurait laissé la valeur — la partie dangereuse — passer intacte.
 *
 * Le corps texte n'échappe **rien**, et c'est délibéré : un `&amp;` y serait lu
 * tel quel par la cliente. C'est la raison pour laquelle le rendu prend
 * l'échappeur en paramètre au lieu de le décider lui-même.
 */

/**
 * Les variables qu'un modèle peut nommer — deuxième critère d'acceptation de
 * #69, et la liste est **close**.
 *
 * Close parce qu'elle est la frontière : ce qui n'est pas ici n'est pas
 * substituable, donc pas exposable. Un modèle qui nomme une variable inconnue est
 * refusé à l'écriture plutôt que rendu à vide — sans quoi une faute de frappe
 * (`{{prenom}}` pour `{{client}}`) ne se découvrirait que dans l'e-mail d'une
 * cliente, une fois parti.
 *
 * Les noms sont en français et sans accent : ce sont ceux qu'une personne au
 * salon lit et recopie dans un champ de formulaire, et un `{{prénom}}` obligerait
 * à composer un accent dans un identifiant.
 *
 * `date` et `heure` sont rendues **dans le fuseau de l'établissement** — jamais en
 * UTC. C'est `buildTemplateVariables` qui l'applique, une fois, pour que le
 * modèle n'ait aucun moyen de demander autre chose.
 */
export const TEMPLATE_VARIABLES = [
  /** Nom d'usage de la cliente — « Amina Rakoto ». */
  'client',
  /** Nom de la prestation réservée. */
  'service',
  /** Nom d'affichage du praticien. */
  'praticien',
  /** Nom commercial de l'établissement. */
  'salon',
  /** Adresse postale du salon, sur une ligne. Vide si elle n'est pas renseignée. */
  'adresse',
  /** Téléphone de contact du salon. Vide s'il n'est pas renseigné. */
  'telephone',
  /** Date et heure de début, en toutes lettres, dans le fuseau du salon. */
  'date',
  /** Heure de début seule — « 14:30 », dans le fuseau du salon. */
  'heure',
  /** Heure de fin prévue du soin, dans le fuseau du salon. */
  'fin',
  /** Le fuseau IANA lui-même — « Europe/Paris ». Sans lui, « 14:30 » est ambigu. */
  'fuseau',
  /** Prix du rendez-vous, formaté avec sa devise. */
  'prix',
  /** Lien vers l'espace client, d'où la cliente annule ou déplace. */
  'lien_annulation',
  /**
   * D'où vient l'annulation, en toutes lettres — « à la demande du client », « à
   * l'initiative du salon » (#72, troisième critère d'acceptation).
   *
   * **Vide** sur un rendez-vous qui n'est pas annulé, donc sur la confirmation
   * et sur le rappel. C'est ce qui la rend utilisable en section
   * (`{{#origine}}…{{/origine}}`) : un modèle qui la nomme hors d'un avis
   * d'annulation n'écrit rien plutôt qu'une phrase fausse.
   *
   * La formulation est **neutre quant au destinataire**, et cela n'est pas un
   * détail de style : le même modèle sert la cliente et le praticien, et « à
   * votre demande » aurait été faux pour l'un des deux à chaque envoi.
   */
  'origine',
  /**
   * Le message part-il vers la **cliente** du rendez-vous ? — #534.
   *
   * ## Ce qu'elle vaut
   *
   * `oui` quand le compte destinataire est celui de la cliente, **vide** sinon —
   * c'est-à-dire quand l'avis d'annulation part vers le praticien.
   *
   * ## Elle est faite pour être lue en section
   *
   * `{{#destinataire_client}}…{{/destinataire_client}}` est son seul emploi
   * sensé, et c'est celui du modèle de plateforme. Écrite nue, elle rendrait
   * « oui » au milieu d'une phrase — ce qui n'est interdit à personne, mais
   * n'aide personne non plus.
   *
   * ## Pourquoi elle existe
   *
   * Parce que l'unique de `notification_templates` est `(tenant_id, type,
   * channel)` : il n'y a **qu'un** modèle d'avis d'annulation par canal, et
   * depuis #534 il sert deux destinataires sur la même annulation. Tout ce qui
   * ne vaut que pour l'un des deux — au premier chef le « Prendre un nouveau
   * rendez-vous » de l'e-mail, qui ne veut rien dire pour un praticien — doit
   * pouvoir s'effacer pour l'autre. Sans cette variable, la seule issue était de
   * retirer le lien à tout le monde, donc de dégrader le message de la
   * destinataire majoritaire.
   *
   * Elle vaut `oui` pour la confirmation et pour le rappel, qui ne s'adressent
   * qu'à la cliente : un modèle qui la nomme là s'y comporte comme si elle
   * n'était pas là.
   */
  'destinataire_client',
] as const;

export type TemplateVariableName = (typeof TEMPLATE_VARIABLES)[number];

/** Les valeurs des variables, déjà formatées — le modèle ne calcule rien. */
export type TemplateVariables = Readonly<Record<TemplateVariableName, string>>;

const KNOWN_VARIABLES: ReadonlySet<string> = new Set<string>(TEMPLATE_VARIABLES);

/**
 * Une section conditionnelle, du `{{#nom}}` à son `{{/nom}}`.
 *
 * Non gourmande, et non imbriquée : la référence arrière `\1` impose que la
 * balise fermante nomme la même variable que l'ouvrante, et le `?` fait que la
 * première fermeture ferme. Deux sections imbriquées sur la même variable ne se
 * comportent donc pas comme on l'espérerait — c'est assumé, et
 * `collectPlaceholders` n'ouvre de toute façon aucune grammaire plus riche.
 */
const SECTION_PATTERN = /\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

/** Une substitution simple. */
const VARIABLE_PATTERN = /\{\{([a-z_]+)\}\}/g;

/**
 * Toute balise, quelle que soit sa forme — sert au relevé de conformité.
 *
 * Le nom est `[^{}]*` et non `[a-z_]+`, délibérément : ce motif sert à **refuser**,
 * et il doit donc reconnaître tout ce que le rendu ne saura pas substituer. Un
 * `{{prénom}}` ou un `{{date2}}` que le relevé ne verrait pas ne serait ni refusé
 * à l'écriture, ni remplacé au rendu — il partirait tel quel dans l'e-mail d'une
 * cliente, ce qui est exactement le pire des deux mondes.
 */
const ANY_PLACEHOLDER_PATTERN = /\{\{([#/]?)([^{}]*)\}\}/g;

/**
 * Échappe les cinq caractères qui ont un sens en HTML.
 *
 * `&` en premier, impérativement : le traiter après aurait ré-échappé les
 * esperluettes que les autres remplacements viennent d'introduire, et `<` serait
 * sorti en `&amp;lt;`.
 *
 * Les apostrophes et les guillemets ne sont pas décoratifs dans cette liste :
 * `lien_annulation` est substitué dans un attribut `href="…"`, et un guillemet
 * non échappé y refermerait l'attribut.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** L'identité — l'« échappeur » du corps texte, où échapper serait illisible. */
export function keepAsIs(value: string): string {
  return value;
}

/**
 * Rend un modèle : sections d'abord, substitutions ensuite.
 *
 * L'ordre compte. Les sections se résolvent sur le **modèle**, dont le contenu
 * est connu ; les substitutions se font ensuite sur ce qui reste, si bien qu'une
 * valeur qui contiendrait `{{#client}}` n'ouvre aucune section — elle est déjà
 * passée au travers. C'est le seul point où un moteur naïf laisserait une donnée
 * d'utilisateur redevenir de la syntaxe.
 *
 * Une variable inconnue rend la chaîne vide plutôt que sa propre balise : le
 * refus a lieu à l'écriture (`unknownPlaceholders`), et laisser `{{prenom}}`
 * traverser jusqu'à l'e-mail serait le pire des deux mondes.
 *
 * @param escape `escapeHtml` pour un corps HTML, `keepAsIs` pour du texte brut.
 */
export function renderTemplateSource(
  source: string,
  variables: TemplateVariables,
  escape: (value: string) => string,
): string {
  const withSections = source.replaceAll(SECTION_PATTERN, (_match, name: string, body: string) =>
    valueOf(variables, name) === '' ? '' : body,
  );

  return withSections.replaceAll(VARIABLE_PATTERN, (_match, name: string) =>
    escape(valueOf(variables, name)),
  );
}

/** La valeur d'une variable, ou la chaîne vide si le nom n'en est pas une. */
function valueOf(variables: TemplateVariables, name: string): string {
  return KNOWN_VARIABLES.has(name) ? variables[name as TemplateVariableName] : '';
}

/**
 * Les noms de variables qu'un modèle emploie sans qu'ils existent.
 *
 * Rendus **triés et dédoublonnés**, parce que le message d'erreur les nomme : un
 * salon qui a écrit `{{prenom}}` trois fois doit lire « prenom » une fois, pas
 * trois.
 *
 * La casse compte, et c'est voulu : `{{Client}}` est refusé plutôt que toléré.
 * Accepter les deux formes obligerait le rendu à normaliser lui aussi, et une
 * normalisation qui diverge entre la validation et le rendu est exactement le
 * genre d'écart qui rend un modèle valide à l'écriture et vide à l'envoi.
 */
export function unknownPlaceholders(source: string): readonly string[] {
  const unknown = new Set<string>();

  for (const match of source.matchAll(ANY_PLACEHOLDER_PATTERN)) {
    const name = match[2] ?? '';
    if (!KNOWN_VARIABLES.has(name)) {
      unknown.add(name);
    }
  }

  return [...unknown].sort();
}

/**
 * Les sections ouvertes sans être refermées — ou refermées sans être ouvertes.
 *
 * Une section mal appariée n'est pas une faute bénigne : `{{#adresse}}` sans
 * `{{/adresse}}` traverse le rendu tel quel et part dans l'e-mail.
 *
 * Le compte ne suffit pas, et c'est le piège : `{{/adresse}}…{{#adresse}}` est à
 * l'équilibre sans être une section — la fermeture précède l'ouverture, aucune
 * des deux balises n'est reconnue par `SECTION_PATTERN`, et les deux partent
 * telles quelles. La profondeur est donc suivie dans l'ordre de lecture, et tout
 * passage sous zéro condamne le nom.
 */
export function unbalancedSections(source: string): readonly string[] {
  const depth = new Map<string, number>();
  const broken = new Set<string>();

  for (const match of source.matchAll(ANY_PLACEHOLDER_PATTERN)) {
    const marker = match[1] ?? '';
    const name = match[2] ?? '';

    if (marker === '#') {
      depth.set(name, (depth.get(name) ?? 0) + 1);
    } else if (marker === '/') {
      const balance = (depth.get(name) ?? 0) - 1;
      depth.set(name, balance);

      if (balance < 0) {
        broken.add(name);
      }
    }
  }

  for (const [name, balance] of depth) {
    if (balance !== 0) {
      broken.add(name);
    }
  }

  return [...broken].sort();
}

// ---------------------------------------------------------------------------
// Le coût d'un SMS — cinquième critère d'acceptation de #69
// ---------------------------------------------------------------------------

/**
 * L'alphabet **GSM 03.38 de base** : un caractère, sept bits.
 *
 * Recopié dans l'ordre de la norme, y compris ses curiosités : `£`, `¥`, `¤`, les
 * lettres grecques capitales qui n'ont pas d'homographe latin, et les seules
 * voyelles accentuées que la norme connaisse. C'est cette liste, et elle seule,
 * qui décide si un message tient en 160 caractères ou en 70.
 *
 * Ce qu'elle **ne contient pas** est le cœur du critère d'acceptation, parce que
 * le français en est plein : `ê î ô û ç` (la minuscule ; seule la capitale `Ç` y
 * est), l'apostrophe typographique `’`, le tiret cadratin `—`, les points de
 * suspension `…` et les guillemets `« »`. Chacun de ces caractères, seul, bascule
 * le message entier en UCS-2 et **double son coût** (notifications §5).
 *
 * Les sauts de ligne et le retour chariot en font partie et sont écrits en
 * échappement plutôt qu'en littéral, faute d'être visibles autrement.
 */
const GSM7_BASIC: ReadonlySet<string> = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
    '¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

/**
 * La **table d'extension** : un caractère, deux septets.
 *
 * Chacun est précédé d'un échappement `ESC` dans la trame, et compte donc
 * double. Le `€` en fait partie — un tarif écrit « 65 € » coûte un septet de plus
 * qu'il n'y paraît —, et le saut de page également, quoiqu'aucun modèle n'en
 * porte.
 */
const GSM7_EXTENDED: ReadonlySet<string> = new Set('^{}\\[~]|€\f');

/** Comment l'opérateur encodera ce message — donc ce qu'il coûtera. */
export type SmsEncoding = 'GSM_7' | 'UCS_2';

/**
 * Le coût d'un message, tel qu'il sera facturé.
 *
 * `units` est le nombre de **septets** en GSM-7 et d'**unités de code UTF-16** en
 * UCS-2 : deux mesures différentes, jamais comparables entre elles, et c'est
 * `encoding` qui dit laquelle on lit.
 */
export interface SmsCost {
  readonly encoding: SmsEncoding;
  readonly units: number;
  /** Nombre de SMS réellement facturés. C'est le seul chiffre qui coûte. */
  readonly segments: number;
}

/** Un SMS GSM-7 seul — 160 septets. */
const GSM7_SINGLE = 160;
/** Concaténé, l'en-tête de segmentation en mange sept. */
const GSM7_CONCATENATED = 153;

/**
 * Un SMS UCS-2 seul — 70 unités de code.
 *
 * Exporté : la borne est citée par les modèles et par leurs suites, et une
 * seconde définition en dur finirait par diverger de celle-ci.
 */
export const SMS_SINGLE_SEGMENT_UCS2 = 70;

/** Concaténé, 67 : le même en-tête, sur des unités deux fois plus larges. */
const UCS2_CONCATENATED = 67;

/**
 * Plafond de segments qu'un modèle a le droit de coûter.
 *
 * Trois, et le chiffre est un arbitrage de facture, pas de style : le SMS est
 * exclu de l'estimation budgétaire du CDC parce que son prix varie fortement par
 * pays (notifications §5). Un modèle qui en coûterait cinq multiplierait la
 * facture du salon par cinq à chaque rendez-vous, sans que personne ne s'en
 * aperçoive avant le relevé.
 */
export const SMS_MAX_SEGMENTS = 3;

/**
 * Budget d'un corps de SMS, dans l'unité de son encodage — `SMS_MAX_SEGMENTS`
 * segments **concaténés**.
 *
 * Ce ne sont pas des comptes de caractères, et c'est tout le point : trois
 * segments valent 459 septets en GSM-7 mais 201 unités en UCS-2. Une borne unique
 * en caractères aurait tronqué le premier bien avant sa facture et laissé passer
 * un quatrième segment au second.
 */
const GSM7_MAX_SEPTETS = GSM7_CONCATENATED * SMS_MAX_SEGMENTS;
const UCS2_MAX_UNITS = UCS2_CONCATENATED * SMS_MAX_SEGMENTS;

/**
 * Largeur laissée au nom de l'établissement dans un SMS.
 *
 * C'est **lui** qu'on écourte, et pas la fin du message. `tenants.name` accepte
 * 160 caractères : tronquer la phrase entière emporterait la date et l'heure —
 * c'est-à-dire la seule chose que ce SMS existe pour dire — et laisserait la
 * cliente avec un nom de salon suivi de rien. Écourter la signature coûte
 * quelques lettres à une enseigne bavarde ; écourter la queue coûte le
 * rendez-vous.
 */
export const SMS_TENANT_NAME_MAX = 40;

/**
 * Ce que ce texte coûtera en SMS.
 *
 * ## Ce qu'elle mesure exactement
 *
 * Le nombre de segments facturés, qui n'est pas le nombre de caractères et ne
 * s'en déduit pas linéairement : un message de 161 septets en coûte deux, un
 * message de 71 caractères accentués aussi — mais le second n'a que 71
 * caractères. C'est tout l'objet du critère d'acceptation.
 *
 * ## Ce qu'elle simplifie, et qui ne change pas le verdict
 *
 * Elle ne modélise ni le fait qu'un caractère d'extension GSM-7 ne peut pas être
 * coupé en travers d'une frontière de segment, ni qu'une paire de substitution
 * UTF-16 ne le peut pas davantage. Les deux cas ajoutent au plus un septet ou
 * une unité au segment précédent, ce qui ne fait basculer un compte qu'à la
 * frontière exacte — et le plafond de trois segments est posé bien avant.
 * Modéliser cela demanderait de simuler la trame, pour un modèle qu'un salon
 * réécrira de toute façon s'il coûte trop cher.
 */
export function measureSms(text: string): SmsCost {
  let septets = 0;
  let gsm7 = true;

  for (const character of text) {
    if (GSM7_BASIC.has(character)) {
      septets += 1;
    } else if (GSM7_EXTENDED.has(character)) {
      septets += 2;
    } else {
      gsm7 = false;
      break;
    }
  }

  if (gsm7) {
    return {
      encoding: 'GSM_7',
      units: septets,
      segments: segmentsFor(septets, GSM7_SINGLE, GSM7_CONCATENATED),
    };
  }

  // `length` est déjà un compte d'unités de code UTF-16, c'est-à-dire exactement
  // ce qu'UCS-2 transporte : un emoji hors du plan multilingue de base y compte
  // pour deux, ce qui est la vérité de la facture.
  return {
    encoding: 'UCS_2',
    units: text.length,
    segments: segmentsFor(text.length, SMS_SINGLE_SEGMENT_UCS2, UCS2_CONCATENATED),
  };
}

/**
 * Écourte un corps de SMS à `SMS_MAX_SEGMENTS` segments — le dernier rideau.
 *
 * Appliqué au **rendu**, après substitution : la validation du modèle mesure un
 * rendu de référence, et rien ne garantit qu'un nom réel soit plus court que la
 * référence. Ce qui est borné est donc la **facture**, jamais un nombre de
 * caractères — un message écrit en GSM-7 garde ses 459 septets là où une borne en
 * caractères l'aurait coupé au milieu de sa date sans rien économiser.
 *
 * La coupure ne laisse pas de demi-caractère : un caractère d'extension GSM-7
 * coûte ses deux septets ou n'entre pas, et une paire de substitution UTF-16
 * n'est pas scindée — un demi-emoji s'afficherait en caractère de remplacement.
 */
export function capSmsBody(text: string): string {
  const cost = measureSms(text);

  if (cost.segments <= SMS_MAX_SEGMENTS) {
    return text;
  }

  if (cost.encoding === 'UCS_2') {
    const cut = text.slice(0, UCS2_MAX_UNITS);
    const last = cut.charCodeAt(cut.length - 1);

    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  }

  let septets = 0;
  let end = 0;

  for (const character of text) {
    // En GSM-7, tout caractère est dans l'une des deux tables — `measureSms` le
    // garantit, faute de quoi l'encodage serait UCS-2.
    const width = GSM7_EXTENDED.has(character) ? 2 : 1;

    if (septets + width > GSM7_MAX_SEPTETS) {
      break;
    }

    septets += width;
    end += character.length;
  }

  return text.slice(0, end);
}

function segmentsFor(units: number, single: number, concatenated: number): number {
  if (units === 0) {
    // Un message vide part quand même : l'opérateur facture un segment.
    return 1;
  }

  return units <= single ? 1 : Math.ceil(units / concatenated);
}

/**
 * Un jeu de valeurs **de référence**, pour mesurer un modèle avant tout envoi.
 *
 * ## Pourquoi une référence, et non les valeurs réelles
 *
 * Parce qu'un modèle se valide au moment où le salon l'enregistre, c'est-à-dire
 * quand aucun rendez-vous n'est en jeu. Mesurer la chaîne brute — balises
 * comprises — aurait dit n'importe quoi : `{{date}}` fait huit caractères et en
 * rendra trente.
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
 * l'enseigne : c'est le pire cas réellement atteignable.
 *
 * ## Les espaces de `prix` ne sont pas des espaces
 *
 * `formatMoney` passe par `Intl.NumberFormat`, qui sépare les milliers par une
 * espace fine insécable (U+202F) et le symbole monétaire par une insécable
 * (U+00A0). **Aucune des deux n'est dans GSM-7.** Écrire ici des espaces
 * ordinaires aurait annoncé « GSM-7, un segment » à un salon dont le SMS part en
 * UCS-2 à deux segments — c'est-à-dire l'exact contraire de ce que la mesure
 * existe pour montrer.
 */
export const SMS_REFERENCE_VARIABLES: TemplateVariables = {
  client: 'Marie-Christine Rakotoarison',
  service: 'Massage suédois 60 minutes',
  praticien: 'Claire Delaunay',
  salon: 'S'.repeat(SMS_TENANT_NAME_MAX),
  adresse: '12 rue des Lilas, 75011 Paris',
  telephone: '+33 1 23 45 67 89',
  date: 'mercredi 16 septembre 2026 à 14:30',
  heure: '14:30',
  fin: '15:30',
  fuseau: 'Indian/Antananarivo',
  // Les deux espaces sont écrites en échappement : invisibles à l'œil dans le
  // fichier, ce sont pourtant elles qui décident de l'encodage.
  prix: '1\u202f250,00\u00a0MGA',
  lien_annulation: 'https://reservation.spa-booking.app/maison-lotus/compte',
  // La plus longue des trois formulations que `cancellationOrigin` sait rendre :
  // mesurer la plus courte aurait annoncé un segment à un salon dont l'avis
  // d'annulation en coûte deux dès qu'une annulation vient du système.
  origine: 'automatiquement par le système',
  // Le pire cas, ici encore : une section ouverte coûte ce qu'elle contient, et
  // mesurer avec la variable vide aurait annoncé un segment à un salon dont le
  // SMS en coûte deux dès qu'il part vers une cliente.
  destinataire_client: 'oui',
};

/**
 * Ce qu'un modèle de SMS coûtera, une fois ses variables remplies.
 *
 * C'est cette mesure que la validation compare à `SMS_MAX_SEGMENTS`, et c'est
 * elle que l'API rend au back-office : un salon qui écrit « à très bientôt ! »
 * avec une apostrophe typographique doit **voir** que son message vient de passer
 * de un segment à deux.
 */
export function measureSmsTemplate(source: string): SmsCost {
  return measureSms(renderTemplateSource(source, SMS_REFERENCE_VARIABLES, keepAsIs));
}
