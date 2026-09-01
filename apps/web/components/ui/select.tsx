import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'id'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  /** Message affiché à la place de la liste quand elle est chargée et vide. */
  readonly emptyLabel?: string | undefined;
  readonly ref?: Ref<HTMLSelectElement>;
  readonly children: ReactNode;
}

/**
 * Sélecteur du design system, bâti sur un `<select>` natif (styles/README.md §2).
 *
 * Le natif est un choix, pas un raccourci : navigation clavier, recherche par
 * frappe et rendu tactile de la plateforme viennent avec, et c'est le contrôle
 * le plus souvent raté en accessibilité.
 *
 * « Ça charge » et « il n'y a rien » ne sont pas le même écran : `emptyLabel`
 * dit *pourquoi* la liste est vide au lieu de laisser un sélecteur muet.
 */
export function Select({
  id,
  label,
  hint,
  error,
  emptyLabel,
  ref,
  children,
  ...select
}: SelectProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');
  const empty = emptyLabel !== undefined;

  return (
    <div className={empty ? 'spa-select spa-select--empty' : 'spa-select'}>
      <label className="spa-select__label" htmlFor={id}>
        {label}
      </label>
      <div className="spa-select__shell">
        <select
          {...select}
          id={id}
          ref={ref}
          className="spa-select__control"
          disabled={select.disabled === true || empty}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === '' ? undefined : describedBy}
        >
          {children}
        </select>
        <span className="spa-select__chevron" aria-hidden="true" />
      </div>
      {empty ? <p className="spa-select__empty">{emptyLabel}</p> : null}
      {hint === undefined ? null : (
        <p id={hintId} className="spa-select__hint">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="spa-select__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
