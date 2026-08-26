/*
 * Contraste — WCAG 2.2 niveau AA
 * =============================================================================
 *
 * Critère d'acceptation « Contraste AA vérifié » de l'issue #29. Vérifié par
 * exécution, pas à l'œil : les paires ci-dessous sont énoncées en jetons
 * sémantiques, résolues jusqu'aux primitives, et le rapport est recalculé à
 * chaque exécution.
 *
 * Ce que cela protège vraiment : la promesse faite aux salons qui substituent
 * leur rampe de marque (« toute rampe substituée doit conserver les rapports
 * vérifiés ici »). Un `--spa-palette-brand-500` trop clair fait rougir cette
 * suite, au lieu de livrer un bouton « Réserver » illisible.
 *
 *   Seuils normatifs
 *   ----------------
 *   1.4.3  texte normal .................... 4.5:1
 *   1.4.3  grand texte (≥ 24px, ou ≥ 18.66px gras) 3:1
 *   1.4.11 éléments non textuels ............ 3:1
 *
 * Exclusions assumées, chacune fondée sur une exemption explicite de la norme :
 *   · contrôles désactivés — 1.4.3 les exempte, et l'état est exposé aux
 *     technologies d'assistance par `disabled` / `aria-disabled` ;
 *   · squelettes de chargement — décoratifs, ne portent aucune information ;
 *     l'annonce passe par `aria-busy` et un texte en lecture d'écran ;
 *   · `--spa-color-scrim` — translucide, donc sans rapport de contraste défini
 *     tant qu'il n'est pas composé avec ce qu'il recouvre.
 *
 * Exécution : `node --test apps/web/tests/`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readTokenDeclarations, tokenContrast } from './support/tokens.mjs';

const declarations = readTokenDeclarations();

/** Seuil du texte normal. Aucun composant ne descend sous `--spa-font-size-sm`. */
const AA_TEXT = 4.5;
/** Seuil des éléments non textuels : bordures de contrôle, anneau de focus. */
const AA_NON_TEXT = 3;

/**
 * Statuts de rendez-vous du tableau de bord admin (#30).
 *
 * Leurs paires sont dérivées plutôt qu'écrites une à une : chaque statut se peint
 * exactement de la même façon — un badge dont le libellé est de la couleur du
 * statut sur sa propre surface, et un bloc de calendrier dont le liseré marque la
 * même couleur sur la surface blanche du planning, le texte du bloc restant
 * neutre. Trois vérifications, les mêmes pour tous. Les écrire à la main
 * inviterait à en oublier une au sixième statut.
 */
const APPOINTMENT_STATUSES = [
  'confirmed',
  'pending',
  'completed',
  'cancelled',
  'no-show',
];

const STATUS_PAIRS = APPOINTMENT_STATUSES.flatMap((status) => {
  const role = `--spa-color-status-${status}`;
  const surface = `${role}-surface`;
  return [
    [role, surface, AA_TEXT, `statut ${status} — libellé du badge / sa surface`],
    [
      role,
      '--spa-color-surface',
      AA_NON_TEXT,
      `statut ${status} — liseré du bloc / surface du planning`,
    ],
    [
      '--spa-color-text',
      surface,
      AA_TEXT,
      `statut ${status} — texte du bloc / sa surface`,
    ],
  ];
});

/**
 * Chaque entrée : [premier plan, arrière-plan, seuil, ce que l'on regarde].
 * Toute surface sur laquelle un rôle de texte peut atterrir figure ici — c'est
 * la liste qu'il faut allonger en ajoutant un composant, pas les seuils qu'il
 * faut baisser.
 */
const PAIRS = [
  // --- Texte sur les surfaces neutres ---
  ['--spa-color-text', '--spa-color-surface', AA_TEXT, 'texte / surface'],
  ['--spa-color-text', '--spa-color-surface-raised', AA_TEXT, 'texte / surface surélevée'],
  ['--spa-color-text', '--spa-color-surface-sunken', AA_TEXT, 'texte / surface creusée'],
  ['--spa-color-text-muted', '--spa-color-surface', AA_TEXT, 'texte atténué / surface'],
  ['--spa-color-text-muted', '--spa-color-surface-raised', AA_TEXT, 'texte atténué / surface surélevée'],
  ['--spa-color-text-muted', '--spa-color-surface-sunken', AA_TEXT, 'texte atténué / surface creusée'],
  // `text-subtle` est la teinte du texte de remplacement : c'est du texte, il
  // n'échappe pas au 4.5:1 sous prétexte qu'il est discret.
  ['--spa-color-text-subtle', '--spa-color-surface', AA_TEXT, 'texte discret / surface'],
  ['--spa-color-text-subtle', '--spa-color-surface-raised', AA_TEXT, 'texte discret / surface surélevée'],
  ['--spa-color-text-inverse', '--spa-color-surface-inverse', AA_TEXT, 'texte inversé / surface inversée'],
  // Barre latérale du tableau de bord admin : fond sombre au repos, fond sombre
  // surélevé pour l'élément de navigation courant ou survolé.
  ['--spa-color-text-inverse', '--spa-color-surface-inverse-raised', AA_TEXT, 'texte inversé / surface inversée surélevée'],
  ['--spa-color-text-inverse-muted', '--spa-color-surface-inverse', AA_TEXT, 'texte inversé atténué / surface inversée'],
  ['--spa-color-text-inverse-muted', '--spa-color-surface-inverse-raised', AA_TEXT, 'texte inversé atténué / surface inversée surélevée'],

  // --- Accent : les trois états du bouton « Réserver » ---
  ['--spa-color-text-on-accent', '--spa-color-accent', AA_TEXT, 'texte sur accent / accent au repos'],
  ['--spa-color-text-on-accent', '--spa-color-accent-hover', AA_TEXT, 'texte sur accent / accent au survol'],
  ['--spa-color-text-on-accent', '--spa-color-accent-active', AA_TEXT, 'texte sur accent / accent actif'],
  ['--spa-color-accent-text', '--spa-color-surface', AA_TEXT, 'lien d’accent / surface'],
  ['--spa-color-accent-text', '--spa-color-surface-raised', AA_TEXT, 'lien d’accent / surface surélevée'],
  // Carte sélectionnée et bouton discret au survol peignent tous deux sur `accent-soft`.
  ['--spa-color-accent-text', '--spa-color-accent-soft', AA_TEXT, 'lien d’accent / accent doux'],
  ['--spa-color-text', '--spa-color-accent-soft', AA_TEXT, 'texte / accent doux'],
  // Accent posé sur la barre latérale sombre — il y porte le libellé de
  // l'élément courant, il est donc soumis au seuil du texte et non à celui d'un
  // repère. C'est ce qui a écarté `--spa-color-accent`, qui n'y atteint que 3.09:1.
  ['--spa-color-accent-inverse', '--spa-color-surface-inverse', AA_TEXT, 'accent inversé / surface inversée'],
  ['--spa-color-accent-inverse', '--spa-color-surface-inverse-raised', AA_TEXT, 'accent inversé / surface inversée surélevée'],

  // --- États, sur surface neutre et sur leur propre surface ---
  ['--spa-color-success', '--spa-color-surface', AA_TEXT, 'succès / surface'],
  ['--spa-color-success', '--spa-color-success-surface', AA_TEXT, 'succès / surface de succès'],
  ['--spa-color-warning', '--spa-color-surface', AA_TEXT, 'avertissement / surface'],
  ['--spa-color-warning', '--spa-color-warning-surface', AA_TEXT, 'avertissement / surface d’avertissement'],
  ['--spa-color-danger', '--spa-color-surface', AA_TEXT, 'erreur / surface'],
  ['--spa-color-danger', '--spa-color-danger-surface', AA_TEXT, 'erreur / surface d’erreur'],
  ['--spa-color-info', '--spa-color-surface', AA_TEXT, 'information / surface'],
  ['--spa-color-info', '--spa-color-info-surface', AA_TEXT, 'information / surface d’information'],
  // Le corps d'une notification est du texte neutre posé sur la surface d'état.
  ['--spa-color-text', '--spa-color-success-surface', AA_TEXT, 'texte / surface de succès'],
  ['--spa-color-text', '--spa-color-warning-surface', AA_TEXT, 'texte / surface d’avertissement'],
  ['--spa-color-text', '--spa-color-danger-surface', AA_TEXT, 'texte / surface d’erreur'],
  ['--spa-color-text', '--spa-color-info-surface', AA_TEXT, 'texte / surface d’information'],
  // Bouton destructif plein : « Annuler le rendez-vous ».
  ['--spa-color-text-on-accent', '--spa-color-danger', AA_TEXT, 'texte sur accent / erreur pleine'],

  // --- Non textuel (1.4.11) ---
  ['--spa-color-border-interactive', '--spa-color-surface', AA_NON_TEXT, 'bordure de contrôle / surface'],
  ['--spa-color-border-interactive', '--spa-color-surface-raised', AA_NON_TEXT, 'bordure de contrôle / surface surélevée'],
  ['--spa-color-border-strong', '--spa-color-surface', AA_NON_TEXT, 'bordure appuyée / surface'],
  // L'anneau de focus est décalé (`outline-offset`) : il se dessine toujours sur
  // la surface de la page, jamais sur le contrôle. La paire à vérifier est donc
  // bien « focus / surface », y compris pour un bouton d'accent.
  ['--spa-color-focus', '--spa-color-surface', AA_NON_TEXT, 'anneau de focus / surface'],
  ['--spa-color-focus', '--spa-color-surface-raised', AA_NON_TEXT, 'anneau de focus / surface surélevée'],
  // Bordure de notification et aplat d'accent : des repères, pas du texte.
  ['--spa-color-accent', '--spa-color-surface', AA_NON_TEXT, 'accent plein / surface'],
  ['--spa-color-success', '--spa-color-success-surface', AA_NON_TEXT, 'bordure de succès / sa surface'],
  ['--spa-color-warning', '--spa-color-warning-surface', AA_NON_TEXT, 'bordure d’avertissement / sa surface'],
  ['--spa-color-danger', '--spa-color-danger-surface', AA_NON_TEXT, 'bordure d’erreur / sa surface'],
  ['--spa-color-info', '--spa-color-info-surface', AA_NON_TEXT, 'bordure d’information / sa surface'],
  // Le trait de l'heure courante dans le calendrier : un repère, pas du texte.
  ['--spa-color-now', '--spa-color-surface', AA_NON_TEXT, 'heure courante / surface du planning'],

  ...STATUS_PAIRS,
];

describe('Contraste AA des jetons de couleur', () => {
  for (const [foreground, background, minimum, label] of PAIRS) {
    it(`${label} atteint ${minimum}:1`, () => {
      const ratio = tokenContrast(declarations, foreground, background);
      assert.ok(
        ratio >= minimum,
        `${label} : ${ratio.toFixed(2)}:1, en deçà du minimum WCAG AA de ${minimum}:1 ` +
          `(${foreground} sur ${background}).`,
      );
    });
  }

  it('couvre chaque rôle de texte du système', () => {
    // Garde-fou contre l'oubli : un rôle de texte ajouté à tokens.css sans paire
    // correspondante ici passerait sinon inaperçu, et le critère « contraste AA
    // vérifié » deviendrait faux sans que rien ne rougisse.
    const verified = new Set(PAIRS.map(([foreground]) => foreground));
    const textRoles = [...declarations.keys()].filter(
      (name) =>
        name.startsWith('--spa-color-text') &&
        // `disabled-text` est exempté par 1.4.3, cf. en-tête.
        name !== '--spa-color-disabled-text',
    );

    for (const role of textRoles) {
      assert.ok(
        verified.has(role),
        `${role} n'est vérifié par aucune paire de contraste — ajouter la paire ` +
          `correspondante dans PAIRS, ou justifier son exemption dans l'en-tête.`,
      );
    }
  });

  it('couvre chaque statut de rendez-vous déclaré', () => {
    // Même garde-fou que ci-dessus, pour la famille de rôles ajoutée par #30 : un
    // sixième statut déclaré dans tokens.css et absent d'APPOINTMENT_STATUSES ne
    // serait vérifié par rien, et se peindrait au jugé.
    const declared = [...declarations.keys()]
      .filter(
        (name) =>
          name.startsWith('--spa-color-status-') && !name.endsWith('-surface'),
      )
      .map((name) => name.slice('--spa-color-status-'.length));

    assert.deepEqual(
      [...declared].sort(),
      [...APPOINTMENT_STATUSES].sort(),
      'les statuts déclarés dans tokens.css et ceux vérifiés ici ont divergé.',
    );

    for (const status of declared) {
      assert.ok(
        declarations.has(`--spa-color-status-${status}-surface`),
        `--spa-color-status-${status} n'a pas de surface associée : un badge de ` +
          `statut se peint toujours sur sa propre teinte, jamais sur du blanc.`,
      );
    }
  });
});
