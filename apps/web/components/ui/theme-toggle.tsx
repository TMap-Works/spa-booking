'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { applyThemeChoice, readThemeChoice, type ThemeChoice } from '@/lib/theme';

import { Icon, type IconName } from './icon';

/**
 * Sélecteur de thème Système / Clair / Sombre (#855).
 *
 * Trois boutons radio natifs : le clavier (flèches) et l'annonce de l'état aux
 * lecteurs d'écran viennent du navigateur, sans ARIA à réinventer. Les libellés
 * sont écrits en clair pour les technologies d'assistance ; seul le
 * pictogramme est visible.
 */

/**
 * Les trois choix, dans l'ordre où ils s'affichent.
 *
 * La **clé** de message et non le libellé : la table est de portée module, donc
 * évaluée une fois pour toutes, alors qu'un libellé dépend de la langue de la
 * requête en cours. Le libellé se lit à l'intérieur du composant (#845).
 */
const OPTIONS: readonly {
  readonly value: ThemeChoice;
  readonly key: 'system' | 'light' | 'dark';
  readonly icon: IconName;
}[] = [
  { value: 'system', key: 'system', icon: 'monitor' },
  { value: 'light', key: 'light', icon: 'sun' },
  { value: 'dark', key: 'dark', icon: 'moon' },
];

interface ThemeToggleProps {
  readonly className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const t = useTranslations('ui.theme');
  const name = useId();
  const [choice, setChoice] = useState<ThemeChoice>('system');

  // Le serveur ne connaît pas le choix : l'état se recale sur `<html>`, déjà
  // posé par le script d'amorçage, dès l'hydratation.
  //
  // Puis il le **suit** : le parcours client monte deux sélecteurs par page —
  // l'en-tête au-delà de 48 rem, le pied de page en dessous (#1114) —, et un
  // choix fait dans l'un doit se voir dans l'autre quand la fenêtre franchit le
  // seuil. `<html>` est la seule source : chacun s'y abonne.
  useEffect(() => {
    const root = document.documentElement;
    const sync = (): void => {
      setChoice(readThemeChoice());
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
    };
  }, []);

  function choose(next: ThemeChoice): void {
    setChoice(next);
    applyThemeChoice(next);
  }

  return (
    <fieldset className={className === undefined ? 'spa-theme-toggle' : `spa-theme-toggle ${className}`}>
      <legend className="spa-visually-hidden">{t('legend')}</legend>
      {OPTIONS.map((option) => (
        <label className="spa-theme-toggle__option" key={option.value} title={t(option.key)}>
          <input
            checked={choice === option.value}
            className="spa-theme-toggle__input"
            name={name}
            onChange={() => choose(option.value)}
            type="radio"
            value={option.value}
          />
          <Icon className="spa-theme-toggle__icon" name={option.icon} />
          <span className="spa-visually-hidden">{t(option.key)}</span>
        </label>
      ))}
    </fieldset>
  );
}
