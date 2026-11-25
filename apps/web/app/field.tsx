import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

type FieldProps = {
  name: string;
  label: string;
  error?: string;
  hint?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "id">;

/** Labelled input with its error and hint wired up through aria-describedby. */
export function Field({ name, label, error, hint, ...input }: FieldProps) {
  const id = `field-${name}`;
  // Only ids that are rendered: the hint is hidden while an error shows.
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...input}
      />
      {hint && !error ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type DescribedProps = { name: string; label: string; error?: string; hint?: string };

/** The ids a field's description points at: only the ones rendered (the hint hides behind an error). */
function described(id: string, error?: string, hint?: string) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

function Messages({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return (
    <>
      {hint && !error ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Labelled textarea, wired like `Field`. */
export function TextAreaField({
  name,
  label,
  error,
  hint,
  ...textarea
}: DescribedProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "name" | "id">) {
  const id = `field-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, error, hint)}
        {...textarea}
      />
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

/** Labelled select, wired like `Field`. */
export function SelectField({
  name,
  label,
  error,
  hint,
  options,
  ...select
}: DescribedProps & {
  options: readonly { value: string; label: string }[];
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "name" | "id">) {
  const id = `field-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, error, hint)}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}
