import type { InputHTMLAttributes, Ref } from 'react';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  /**
   * Message d'erreur **de ce champ**. Il s'affiche sous le contrôle, référencé
   * par `aria-describedby` : la skill `web-frontend` §4 proscrit le bloc
   * d'erreurs en haut de page, qui oblige à retrouver le champ soi-même.
   */
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * Champ de saisie du design system (styles/README.md §2).
 *
 * La couleur ne porte jamais l'information seule : l'état d'erreur pose
 * `aria-invalid`, **et** un texte en `role="alert"`.
 */
export function Field({ id, label, hint, error, required = false, ref, ...input }: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');

  return (
    <div className="spa-field">
      <label className="spa-field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="spa-field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      <input
        {...input}
        id={id}
        ref={ref}
        className="spa-field__control"
        required={required}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
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
