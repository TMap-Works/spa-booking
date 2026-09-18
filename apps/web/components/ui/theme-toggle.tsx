'use client';

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

const OPTIONS: readonly { readonly value: ThemeChoice; readonly label: string; readonly icon: IconName }[] = [
  { value: 'system', label: 'Thème du système', icon: 'monitor' },
  { value: 'light', label: 'Thème clair', icon: 'sun' },
  { value: 'dark', label: 'Thème sombre', icon: 'moon' },
];

interface ThemeToggleProps {
  readonly className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const name = useId();
  const [choice, setChoice] = useState<ThemeChoice>('system');

  // Le serveur ne connaît pas le choix : l'état se recale sur `<html>`, déjà
  // posé par le script d'amorçage, dès l'hydratation.
  useEffect(() => {
    setChoice(readThemeChoice());
  }, []);

  function choose(next: ThemeChoice): void {
    setChoice(next);
    applyThemeChoice(next);
  }

  return (
    <fieldset className={className === undefined ? 'spa-theme-toggle' : `spa-theme-toggle ${className}`}>
      <legend className="spa-visually-hidden">Thème d’affichage</legend>
      {OPTIONS.map((option) => (
        <label className="spa-theme-toggle__option" key={option.value} title={option.label}>
          <input
            checked={choice === option.value}
            className="spa-theme-toggle__input"
            name={name}
            onChange={() => choose(option.value)}
            type="radio"
            value={option.value}
          />
          <Icon className="spa-theme-toggle__icon" name={option.icon} />
          <span className="spa-visually-hidden">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
