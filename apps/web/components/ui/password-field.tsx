'use client';

import { useState, type InputHTMLAttributes, type Ref } from 'react';

import { Icon } from '@/components/ui/icon';

interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id' | 'type'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * Champ de mot de passe (#1044) — le `Field` du design system, plus un bouton
 * pour afficher ce qu'on a tapé.
 *
 * WCAG 2.2, 3.3.8 (authentification accessible) : afficher le mot de passe et
 * autoriser le collage sont les deux techniques qui dispensent de retenir et
 * de retaper sans voir. Rien n'empêche donc le collage ici.
 *
 * Le bouton change de nom avec son effet (« Afficher le mot de passe » /
 * « Masquer le mot de passe »), à la manière du système de conception de
 * GOV.UK, et une région polie annonce l'état obtenu : un `aria-pressed` sur un
 * libellé qui change se contredirait.
 */
export function PasswordField({ id, label, hint, error, required = false, ref, ...input }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');

  return (
    <div className="spa-field spa-password">
      <label className="spa-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="spa-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <div className="spa-password__control">
        <input
          {...input}
          id={id}
          ref={ref}
          type={visible ? 'text' : 'password'}
          className="spa-field__control spa-password__input"
          required={required}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
        />
        <button
          type="button"
          className="spa-password__toggle"
          aria-controls={id}
          onClick={() => setVisible((current) => !current)}
        >
          <Icon name={visible ? 'eye-off' : 'eye'} />
          <span className="spa-password__toggle-label" aria-hidden="true">
            {visible ? 'Masquer' : 'Afficher'}
          </span>
          <span className="spa-visually-hidden">
            {visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
          </span>
        </button>
      </div>
      <p className="spa-visually-hidden" aria-live="polite">
        {visible ? 'Votre mot de passe est affiché.' : ''}
      </p>
      {hint === undefined ? null : (
        <p id={hintId} className="spa-field__hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="spa-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
