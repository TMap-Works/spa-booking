import type { Ref, TextareaHTMLAttributes } from 'react';

interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'id'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  /**
   * Message d'erreur **de ce champ**, affiché sous le contrôle et référencé par
   * `aria-describedby` — jamais en bloc en haut de page (web-frontend §4).
   */
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Saisie multiligne — la description d'une prestation, une note interne.
 *
 * ## Pourquoi ce n'est pas un septième composant du design system
 *
 * Il ne déclare **aucun style** : il porte exactement les classes de
 * `.spa-field` (`styles/components/field.css`), qui ne sont pas liées à la
 * balise `<input>`. Un `<textarea>` y hérite du même cadre, du même anneau de
 * focus, du même traitement d'erreur — donc du même contraste, déjà vérifié par
 * `contrast.test.mjs`. Le dupliquer en CSS serait la seule façon de le faire
 * diverger.
 *
 * ## Pourquoi ne pas élargir `Field`
 *
 * Le type de son `ref` et de ses attributs est celui de `HTMLInputElement` :
 * l'union des deux forcerait chaque appelant à discriminer, pour un composant
 * qui ne se comporte pas autrement. Deux composants nets valent mieux qu'un
 * composant à drapeau.
 */
export function TextArea({
  id,
  label,
  hint,
  error,
  required = false,
  rows = 3,
  ref,
  ...textarea
}: TextAreaProps) {
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
      <textarea
        {...textarea}
        id={id}
        ref={ref}
        rows={rows}
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
